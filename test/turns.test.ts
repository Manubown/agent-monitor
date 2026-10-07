import { beforeEach, describe, expect, it } from "vitest";
import { codexAdapter } from "../src/adapters/codex";
import { ompAdapter } from "../src/adapters/omp";
import { parseLog } from "../src/core/adapter";
import { IDLE_GAP_MS } from "../src/core/autotags";
import {
  COMPACTION_TEXT,
  type ContextRequest,
  detectCompactions,
  INFERRED_MIN_DROP_SHARE,
  INFERRED_MIN_DROP_TOKENS,
  isCompactionMarker,
} from "../src/core/compaction";
import { type Db, openDb } from "../src/store/db";
import { sessionContext, sessionTurns } from "../src/store/turns";

const T = Date.UTC(2026, 9, 1, 12);
const MIN = 60_000;

function insertSession(db: Db, id: string, opts: { parentId?: string; startedAt?: number; cwd?: string } = {}): void {
  const [source, nativeId] = id.split(":");
  db.prepare(
    `INSERT INTO sessions (id, source, native_id, parent_id, file_path, title, cwd, git_branch, agent_version, models,
       started_at, ended_at, event_count, user_messages, tool_calls, tool_errors, errors, requests,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, cost_source, events_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, '[]', ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 'none', '')`,
  ).run(id, source, nativeId, opts.parentId ?? null, `/logs/${nativeId}.jsonl`, nativeId, opts.cwd ?? "/work/proj", opts.startedAt ?? T, opts.startedAt ?? T);
}

interface Ev {
  ts: number;
  kind: string;
  tool?: string;
  callId?: string;
  input?: unknown;
  text?: string;
  error?: boolean;
}

function insertEvents(db: Db, sessionId: string, events: Ev[]): void {
  const stmt = db.prepare(
    "INSERT INTO events (session_id, seq, ts, kind, text, tool_name, tool_call_id, tool_input, is_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  events.forEach((e, seq) =>
    stmt.run(sessionId, seq, e.ts, e.kind, e.text ?? null, e.tool ?? null, e.callId ?? null, e.input === undefined ? null : JSON.stringify(e.input), e.error ? 1 : 0),
  );
}

interface Use {
  ts: number;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number | null;
  source?: string;
}

function insertUsage(db: Db, sessionId: string, rows: Use[]): void {
  const stmt = db.prepare(
    `INSERT INTO usage (session_id, seq, ts, model, input, output, cache_read, cache_write, reasoning, cost_usd, cost_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  );
  rows.forEach((u, seq) =>
    stmt.run(
      sessionId,
      seq,
      u.ts,
      u.model ?? "m",
      u.input ?? 0,
      u.output ?? 0,
      u.cacheRead ?? 0,
      u.cacheWrite ?? 0,
      u.cost === undefined ? 0.1 : u.cost,
      u.source ?? "reported",
    ),
  );
}

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("sessionTurns", () => {
  it("returns nothing for an unknown session", () => {
    expect(sessionTurns(db, "omp:nope")).toEqual([]);
  });

  it("attributes the whole tree to prompts by timestamp, with work before the first prompt in its own row", () => {
    insertSession(db, "omp:root");
    // A subagent started during turn 1 whose requests run past the second prompt.
    insertSession(db, "omp:sub", { parentId: "omp:root", startedAt: T + 3 * MIN });
    insertEvents(db, "omp:root", [
      { ts: T, kind: "system", text: "injected context" },
      { ts: T + MIN, kind: "tool_call", tool: "read", callId: "r0", input: { path: "a.ts" } },
      { ts: T + 2 * MIN, kind: "user", text: "first  prompt\nwith lines" },
      { ts: T + 3 * MIN, kind: "tool_call", tool: "task", callId: "t", input: { tasks: [{ name: "sub" }] } },
      { ts: T + 10 * MIN, kind: "user", text: "second" },
      { ts: T + 11 * MIN, kind: "error", text: "overloaded" },
    ]);
    insertEvents(db, "omp:sub", [
      { ts: T + 4 * MIN, kind: "tool_call", tool: "edit", callId: "e1", input: { path: "src/x.ts" } },
      { ts: T + 5 * MIN, kind: "tool_result", tool: "edit", callId: "e1", error: true },
      { ts: T + 12 * MIN, kind: "tool_call", tool: "bash", callId: "b1", input: { command: "ls" } },
    ]);
    insertUsage(db, "omp:root", [
      { ts: T + MIN, input: 10, output: 5, cost: 0.5 },
      { ts: T + 3 * MIN, input: 100, cacheRead: 1000, output: 10, cost: 1 },
    ]);
    insertUsage(db, "omp:sub", [
      { ts: T + 4 * MIN, input: 7, output: 3, cost: 0.25 },
      { ts: T + 15 * MIN, input: 1, output: 1, cost: null, source: "unpriced" },
    ]);

    const turns = sessionTurns(db, "omp:root");
    expect(turns.map((t) => t.n)).toEqual([0, 1, 2]);
    const [before, first, second] = turns;

    expect(before.prompt).toBeNull();
    expect(before).toMatchObject({ start: T, requests: 1, tokens: 15, toolCalls: 1, cost: 0.5, costSource: "reported" });
    expect(before.tools.read).toBe(1);

    expect(first.prompt).toEqual({ seq: 2, text: "first prompt with lines" });
    expect(first).toMatchObject({ start: T + 2 * MIN, end: T + 5 * MIN, requests: 2, toolCalls: 2, failedTools: 1, filesChanged: 1, subagents: 1 });
    expect(first.tools).toMatchObject({ agent: 1, write: 1 });
    expect(first.tokens).toBe(1110 + 10);
    expect(first.cost).toBeCloseTo(1.25);

    // Open-ended: everything after the last prompt, subagent work included, up to the last activity.
    expect(second).toMatchObject({ start: T + 10 * MIN, end: T + 15 * MIN, requests: 1, errors: 1, toolCalls: 1, subagents: 0 });
    expect(second.tools.shell).toBe(1);
    expect(second.cost).toBeNull();
    expect(second.costSource).toBe("unpriced");
  });

  it("drops the pre-prompt row when only injected context precedes the first prompt", () => {
    insertSession(db, "claude-code:s");
    insertEvents(db, "claude-code:s", [
      { ts: T, kind: "system", text: "<env>" },
      { ts: T + 1000, kind: "user", text: "go" },
      { ts: T + 2000, kind: "assistant", text: "ok" },
    ]);
    const turns = sessionTurns(db, "claude-code:s");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ n: 1, start: T + 1000, end: T + 2000, activeMs: 1000 });
  });

  it("treats a session without prompts (a subagent run) as one implicit turn", () => {
    insertSession(db, "omp:sub");
    insertEvents(db, "omp:sub", [
      { ts: T, kind: "system", text: "task instructions" },
      { ts: T + 1000, kind: "tool_call", tool: "write", callId: "w", input: { path: "/work/proj/a.md" } },
      { ts: T + 2000, kind: "tool_call", tool: "write", callId: "w2", input: { path: "a.md" } },
    ]);
    insertUsage(db, "omp:sub", [{ ts: T + 500, input: 3, output: 1 }]);
    const turns = sessionTurns(db, "omp:sub");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ n: 0, prompt: null, start: T, requests: 1, toolCalls: 2, filesChanged: 1 });
  });

  it("counts long pauses as idle unless a tool result ends them", () => {
    insertSession(db, "omp:s");
    insertEvents(db, "omp:s", [
      { ts: T, kind: "user", text: "go" },
      { ts: T + MIN, kind: "tool_call", tool: "bash", callId: "b", input: { command: "make" } },
      // A 20-minute build: the result ends the pause, so it was work.
      { ts: T + 21 * MIN, kind: "tool_result", tool: "bash", callId: "b" },
      { ts: T + 22 * MIN, kind: "assistant", text: "done" },
      // The user walked away; the next activity is not a tool result.
      { ts: T + 22 * MIN + IDLE_GAP_MS + 1, kind: "assistant", text: "still here" },
    ]);
    const [turn] = sessionTurns(db, "omp:s");
    expect(turn.activeMs).toBe(22 * MIN);
    expect(turn.end - turn.start).toBe(22 * MIN + IDLE_GAP_MS + 1);
  });
});

describe("detectCompactions", () => {
  const req = (context: number, ts: number, model = "m"): ContextRequest => ({ ts, model, context });

  it("places a marker before the first request at or after it and measures the drop", () => {
    const requests = [req(100_000, 1), req(150_000, 2), req(30_000, 4), req(35_000, 5)];
    expect(detectCompactions(requests, [3])).toEqual([{ index: 2, ts: 3, inferred: false, before: 150_000, after: 30_000, drop: 120_000 }]);
  });

  it("keeps a marker with no request after it at the end, drop unknown", () => {
    expect(detectCompactions([req(100_000, 1)], [5])).toEqual([{ index: 1, ts: 5, inferred: false, before: 100_000, after: null, drop: null }]);
  });

  it("infers a compaction from a large drop only past both thresholds", () => {
    const big = 200_000;
    const atShare = big * (1 - INFERRED_MIN_DROP_SHARE);
    expect(detectCompactions([req(big, 1), req(atShare, 2)], [])).toMatchObject([{ index: 1, inferred: true, drop: big - atShare }]);
    // Just under the share threshold.
    expect(detectCompactions([req(big, 1), req(atShare + 1, 2)], [])).toEqual([]);
    // Three quarters of a small context is past the share but under the token threshold.
    const small = INFERRED_MIN_DROP_TOKENS * 1.2;
    expect(detectCompactions([req(small, 1), req(small / 4, 2)], [])).toEqual([]);
  });

  it("does not infer across a model switch, a failed request or a recorded marker", () => {
    expect(detectCompactions([req(200_000, 1, "a"), req(10_000, 2, "b")], [])).toEqual([]);
    // A request without context (failed) is skipped: the drop is measured to the next real one.
    expect(detectCompactions([req(200_000, 1), req(0, 2), req(10_000, 3)], [])).toMatchObject([{ index: 2, inferred: true, before: 200_000, after: 10_000 }]);
    expect(detectCompactions([req(200_000, 1), req(0, 3), req(10_000, 4)], [2])).toMatchObject([{ index: 1, inferred: false, before: 200_000, after: 10_000 }]);
  });
});

describe("compaction markers", () => {
  it("recognizes the normalized marker", () => {
    expect(isCompactionMarker("system", COMPACTION_TEXT)).toBe(true);
    expect(isCompactionMarker("user", COMPACTION_TEXT)).toBe(false);
    expect(isCompactionMarker("system", "Turn aborted")).toBe(false);
  });

  it("is emitted for omp compaction entries", () => {
    const log = [
      { type: "session", id: "s1", cwd: "/w", timestamp: "2026-10-01T12:00:00Z" },
      { type: "compaction", timestamp: "2026-10-01T12:05:00Z", summary: "…", tokensBefore: 180000 },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    expect(parseLog(ompAdapter, "/x/2026_s1.jsonl", log)?.events).toEqual([{ ts: Date.parse("2026-10-01T12:05:00Z"), kind: "system", text: COMPACTION_TEXT }]);
  });

  it("is emitted once for a Codex compaction logged as both rollout item and event", () => {
    const log = [
      { timestamp: "2026-10-01T12:00:00Z", type: "session_meta", payload: { id: "c1", cwd: "/w" } },
      { timestamp: "2026-10-01T12:05:00Z", type: "compacted", payload: { message: "summary" } },
      { timestamp: "2026-10-01T12:05:00Z", type: "event_msg", payload: { type: "context_compacted" } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    const events = parseLog(codexAdapter, "/x/rollout-c1.jsonl", log)?.events ?? [];
    expect(events.filter((e) => isCompactionMarker(e.kind, e.text))).toHaveLength(1);
  });
});

describe("sessionContext", () => {
  it("lists each agent's requests, the session first, with its own compactions", () => {
    insertSession(db, "claude-code:root");
    insertSession(db, "claude-code:sub", { parentId: "claude-code:root", startedAt: T + MIN });
    insertSession(db, "claude-code:idle", { parentId: "claude-code:root", startedAt: T + 2 * MIN });
    insertUsage(db, "claude-code:root", [
      { ts: T, input: 10, cacheRead: 150_000, cacheWrite: 5_000 },
      { ts: T + 3 * MIN, input: 10, cacheWrite: 20_000 },
    ]);
    insertUsage(db, "claude-code:sub", [
      { ts: T + MIN, cacheRead: 100_000 },
      { ts: T + 2 * MIN, cacheRead: 10_000 },
    ]);
    insertEvents(db, "claude-code:root", [{ ts: T + 2 * MIN, kind: "system", text: COMPACTION_TEXT }]);

    const agents = sessionContext(db, "claude-code:root");
    expect(agents.map((a) => [a.id, a.depth, a.requests.length])).toEqual([
      ["claude-code:root", 0, 2],
      ["claude-code:sub", 1, 2],
    ]);
    expect(agents[0].requests[0]).toEqual({
      ts: T,
      // No event precedes this request, so it falls back to the session's first one (the compaction marker).
      seq: 0,
      prompt: null,
      model: "m",
      input: 10,
      cacheRead: 150_000,
      cacheWrite: 5_000,
      output: 0,
      cost: 0.1,
      costSource: "reported",
    });
    expect(agents[0].compactions).toEqual([{ index: 1, ts: T + 2 * MIN, inferred: false, before: 155_010, after: 20_010, drop: 135_000 }]);
    expect(agents[1].compactions).toMatchObject([{ index: 1, inferred: true, drop: 90_000 }]);
  });

  it("points each request at the event it followed and the prompt that was running", () => {
    insertSession(db, "claude-code:root");
    insertSession(db, "claude-code:sub", { parentId: "claude-code:root", startedAt: T + 3 * MIN });
    insertEvents(db, "claude-code:root", [
      { ts: T, kind: "user", text: "  first   prompt " },
      { ts: T + MIN, kind: "assistant", text: "working" },
      { ts: T + 4 * MIN, kind: "user", text: "second prompt" },
    ]);
    insertEvents(db, "claude-code:sub", [{ ts: T + 3 * MIN, kind: "user", text: "do the subtask" }]);
    insertUsage(db, "claude-code:root", [
      // Before any event of the session: links to its first event rather than nowhere.
      { ts: T - MIN },
      { ts: T + 2 * MIN },
      { ts: T + 5 * MIN },
    ]);
    insertUsage(db, "claude-code:sub", [{ ts: T + 3 * MIN }]);

    const agents = sessionContext(db, "claude-code:root");
    expect(agents[0].requests.map((r) => [r.seq, r.prompt])).toEqual([
      [0, null],
      [1, "first prompt"],
      [2, "second prompt"],
    ]);
    // A subagent links into its own timeline, with its dispatch prompt.
    expect(agents[1].requests.map((r) => [r.seq, r.prompt])).toEqual([[0, "do the subtask"]]);
  });
});
