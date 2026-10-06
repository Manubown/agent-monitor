import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseClaudeCode } from "../src/adapters/claude-code";
import { parseCodex } from "../src/adapters/codex";
import type { Env } from "../src/core/adapter";
import { DEFAULT_PRICES } from "../src/core/pricing";
import { syncAll } from "../src/ingest/sync";
import { type Db, openDb } from "../src/store/db";
import { getSession, overview } from "../src/store/queries";

/**
 * Tools copy earlier requests into new log files: Claude Code forks (/branch,
 * --fork-session) and resumes, Codex forks and subagents spawned with their
 * parent's history. Each request must be counted once across all sessions.
 */

const jsonl = (lines: object[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join("");

// --- Claude Code ------------------------------------------------------------

/** One API response written as one line per content block, as Claude Code does. */
function reply(sessionId: string, msgId: string, requestId: string, ts: string, input: number, output: number) {
  const usage = { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  return [
    { type: "assistant", sessionId, requestId, uuid: `${msgId}-a`, timestamp: ts, cwd: "/work/p", message: { id: msgId, model: "claude-sonnet-5-5", role: "assistant", content: [{ type: "text", text: `reply ${msgId}` }], usage } },
    { type: "assistant", sessionId, requestId, uuid: `${msgId}-b`, timestamp: ts, cwd: "/work/p", message: { id: msgId, model: "claude-sonnet-5-5", role: "assistant", content: [{ type: "tool_use", id: `tool-${msgId}`, name: "Read", input: {} }], usage } },
  ];
}
const prompt = (sessionId: string, text: string, ts: string) => ({ type: "user", sessionId, uuid: `u-${ts}`, timestamp: ts, cwd: "/work/p", message: { role: "user", content: text } });

const ORIGINAL = [
  prompt("orig", "build it", "2026-10-02T10:00:00.000Z"),
  ...reply("orig", "msg_1", "req_1", "2026-10-02T10:00:05.000Z", 100, 10),
  ...reply("orig", "msg_2", "req_2", "2026-10-02T10:00:09.000Z", 200, 20),
];

/** What Claude Code's /branch writes: the original's lines under the new session id, each marked `forkedFrom`, then the fork's own turns. */
const FORK = [
  ...ORIGINAL.map((l) => ({ ...l, sessionId: "fork", forkedFrom: { sessionId: "orig", messageUuid: l.uuid } })),
  prompt("fork", "now try another way", "2026-10-02T11:00:00.000Z"),
  ...reply("fork", "msg_3", "req_3", "2026-10-02T11:00:04.000Z", 300, 30),
];

/** Older Claude Code resumes copied the history without any marker. */
const RESUMED = [...ORIGINAL.map((l) => ({ ...l, sessionId: "resumed" })), ...reply("resumed", "msg_4", "req_4", "2026-10-02T12:00:00.000Z", 400, 40)];

// --- Codex ------------------------------------------------------------------

const meta = (id: string, ts: string, extra: object = {}) => ({ timestamp: ts, type: "session_meta", payload: { id, timestamp: ts, cwd: "/work/p", cli_version: "0.160.0", ...extra } });
const turn = (ts: string) => ({ timestamp: ts, type: "turn_context", payload: { cwd: "/work/p", model: "gpt-5-codex" } });
const said = (ts: string, text: string) => ({ timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const tokens = (ts: string, input: number, cached: number, output: number, primaryUsed: number) => ({
  timestamp: ts,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } },
    rate_limits: { primary: { used_percent: primaryUsed, window_minutes: 300, resets_at: 1790000000 } },
  },
});

const PARENT_ID = "11111111-1111-7111-8111-111111111111";
const CHILD_ID = "22222222-2222-7222-8222-222222222222";

/** The parent's lines, as a fork replays them. */
const parentBody = (at: (s: string) => string) => [
  turn(at("12:00:01")),
  said(at("12:00:02"), "Run the tests"),
  tokens(at("12:00:03"), 5000, 0, 300, 1),
  tokens(at("12:00:04"), 11000, 4800, 350, 2),
];
const PARENT = [meta(PARENT_ID, "2026-10-01T12:00:00.000Z"), ...parentBody((t) => `2026-10-01T${t}.000Z`)];
/** codex-rs persists the copied items with fresh timestamps and seeds the child's running total from them. */
const CHILD = [
  meta(CHILD_ID, "2026-10-01T13:00:00.000Z", { forked_from_id: PARENT_ID }),
  { ...PARENT[0], timestamp: "2026-10-01T13:00:00.001Z" },
  ...parentBody(() => "2026-10-01T13:00:00.002Z"),
  turn("2026-10-01T13:00:01.000Z"),
  said("2026-10-01T13:00:02.000Z", "Now fix them"),
  tokens("2026-10-01T13:00:05.000Z", 20000, 10000, 500, 3),
];

// --- helpers ----------------------------------------------------------------

interface Ctx {
  db: Db;
  env: Env;
  root: string;
}

function setup(): Ctx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-monitor-dedup-"));
  const env = {
    HOME: root,
    AGENT_MONITOR_OMP_DIRS: path.join(root, "omp"),
    AGENT_MONITOR_CLAUDE_CODE_DIRS: path.join(root, "claude"),
    AGENT_MONITOR_CODEX_DIRS: path.join(root, "codex"),
  };
  return { db: openDb(":memory:"), env, root };
}

function put(ctx: Ctx, rel: string, lines: object[]) {
  const file = path.join(ctx.root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jsonl(lines));
}

const CLAUDE_TOTAL = { requests: 3, input: 600, output: 60 };

describe("usage copied across log files is counted once", () => {
  let ctx: Ctx;
  const sync = (db = ctx.db) => syncAll(db, { env: ctx.env, prices: DEFAULT_PRICES });
  const requests = (db: Db, id: string) => getSession(db, id)?.session.requests;

  beforeEach(() => {
    ctx = setup();
  });

  it("parses a Claude Code fork with request ids, dated from its first own line", () => {
    const fork = parseClaudeCode("/p/fork.jsonl", jsonl(FORK))!;
    expect(fork.nativeId).toBe("fork");
    expect(fork.usage.map((u) => u.requestId)).toEqual(["msg_1:req_1", "msg_2:req_2", "msg_3:req_3"]);
    expect(fork.startedAt).toBe(Date.parse("2026-10-02T11:00:00.000Z"));
    // The copied history stays on the fork's timeline.
    expect(fork.events.filter((e) => e.kind === "assistant")).toHaveLength(3);
  });

  it("counts a Claude Code fork's copied requests in the original only", async () => {
    put(ctx, "claude/-work-p/orig.jsonl", ORIGINAL);
    put(ctx, "claude/-work-p/fork.jsonl", FORK);
    await sync();
    expect(overview(ctx.db, {})).toMatchObject(CLAUDE_TOTAL);
    expect(requests(ctx.db, "claude-code:orig")).toBe(2);
    expect(requests(ctx.db, "claude-code:fork")).toBe(1);
    expect(getSession(ctx.db, "claude-code:fork")?.session.input).toBe(300);
  });

  it("moves the copies back to the original when the fork was stored first", async () => {
    put(ctx, "claude/-work-p/fork.jsonl", FORK);
    await sync();
    expect(requests(ctx.db, "claude-code:fork")).toBe(3);

    put(ctx, "claude/-work-p/orig.jsonl", ORIGINAL);
    await sync();
    expect(overview(ctx.db, {})).toMatchObject(CLAUDE_TOTAL);
    expect(requests(ctx.db, "claude-code:orig")).toBe(2);
    const fork = getSession(ctx.db, "claude-code:fork")!.session;
    expect(fork).toMatchObject({ requests: 1, input: 300, output: 30 });
    expect(fork.cost).toBeGreaterThan(0);
  });

  it("keeps counting once when the original or the fork grows", async () => {
    put(ctx, "claude/-work-p/orig.jsonl", ORIGINAL);
    put(ctx, "claude/-work-p/fork.jsonl", FORK);
    await sync();
    fs.appendFileSync(path.join(ctx.root, "claude/-work-p/fork.jsonl"), jsonl(reply("fork", "msg_5", "req_5", "2026-10-02T11:05:00.000Z", 1, 1)));
    fs.appendFileSync(path.join(ctx.root, "claude/-work-p/orig.jsonl"), jsonl(reply("orig", "msg_6", "req_6", "2026-10-02T10:05:00.000Z", 1, 1)));
    await sync();
    expect(overview(ctx.db, {})).toMatchObject({ requests: 5, input: 602, output: 62 });
    expect(requests(ctx.db, "claude-code:orig")).toBe(3);
    expect(requests(ctx.db, "claude-code:fork")).toBe(2);
  });

  it("counts an unmarked resume copy once, whatever the file order", async () => {
    put(ctx, "claude/-work-p/resumed.jsonl", RESUMED);
    await sync();
    expect(requests(ctx.db, "claude-code:resumed")).toBe(3);
    put(ctx, "claude/-work-p/orig.jsonl", ORIGINAL);
    await sync();
    expect(overview(ctx.db, {})).toMatchObject({ requests: 3, input: 700, output: 70 });
    // Same timestamps and start, so the lower id keeps the copies.
    expect(requests(ctx.db, "claude-code:orig")).toBe(2);

    const fresh = openDb(":memory:");
    await sync(fresh);
    expect(getSession(fresh, "claude-code:orig")?.session).toEqual(getSession(ctx.db, "claude-code:orig")?.session);
    expect(getSession(fresh, "claude-code:resumed")?.session).toEqual(getSession(ctx.db, "claude-code:resumed")?.session);
  });

  it("ignores the parent's session_meta a Codex fork replays", () => {
    const child = parseCodex("/r/rollout-child.jsonl", jsonl(CHILD))!;
    expect(child.nativeId).toBe(CHILD_ID);
    expect(child.startedAt).toBe(Date.parse("2026-10-01T13:00:00.000Z"));
    const parent = parseCodex("/r/rollout-parent.jsonl", jsonl(PARENT))!;
    // The replayed token_count lines carry the same ids as the parent's.
    expect(child.usage.slice(0, 2).map((u) => u.requestId)).toEqual(parent.usage.map((u) => u.requestId));
    expect(new Set(child.usage.map((u) => u.requestId)).size).toBe(3);
  });

  it("counts a Codex fork's replayed token counts in the parent only", async () => {
    put(ctx, `codex/2026/10/01/rollout-2026-10-01T13-00-00-${CHILD_ID}.jsonl`, CHILD);
    put(ctx, `codex/2026/10/01/rollout-2026-10-01T12-00-00-${PARENT_ID}.jsonl`, PARENT);
    await sync();
    const parent = getSession(ctx.db, `codex:${PARENT_ID}`)!.session;
    const child = getSession(ctx.db, `codex:${CHILD_ID}`)!.session;
    expect(parent).toMatchObject({ requests: 2, input: 11000 - 4800, cacheRead: 4800, output: 350 });
    // Only the delta past the inherited running total.
    expect(child).toMatchObject({ requests: 1, input: 9000 - 5200, cacheRead: 5200, output: 150 });
    expect(overview(ctx.db, {})).toMatchObject({ sessions: 2, requests: 3, input: 20000 - 10000, cacheRead: 10000, output: 500 });
  });

  it("does not merge unrelated Codex sessions whose token counts differ only in rate limits", async () => {
    const other = "33333333-3333-7333-8333-333333333333";
    const otherBody = parentBody((t) => `2026-10-01T${t}.000Z`).map((l) => (l.type === "event_msg" ? { ...l, payload: { ...l.payload, rate_limits: { primary: { used_percent: 50, window_minutes: 300, resets_at: 1790000000 } } } } : l));
    put(ctx, `codex/2026/10/01/rollout-2026-10-01T12-00-00-${PARENT_ID}.jsonl`, PARENT);
    put(ctx, `codex/2026/10/01/rollout-2026-10-01T12-00-00-${other}.jsonl`, [meta(other, "2026-10-01T12:00:00.000Z"), ...otherBody]);
    await sync();
    expect(overview(ctx.db, {}).requests).toBe(4);
  });
});
