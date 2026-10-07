import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code";
import { codexAdapter } from "../src/adapters/codex";
import { ompAdapter } from "../src/adapters/omp";
import { type Adapter, parseLog } from "../src/core/adapter";
import { AutoTagScan } from "../src/core/autotags";
import { DEFAULT_PRICES } from "../src/core/pricing";
import type { ParsedSession } from "../src/core/types";
import { archivePath, readArchive } from "../src/ingest/archive";
import { feed, type LogState, logStates, remember } from "../src/ingest/incremental";
import { type SyncResult, syncAll } from "../src/ingest/sync";
import { type Db, openDb } from "../src/store/db";

/**
 * Reading a growing log where the last sync stopped: the parsers must come out exactly where a parse of the whole
 * file does, and so must the database after any number of syncs.
 */

const NEWLINE = 0x0a;

/**
 * Read a log the way sync does: feed the bytes that arrived, keep the offset of the first line not taken and offer
 * the rest again with the bytes that follow. A line taken without its newline must be followed by that newline, or
 * sync reads the whole file instead (see `appended`), so that happens here too.
 */
function inPieces(adapter: Adapter, filePath: string, raw: Buffer, cuts: readonly number[]): ParsedSession | null {
  const parser = adapter.parser(filePath);
  let offset = 0;
  for (const end of [...cuts, raw.length]) {
    if (end <= offset) continue;
    const consumed = feed(parser, raw.subarray(offset, end));
    offset += consumed;
    if (consumed > 0 && offset < raw.length && raw[offset - 1] !== NEWLINE && raw[offset] !== NEWLINE) {
      return parseLog(adapter, filePath, raw.toString("utf8"));
    }
  }
  return parser.result();
}

const everyByte = (n: number): number[] => Array.from({ length: n - 1 }, (_, i) => i + 1);
const lineEnds = (raw: Buffer): number[] => everyByte(raw.length).filter((i) => raw[i - 1] === NEWLINE);

const fixture = (rel: string) => {
  const file = path.join(__dirname, "fixtures", rel);
  return { file, raw: fs.readFileSync(file) };
};

const LOGS: { adapter: Adapter; rel: string }[] = [
  { adapter: ompAdapter, rel: "omp/-proj/2026-10-01T09-00-00-000Z_aaa111.jsonl" },
  { adapter: ompAdapter, rel: "omp/-proj/2026-10-01T09-00-00-000Z_aaa111/Research.jsonl" },
  { adapter: claudeCodeAdapter, rel: "claude-code/-proj/sess-1.jsonl" },
  { adapter: claudeCodeAdapter, rel: "claude-code/-proj/sess-1/subagents/agent-xyz.jsonl" },
  { adapter: codexAdapter, rel: "codex/2026/10/01/rollout-2026-10-01T12-00-00-ccc333.jsonl" },
  { adapter: codexAdapter, rel: "codex-legacy/rollout-2025-06-01T10-00-00-0f0e0d0c-0b0a-4908-8706-050403020100.jsonl" },
];

describe("parsing a log in pieces", () => {
  for (const { adapter, rel } of LOGS) {
    it(`gives what the whole file gives: ${rel}`, () => {
      const { file, raw } = fixture(rel);
      const whole = parseLog(adapter, file, raw.toString("utf8"));
      expect(whole).not.toBeNull();
      // Line by line, byte by byte (every mid-line split), and with the last newline arriving on its own.
      expect(inPieces(adapter, file, raw, lineEnds(raw))).toEqual(whole);
      expect(inPieces(adapter, file, raw, everyByte(raw.length))).toEqual(whole);
      expect(inPieces(adapter, file, raw, [raw.length - 1])).toEqual(whole);
    });

    it(`gives the same for CRLF lines: ${rel}`, () => {
      const { file, raw } = fixture(rel);
      const crlf = Buffer.from(raw.toString("utf8").replace(/\n/g, "\r\n"), "utf8");
      const whole = parseLog(adapter, file, crlf.toString("utf8"));
      expect(whole).toEqual(parseLog(adapter, file, raw.toString("utf8")));
      expect(inPieces(adapter, file, crlf, everyByte(crlf.length))).toEqual(whole);
    });
  }

  it("keeps a character split across two reads whole", () => {
    const file = "/omp/2026-10-01T09-00-00-000Z_utf8.jsonl";
    const text = "héllo 🚀 wörld";
    const raw = Buffer.from(
      `${[
        { type: "session", id: "utf8", cwd: "/work", timestamp: "2026-10-01T09:00:00.000Z" },
        { type: "message", timestamp: "2026-10-01T09:00:01.000Z", message: { role: "user", content: text } },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
      "utf8",
    );
    const whole = parseLog(ompAdapter, file, raw.toString("utf8"));
    expect(whole?.events[0].text).toBe(text);
    // Every cut lands inside a character at some point: the rocket alone is four bytes.
    expect(inPieces(ompAdapter, file, raw, everyByte(raw.length))).toEqual(whole);
    const rocket = raw.indexOf(Buffer.from("🚀", "utf8"));
    expect(inPieces(ompAdapter, file, raw, [rocket + 1, rocket + 2, rocket + 3])).toEqual(whole);
  });

  it("takes a complete last line without its newline, and does not count it twice when the newline arrives", () => {
    const file = "/omp/2026-10-01T09-00-00-000Z_tail.jsonl";
    const line = (text: string, at: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "user", content: text } });
    const head = `${JSON.stringify({ type: "session", id: "tail", cwd: "/work", timestamp: "2026-10-01T09:00:00.000Z" })}\n`;
    const parser = ompAdapter.parser(file);
    const first = Buffer.from(`${head}${line("one", "2026-10-01T09:00:01.000Z")}`, "utf8");
    expect(feed(parser, first)).toBe(first.length); // The complete record is taken without its newline.
    expect(parser.result()?.events.map((e) => e.text)).toEqual(["one"]);
    const rest = Buffer.from(`\n${line("two", "2026-10-01T09:00:02.000Z")}\n`, "utf8");
    expect(feed(parser, rest)).toBe(rest.length);
    expect(parser.result()?.events.map((e) => e.text)).toEqual(["one", "two"]);
    expect(parser.result()).toEqual(parseLog(ompAdapter, file, Buffer.concat([first, rest]).toString("utf8")));
  });

  it("leaves a half-written line for the bytes that complete it", () => {
    const file = "/omp/2026-10-01T09-00-00-000Z_half.jsonl";
    const parser = ompAdapter.parser(file);
    const head = Buffer.from(`${JSON.stringify({ type: "session", id: "half", cwd: "/work", timestamp: "2026-10-01T09:00:00.000Z" })}\n{"type":"mess`, "utf8");
    expect(feed(parser, head)).toBe(head.indexOf(0x7b, 1)); // Only the first line; the half line stays pending.
    expect(parser.result()?.events).toEqual([]);
  });
});

/** One log file under a root the adapter's env var points at, synced again and again as it grows. */
function scratch(adapterId: string, name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-incremental-"));
  const live = path.join(dir, "live");
  fs.mkdirSync(live);
  const file = path.join(live, name);
  return { dir, live, file, env: { [`AGENT_MONITOR_${adapterId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_DIRS`]: live } };
}

/** Everything a sync stores about sessions, in a stable order (`files` carries the sync's own clock). */
const dump = (db: Db) => ({
  sessions: db.prepare("SELECT * FROM sessions ORDER BY id").all().map((r) => ({ ...r })),
  events: db.prepare("SELECT * FROM events ORDER BY session_id, seq").all().map((r) => ({ ...r })),
  usage: db.prepare("SELECT * FROM usage ORDER BY session_id, seq").all().map((r) => ({ ...r })),
  tags: db.prepare("SELECT * FROM auto_tags ORDER BY session_id, tag").all().map((r) => ({ ...r })),
});

describe("syncing a log as it grows", () => {
  /** A database and its archive that keep being synced, plus a fresh full sync of the same file for comparison. */
  const grower = (adapter: Adapter, name: string) => {
    const { dir, file, env } = scratch(adapter.id, name);
    const db = openDb(":memory:");
    const archiveDir = path.join(dir, "archive");
    const sync = (full = false): Promise<SyncResult> => syncAll(db, { env, adapters: [adapter], prices: DEFAULT_PRICES, archiveDir, full });
    const fresh = async () => {
      const other = openDb(":memory:");
      await syncAll(other, { env, adapters: [adapter], prices: DEFAULT_PRICES, archiveDir: path.join(dir, `archive-${Date.now()}-${Math.random()}`) });
      return dump(other);
    };
    const write = (content: string) => fs.writeFileSync(file, content);
    /** Sync, then check the database holds exactly what a fresh full sync of the file holds. */
    const syncAndCompare = async (full = false) => {
      const r = await sync(full);
      expect(r.errors).toEqual([]);
      expect(dump(db)).toEqual(await fresh());
      return r;
    };
    return { db, file, archiveDir, adapter, write, sync, syncAndCompare };
  };

  const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 9, 0, s)).toISOString();
  const ompLines = {
    title: (title: string) => JSON.stringify({ type: "title", title }),
    session: JSON.stringify({ type: "session", id: "s1", cwd: "/work/proj", timestamp: at(0) }),
    user: (text: string, s: number) => JSON.stringify({ type: "message", timestamp: at(s), message: { role: "user", content: text } }),
    call: (id: string, command: string, s: number) =>
      JSON.stringify({
        type: "message",
        timestamp: at(s),
        message: {
          role: "assistant",
          model: "anthropic/claude-opus-5",
          content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
          usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, cost: { total: 0.002 } },
        },
      }),
    edit: (id: string, file: string, s: number) =>
      JSON.stringify({
        type: "message",
        timestamp: at(s),
        message: {
          role: "assistant",
          model: "anthropic/claude-opus-5",
          content: [{ type: "toolCall", id, name: "edit", arguments: { input: `[${file}#1A2B]\nPUT 1.=1:\n+const x = 1;` } }],
          usage: { input: 90, output: 30, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
        },
      }),
    result: (id: string, text: string, isError: boolean, s: number) =>
      JSON.stringify({ type: "message", timestamp: at(s), message: { role: "toolResult", toolCallId: id, content: text, isError } }),
  };

  it("ends up where a fresh full sync does, however the log grew", async () => {
    const g = grower(ompAdapter, "2026-10-01T09-00-00-000Z_s1.jsonl");
    const lines = [ompLines.title("Fix the build"), ompLines.session, ompLines.user("fix the build", 1)];
    g.write(`${lines.join("\n")}\n`);
    const first = await g.syncAndCompare();
    expect(first).toMatchObject({ parsed: 1, appended: 0 });

    // A plain append stores the new line without reading the stored ones again.
    const grown = [...lines, ompLines.call("c1", "pnpm test", 2), ompLines.result("c1", "1 failed", true, 3)];
    g.write(`${grown.join("\n")}\n`);
    const second = await g.syncAndCompare();
    expect(second.appended).toBe(1);

    // Half a line, then the rest of it.
    const half = `${grown.join("\n")}\n${ompLines.call("c2", "pnpm test", 4).slice(0, 40)}`;
    g.write(half);
    expect((await g.syncAndCompare()).appended).toBe(1);
    g.write(`${[...grown, ompLines.call("c2", "pnpm test", 4)].join("\n")}\n`);
    expect((await g.syncAndCompare()).appended).toBe(1);

    // A complete last line without its newline, then the newline and the next line.
    const tail = [...grown, ompLines.call("c2", "pnpm test", 4), ompLines.result("c2", "1 failed", true, 5)];
    g.write(tail.join("\n"));
    expect((await g.syncAndCompare()).appended).toBe(1);
    g.write(`${tail.join("\n")}\n`);
    await g.syncAndCompare();
    g.write(`${[...tail, ompLines.user("try again", 6)].join("\n")}\n`);
    expect((await g.syncAndCompare()).appended).toBe(1);

    // omp rewrites its title line in place: with the same length, and with another.
    const retitled = [ompLines.title("Fix the buiLD"), ...tail.slice(1), ompLines.user("try again", 6)];
    g.write(`${retitled.join("\n")}\n`);
    const rewritten = await g.syncAndCompare();
    expect(rewritten).toMatchObject({ appended: 0, parsed: 1 });
    const longer = [ompLines.title("Fix the build, then the tests"), ...tail.slice(1), ompLines.user("try again", 6)];
    g.write(`${longer.join("\n")}\n`);
    expect((await g.syncAndCompare()).appended).toBe(0);

    // Growing again after a rewrite is incremental once more.
    g.write(`${[...longer, ompLines.user("and ship it", 7)].join("\n")}\n`);
    expect((await g.syncAndCompare()).appended).toBe(1);

    // The log shrank: read whole.
    g.write(`${longer.slice(0, 3).join("\n")}\n`);
    expect((await g.syncAndCompare()).appended).toBe(0);

    // A full sync re-reads everything and leaves the same rows.
    g.write(`${longer.join("\n")}\n`);
    await g.syncAndCompare();
    expect((await g.syncAndCompare(true)).appended).toBe(0);

    // Every byte of the log reached its archive copy, member by member.
    expect((await readArchive(archivePath(g.archiveDir, "omp", g.file))).equals(fs.readFileSync(g.file))).toBe(true);
    // Each step is compared against a sync of the whole file into a fresh database, so this is slow on purpose.
  }, 60_000);

  it("tags the loops a fresh parse finds while the calls and their results arrive one sync at a time", async () => {
    const g = grower(ompAdapter, "2026-10-01T09-00-00-000Z_loop.jsonl");
    const lines = [ompLines.session, ompLines.user("fix the build", 1)];
    g.write(`${lines.join("\n")}\n`);
    await g.syncAndCompare();
    // A call is only scored once its result is there, so every sync in between must come out the same as a parse of
    // the whole file: five edits of one file, each after a failed test run.
    for (let i = 0; i < 5; i++) {
      for (const line of [
        ompLines.edit(`e${i}`, "src/a.ts", 10 + i * 4),
        ompLines.result(`e${i}`, "ok", false, 11 + i * 4),
        ompLines.call(`c${i}`, "pnpm test", 12 + i * 4),
        ompLines.result(`c${i}`, "1 failed", true, 13 + i * 4),
      ]) {
        lines.push(line);
        g.write(`${lines.join("\n")}\n`);
        await g.syncAndCompare();
      }
    }
    const tags = g.db.prepare("SELECT tag FROM auto_tags ORDER BY tag").all().map((t) => ({ ...t }));
    expect(tags).toContainEqual({ tag: "loop" });
    expect(tags).toContainEqual({ tag: "errors" });
    expect(tags).toContainEqual({ tag: "tests" });
  }, 60_000);

  it("reads only what was appended to a big log", async () => {
    const g = grower(ompAdapter, "2026-10-01T09-00-00-000Z_big.jsonl");
    const pad = "x".repeat(20_000);
    const lines = [ompLines.session, ...Array.from({ length: 20 }, (_, i) => ompLines.user(`${pad} ${i}`, i + 1))];
    g.write(`${lines.join("\n")}\n`);
    const size = fs.statSync(g.file).size;
    expect((await g.syncAndCompare()).bytesRead).toBe(size);

    g.write(`${[...lines, ompLines.user("one more", 30)].join("\n")}\n`);
    const second = await g.syncAndCompare();
    expect(second.appended).toBe(1);
    // The bytes checked at the start of the log plus the line that arrived, not the 400 KiB in between.
    expect(second.bytesRead).toBeLessThan(size / 4);
  }, 60_000);

  it("rewrites the usage rows a later line changes", async () => {
    const g = grower(claudeCodeAdapter, "sess-g.jsonl");
    const line = (s: number, usage: { output_tokens: number }, block: object) =>
      JSON.stringify({
        type: "assistant",
        timestamp: at(s),
        sessionId: "sess-g",
        cwd: "/work/proj",
        requestId: "req_1",
        message: { id: "msg_1", model: "claude-opus-4-1-20250805", content: [block], usage: { input_tokens: 100, cache_read_input_tokens: 10, ...usage } },
      });
    const user = JSON.stringify({ type: "user", timestamp: at(0), sessionId: "sess-g", cwd: "/work/proj", message: { role: "user", content: "hello" } });
    const first = line(1, { output_tokens: 10 }, { type: "text", text: "on it" });
    g.write(`${user}\n${first}\n`);
    await g.syncAndCompare();

    // The same message id, with the usage the whole response cost: the stored row is replaced, not added to.
    const second = line(2, { output_tokens: 40 }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/work/a.ts" } });
    g.write(`${user}\n${first}\n${second}\n`);
    const r = await g.syncAndCompare();
    expect(r.appended).toBe(1);
    expect(g.db.prepare("SELECT output FROM usage WHERE session_id = 'claude-code:sess-g'").all().map((u) => ({ ...u }))).toEqual([{ output: 40 }]);
  });

  it("replaces a counted Codex request with its usage record", async () => {
    const g = grower(codexAdapter, "rollout-2026-10-01T09-00-00-11111111-2222-4333-8444-555555555555.jsonl");
    const meta = JSON.stringify({
      timestamp: at(0),
      type: "session_meta",
      payload: { id: "11111111-2222-4333-8444-555555555555", timestamp: at(0), cwd: "/work/proj", cli_version: "0.60.0" },
    });
    const count = JSON.stringify({
      timestamp: at(1),
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 } } },
    });
    g.write(`${meta}\n${count}\n`);
    await g.syncAndCompare();
    expect(g.db.prepare("SELECT request_id AS id FROM usage").all().map((u) => ({ ...u })).length).toBe(1);

    // The record for the same request arrives late: it replaces the counted one instead of counting it twice.
    const record = JSON.stringify({
      timestamp: at(2),
      type: "token_usage_record",
      payload: { response_id: "resp_1", usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 } },
    });
    g.write(`${meta}\n${count}\n${record}\n`);
    const r = await g.syncAndCompare();
    expect(r.appended).toBe(1);
    const rows = g.db.prepare("SELECT request_id AS id FROM usage").all().map((u) => ({ ...u }));
    expect(rows).toEqual([{ id: "codex:resp_1" }]);
  });

  it("reads the whole log again when its archive copy is not as we left it", async () => {
    const g = grower(ompAdapter, "2026-10-01T09-00-00-000Z_s2.jsonl");
    const lines = [ompLines.session, ompLines.user("one", 1)];
    g.write(`${lines.join("\n")}\n`);
    await g.syncAndCompare();
    // A torn append by another process: the copy is rewritten whole, and the log is read whole with it.
    fs.appendFileSync(archivePath(g.archiveDir, "omp", g.file), Buffer.from([0x1f, 0x8b, 0x08]));
    g.write(`${[...lines, ompLines.user("two", 2)].join("\n")}\n`);
    expect((await g.syncAndCompare()).appended).toBe(0);
    expect((await readArchive(archivePath(g.archiveDir, "omp", g.file))).equals(fs.readFileSync(g.file))).toBe(true);
  });

  it("reads the whole log again when another process wrote its row", async () => {
    // The documented way to re-price: the server keeps syncing while `pnpm sync --full` runs from the CLI.
    const { dir, file, env } = scratch(ompAdapter.id, "2026-10-01T09-00-00-000Z_priced.jsonl");
    const archiveDir = path.join(dir, "archive");
    const dbFile = path.join(dir, "monitor.db");
    const prices = (usd: number) => ({ "test-model": { input: usd, output: 0, cacheRead: 0 } });
    const request = (s: number) =>
      JSON.stringify({
        type: "message",
        timestamp: at(s),
        message: { role: "assistant", model: "test-model", content: [{ type: "text", text: "ok" }], usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
      });
    fs.writeFileSync(file, `${[ompLines.session, request(1)].join("\n")}\n`);

    const server = openDb(dbFile);
    await syncAll(server, { env, adapters: [ompAdapter], prices: prices(1), archiveDir });
    const cli = openDb(dbFile);
    await syncAll(cli, { env, adapters: [ompAdapter], prices: prices(2), archiveDir, full: true });
    cli.close();

    // The server's next sync must not extend the row the CLI rewrote with what it stored itself.
    fs.appendFileSync(file, `${request(2)}\n`);
    const r = await syncAll(server, { env, adapters: [ompAdapter], prices: prices(2), archiveDir });
    expect(r.errors).toEqual([]);
    const session = { ...(server.prepare("SELECT requests, cost_usd AS cost FROM sessions").get() as object) };
    const usage = { ...(server.prepare("SELECT COUNT(*) AS n, SUM(cost_usd) AS cost FROM usage").get() as object) };
    expect(usage).toEqual({ n: 2, cost: 4 });
    expect(session).toEqual({ requests: 2, cost: 4 });
    server.close();
  });
});

describe("the cache of resumable logs", () => {
  /** A state of `size` bytes, with everything a cached log carries and nothing this test reads. */
  const state = (size: number): LogState => ({
    adapterId: "omp",
    parser: ompAdapter.parser("/x.jsonl"),
    offset: 0,
    pending: false,
    size,
    mtimeMs: 0,
    syncedAt: 0,
    head: createHash("sha1"),
    headLen: 0,
    tail: Buffer.alloc(0),
    archive: createHash("sha1"),
    carry: {
      events: 0,
      hash: "",
      row: {
        userMessages: 0,
        toolCalls: 0,
        toolErrors: 0,
        errors: 0,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: null,
        costSource: "none",
        models: "[]",
      },
      cwd: null,
      gitBranch: null,
      usage: [],
      kept: [],
      rows: [],
      tags: [],
      scan: new AutoTagScan({}),
    },
    used: Date.now(),
  });

  it("keeps the other logs when one is too big for it", () => {
    const db = openDb(":memory:");
    remember(db, "/a.jsonl", state(1024));
    remember(db, "/b.jsonl", state(2048));
    expect([...logStates(db).keys()]).toEqual(["/a.jsonl", "/b.jsonl"]);
    // A session larger than the whole cache is not kept, and must not push the small ones out either.
    remember(db, "/big.jsonl", state(40 * 1024 * 1024));
    expect([...logStates(db).keys()]).toEqual(["/a.jsonl", "/b.jsonl"]);
  });
});
