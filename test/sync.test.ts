import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Adapter, Env } from "../src/core/adapter";
import { fileOps } from "../src/core/activity";
import type { AgentEvent } from "../src/core/types";
import { archivePath, writeArchive } from "../src/ingest/archive";
import { clipToolInput, syncAll } from "../src/ingest/sync";
import { DEFAULT_PRICES } from "../src/core/pricing";
import type { IndexDoc, SearchIndex } from "../src/search/native";
import { type Db, openDb } from "../src/store/db";
import { byModel, byTool, getSession, listSessions, overview, sessionEvents, syncStatus } from "../src/store/queries";
import { dispatchPrompts } from "../src/store/dispatch";

interface Ctx {
  db: Db;
  env: Env;
  root: string;
}

/** Copy the fixtures into a scratch home and point every adapter at it. */
function setup(): Ctx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-monitor-sync-"));
  fs.cpSync(path.join(__dirname, "fixtures"), root, { recursive: true });
  const env = {
    HOME: root,
    AGENT_MONITOR_OMP_DIRS: path.join(root, "omp"),
    AGENT_MONITOR_CLAUDE_CODE_DIRS: path.join(root, "claude-code"),
    AGENT_MONITOR_CODEX_DIRS: path.join(root, "codex"),
  };
  return { db: openDb(":memory:"), env, root };
}

describe("sync", () => {
  let ctx: Ctx;
  const sync = () => syncAll(ctx.db, { env: ctx.env, prices: DEFAULT_PRICES });

  beforeEach(() => {
    ctx = setup();
  });

  it("ingests every adapter's logs", async () => {
    const r = await sync();
    expect(r).toMatchObject({ scanned: 5, parsed: 5, sessions: 5, errors: [] });
    const o = overview(ctx.db, {});
    expect(o).toMatchObject({ sessions: 3, subagents: 2, requests: 9, userMessages: 3 });
    // omp reported 0.171016 + 0.01002; Claude Code estimated 0.014616 + 0.00105; Codex unpriced.
    expect(o.cost).toBeCloseTo(0.196702, 9);
    expect(o.estimatedCost).toBeCloseTo(0.015666, 9);
    expect(o.unpricedTokens).toBe(5300 + 6050);
  });

  it("skips unchanged files and re-parses changed ones", async () => {
    await sync();
    expect((await sync()).parsed).toBe(0);

    const file = path.join(ctx.root, "codex/2026/10/01/rollout-2026-10-01T12-00-00-ccc333.jsonl");
    fs.appendFileSync(
      file,
      `${JSON.stringify({ timestamp: "2026-10-01T12:01:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "and fix it" }] } })}\n`,
    );
    const r = await sync();
    expect(r.parsed).toBe(1);
    expect(getSession(ctx.db, "codex:ccc333")?.session.userMessages).toBe(2);
  });

  it("keeps history when a tool deletes its log", async () => {
    await sync();
    fs.rmSync(path.join(ctx.root, "codex"), { recursive: true });
    await sync();
    expect(getSession(ctx.db, "codex:ccc333")).not.toBeNull();
    expect(syncStatus(ctx.db).missing).toBe(1);
  });

  it("rolls subagent work into the parent session", async () => {
    await sync();
    const { rows, total } = listSessions(ctx.db, {}, { limit: 10, offset: 0 });
    expect(total).toBe(3);
    const omp = rows.find((r) => r.id === "omp:aaa111")!;
    expect(omp.subagents).toBe(1);
    expect(omp.output).toBe(150);
    expect(omp.total.output).toBe(1150);
    expect(omp.total.cost).toBeCloseTo(0.181036, 9);

    const detail = getSession(ctx.db, "claude-code:sess-1")!;
    expect(detail.children.map((c) => c.id)).toEqual(["claude-code:sess-1/agent-xyz"]);
    expect(detail.session.costSource).toBe("estimated");
    expect(getSession(ctx.db, "claude-code:sess-1/agent-xyz")?.parent?.id).toBe("claude-code:sess-1");
  });

  it("keeps the prompt each subagent was dispatched with", async () => {
    await sync();
    const prompts = dispatchPrompts(ctx.db, ["omp:aaa111", "omp:bbb222", "claude-code:sess-1/agent-xyz"]);
    // Top-level sessions have none; subagents get exactly what their parent sent.
    expect(Object.keys(prompts).sort()).toEqual(["claude-code:sess-1/agent-xyz", "omp:bbb222"]);
    expect(prompts["omp:bbb222"]).toBe("research the auth library");
  });

  it("filters by source, directory, search and time", async () => {
    await sync();
    expect(overview(ctx.db, { source: "codex" }).sessions).toBe(1);
    expect(listSessions(ctx.db, { cwd: "/work/other" }, { limit: 10, offset: 0 }).total).toBe(1);
    expect(listSessions(ctx.db, { q: "login" }, { limit: 10, offset: 0 }).rows[0]?.id).toBe("omp:aaa111");
    expect(overview(ctx.db, { from: Date.parse("2026-10-02T00:00:00Z") }).requests).toBe(3);
  });

  it("aggregates tools and models", async () => {
    await sync();
    const tools = byTool(ctx.db, {});
    expect(tools.find((t) => t.tool === "read")).toEqual({ tool: "read", calls: 1, errors: 1 });
    expect(tools.find((t) => t.tool === "shell")).toEqual({ tool: "shell", calls: 1, errors: 1 });
    const models = byModel(ctx.db, {});
    expect(models.find((m) => m.model === "gpt-5-codex")?.costSource).toBe("unpriced");
    expect(models.find((m) => m.model === "claude-opus-5-5" && m.source === "omp")?.costSource).toBe("reported");
  });
});

const CODEX_LOG = "codex/2026/10/01/rollout-2026-10-01T12-00-00-ccc333.jsonl";
const codexLine = (text: string, at = "2026-10-01T12:01:00.000Z") =>
  `${JSON.stringify({ timestamp: at, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } })}\n`;

/** In-memory stand-in for the native index that records every batch. */
function fakeIndex() {
  const docs = new Map<string, IndexDoc>();
  const batches: { reset?: boolean; deleteSessions: string[]; add: IndexDoc[]; generation: number }[] = [];
  let committed: number | null = null;
  let locked = false;
  const index: SearchIndex = {
    generation: () => committed,
    apply(batch) {
      if (locked) throw new Error("LOCKED: held by another process");
      batches.push(batch);
      if (batch.reset) docs.clear();
      for (const id of batch.deleteSessions) for (const key of [...docs.keys()]) if (docs.get(key)!.sessionId === id) docs.delete(key);
      for (const d of batch.add) docs.set(`${d.sessionId}#${d.seq}`, d);
      committed = batch.generation;
    },
    search: () => [],
    docCount: () => docs.size,
  };
  return { index, docs, batches, lock: (v: boolean) => (locked = v) };
}

describe("archive and incremental sync", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it("restores logs the tool deleted from the archive when the database is rebuilt", async () => {
    await syncAll(ctx.db, { env: ctx.env, prices: DEFAULT_PRICES });
    fs.rmSync(path.join(ctx.root, "codex"), { recursive: true });

    const fresh = openDb(":memory:");
    const r = await syncAll(fresh, { env: ctx.env, prices: DEFAULT_PRICES });
    expect(r.errors).toEqual([]);
    expect(getSession(fresh, "codex:ccc333")?.session.userMessages).toBe(1);
    expect(syncStatus(fresh)).toMatchObject({ files: 5, missing: 1 });
    expect(overview(fresh, {}).sessions).toBe(3);
  });

  it("appending to a log stores the same events as parsing it from scratch", async () => {
    await syncAll(ctx.db, { env: ctx.env, prices: DEFAULT_PRICES });
    fs.appendFileSync(path.join(ctx.root, CODEX_LOG), codexLine("and fix it"));
    await syncAll(ctx.db, { env: ctx.env, prices: DEFAULT_PRICES });

    const fresh = openDb(":memory:");
    await syncAll(fresh, { env: ctx.env, prices: DEFAULT_PRICES, archiveDir: fs.mkdtempSync(path.join(os.tmpdir(), "am-archive-")) });
    expect(getSession(ctx.db, "codex:ccc333")).toEqual(getSession(fresh, "codex:ccc333"));
    expect(sessionEvents(ctx.db, "codex:ccc333")).toEqual(sessionEvents(fresh, "codex:ccc333"));
  });

  it("replaces a session whose earlier lines changed", async () => {
    await syncAll(ctx.db, { env: ctx.env, prices: DEFAULT_PRICES });
    const file = path.join(ctx.root, CODEX_LOG);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const first = lines.findIndex((l) => l.includes("Run the tests"));
    lines[first] = codexLine("a rewritten prompt").trimEnd();
    fs.writeFileSync(file, lines.join("\n"));
    await syncAll(ctx.db, { env: ctx.env, prices: DEFAULT_PRICES });

    const texts = sessionEvents(ctx.db, "codex:ccc333").filter((e) => e.kind === "user").map((e) => e.text);
    expect(texts).toEqual(["a rewritten prompt"]);
  });

  it("keeps the search index in step: full build first, then only appended events", async () => {
    const fake = fakeIndex();
    const sync = () => syncAll(ctx.db, { env: ctx.env, prices: DEFAULT_PRICES, index: fake.index });
    const first = await sync();
    expect(fake.batches.at(-1)?.generation).toBe(first.generation);
    const eventRows = (ctx.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    expect(fake.docs.size).toBe(eventRows + 5); // one session document per session

    fake.batches.length = 0;
    fs.appendFileSync(path.join(ctx.root, CODEX_LOG), codexLine("and fix it"));
    await sync();
    expect(fake.batches).toHaveLength(1);
    expect(fake.batches[0]).toMatchObject({ deleteSessions: [] });
    expect(fake.batches[0].add.map((d) => d.text)).toEqual(["and fix it"]);

    fake.batches.length = 0;
    expect((await sync()).parsed).toBe(0);
    expect(fake.batches).toHaveLength(0);
  });

  it("rebuilds the index after an update it missed because another process held the lock", async () => {
    const fake = fakeIndex();
    const sync = () => syncAll(ctx.db, { env: ctx.env, prices: DEFAULT_PRICES, index: fake.index });
    await sync();
    fake.lock(true);
    fs.appendFileSync(path.join(ctx.root, CODEX_LOG), codexLine("missed while locked"));
    expect((await sync()).indexError).toMatch(/^LOCKED/);

    fake.lock(false);
    fake.batches.length = 0;
    await sync();
    expect(fake.batches[0]?.reset).toBe(true);
    expect([...fake.docs.values()].some((d) => d.text === "missed while locked")).toBe(true);
  });

  it("retries a file whose write failed on the next sync, but not one that fails to parse", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-retry-"));
    fs.writeFileSync(path.join(dir, "a.log"), "x");
    fs.writeFileSync(path.join(dir, "b.log"), "x");
    let writeFails = true;
    let parses = { a: 0, b: 0 };
    const adapter: Adapter = {
      id: "fake",
      label: "Fake",
      roots: () => [dir],
      match: (p) => p.endsWith(".log"),
      parser: (p) => ({
        push: () => true,
        result: () => {
          if (p.endsWith("b.log")) {
            parses.b++;
            throw new Error("unparseable");
          }
          parses.a++;
          // NaN timestamps violate NOT NULL in SQLite: the write fails although the parse succeeded.
          const ts = writeFails ? Number.NaN : 1;
          return { source: "fake", nativeId: "a", startedAt: ts, endedAt: ts, events: [], usage: [] };
        },
      }),
    };
    const sync = () => syncAll(ctx.db, { env: {}, adapters: [adapter], prices: DEFAULT_PRICES, archiveDir: path.join(dir, "archive") });

    expect((await sync()).errors.map((e) => path.basename(e.path)).sort()).toEqual(["a.log", "b.log"]);
    writeFails = false;
    parses = { a: 0, b: 0 };
    const r = await sync();
    expect(parses).toEqual({ a: 1, b: 0 });
    expect(r.errors).toEqual([]);
    expect(getSession(ctx.db, "fake:a")).not.toBeNull();
  });

  it("retries a failed archive copy a minute later without re-parsing the log, and leaves no temp file", async () => {
    const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "am-archive-"));
    const log = path.join(ctx.root, CODEX_LOG);
    const target = archivePath(archiveDir, "codex", log);
    // A directory where the copy belongs makes its final rename fail.
    fs.mkdirSync(target, { recursive: true });
    const sync = () => syncAll(ctx.db, { env: ctx.env, prices: DEFAULT_PRICES, archiveDir });

    const first = await sync();
    expect(first.errors.map((e) => [e.path, e.error.startsWith("archive: ")])).toEqual([[log, true]]);
    expect(getSession(ctx.db, "codex:ccc333")).not.toBeNull();
    expect(fs.readdirSync(path.dirname(target)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // Pending, and not retried before a minute has passed.
    expect((await sync()).errors).toEqual([]);
    expect(syncStatus(ctx.db).errors.map((e) => e.path)).toEqual([log]);

    fs.rmdirSync(target);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    const retried = await sync();
    now.mockRestore();
    expect(retried).toMatchObject({ parsed: 0, errors: [] });
    expect(syncStatus(ctx.db).errors).toEqual([]);
    expect(gunzipSync(fs.readFileSync(target)).equals(fs.readFileSync(log))).toBe(true);
  });

  it("keeps a moved log's live copy over its archived old path when the database is rebuilt", async () => {
    const userTexts = (db: Db) => sessionEvents(db, "codex:ccc333").filter((e) => e.kind === "user").map((e) => e.text);
    await syncAll(ctx.db, { env: ctx.env, prices: DEFAULT_PRICES });
    // Codex archiving a session: the same rollout moves to archived_sessions/ and keeps growing there.
    const moved = path.join(ctx.root, "codex", "archived_sessions", path.basename(CODEX_LOG));
    fs.mkdirSync(path.dirname(moved));
    fs.renameSync(path.join(ctx.root, CODEX_LOG), moved);
    fs.appendFileSync(moved, codexLine("after the move"));
    await syncAll(ctx.db, { env: ctx.env, prices: DEFAULT_PRICES });
    expect(userTexts(ctx.db)).toContain("after the move");

    const fresh = openDb(":memory:");
    await syncAll(fresh, { env: ctx.env, prices: DEFAULT_PRICES });
    expect(getSession(fresh, "codex:ccc333")?.session.filePath).toBe(moved);
    expect(userTexts(fresh)).toEqual(userTexts(ctx.db));

    await syncAll(ctx.db, { env: ctx.env, prices: DEFAULT_PRICES, full: true });
    expect(getSession(ctx.db, "codex:ccc333")?.session.filePath).toBe(moved);
    expect(userTexts(ctx.db)).toContain("after the move");
  });
});

/** Logs with one user message per line after the first, which holds the session id; an empty log parses to nothing. */
function lineAdapter(dir: string): Adapter {
  return {
    id: "fake",
    label: "Fake",
    roots: () => [dir],
    match: (p) => p.endsWith(".log"),
    parser: () => {
      let id: string | undefined;
      const events: AgentEvent[] = [];
      return {
        push: (line) => {
          if (!line) return false;
          if (id === undefined) id = line;
          else events.push({ ts: 1000 + events.length, kind: "user", text: line });
          return true;
        },
        result: () =>
          id === undefined ? null : { source: "fake", nativeId: id, cwd: "/work/fake", startedAt: 1000, endedAt: 1000 + events.length, events, usage: [] },
      };
    },
  };
}

describe("archive copies and listing", () => {
  let db: Db;
  let live: string;
  let archiveDir: string;
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-archive-sync-"));
    live = path.join(dir, "live");
    fs.mkdirSync(live);
    archiveDir = path.join(dir, "archive");
    db = openDb(":memory:");
  });
  const sync = (options: { full?: boolean; archive?: boolean } = {}, on: Db = db) =>
    syncAll(on, { env: {}, adapters: [lineAdapter(live)], prices: DEFAULT_PRICES, archiveDir, ...options });
  const archived = (file: string) => gunzipSync(fs.readFileSync(archivePath(archiveDir, "fake", file)));
  const fileRow = (file: string) =>
    ({ ...(db.prepare("SELECT archived_size AS size, archived_gz_size AS gzSize FROM files WHERE path = ?").get(file) as { size: number; gzSize: number }) });

  it("appends a grown log's new bytes to its copy, and rewrites it when the prefix or the .gz changed", async () => {
    const log = path.join(live, "a.log");
    fs.writeFileSync(log, "a\none\n");
    await sync();
    const gz1 = fs.readFileSync(archivePath(archiveDir, "fake", log));

    fs.appendFileSync(log, "two\n");
    await sync();
    const gz2 = fs.readFileSync(archivePath(archiveDir, "fake", log));
    expect(gz2.length).toBeGreaterThan(gz1.length);
    expect(gz2.subarray(0, gz1.length).equals(gz1)).toBe(true);
    expect(archived(log).equals(fs.readFileSync(log))).toBe(true);
    expect(fileRow(log)).toEqual({ size: fs.statSync(log).size, gzSize: gz2.length });

    // A torn earlier append: the .gz is not the size we left it at, so it is rewritten whole.
    fs.appendFileSync(archivePath(archiveDir, "fake", log), Buffer.from([0x1f, 0x8b, 0x08]));
    fs.appendFileSync(log, "three\n");
    expect((await sync()).errors).toEqual([]);
    expect(archived(log).equals(fs.readFileSync(log))).toBe(true);

    // An earlier line rewritten in place.
    fs.writeFileSync(log, "a\nONE\ntwo\nthree\nfour\n");
    await sync();
    expect(archived(log).toString()).toBe("a\nONE\ntwo\nthree\nfour\n");
    expect(sessionEvents(db, "fake:a").map((e) => e.text)).toEqual(["ONE", "two", "three", "four"]);
  });

  it("lists the archive on a database's first sync, with full or an explicit archive pass, or while it knows no files", async () => {
    const log = path.join(live, "a.log");
    fs.writeFileSync(log, "a\none\n");
    await sync();
    // Copies that appear later (e.g. restored from a backup) wait for the next listing.
    await writeArchive(archiveDir, "fake", path.join(live, "b.log"), Buffer.from("b\nold\n"));
    await sync();
    expect(getSession(db, "fake:b")).toBeNull();
    await sync({ archive: true });
    expect(getSession(db, "fake:b")).not.toBeNull();
    await writeArchive(archiveDir, "fake", path.join(live, "c.log"), Buffer.from("c\nold\n"));
    await sync();
    expect(getSession(db, "fake:c")).toBeNull();
    await sync({ full: true });
    expect(getSession(db, "fake:c")).not.toBeNull();

    // Deleted live logs are still flagged on every sync, without listing the archive.
    fs.rmSync(log);
    await sync();
    expect(syncStatus(db).missing).toBe(3);
    expect(getSession(db, "fake:a")).not.toBeNull();

    // A database without files lists the archive every time, so it fills as soon as copies appear.
    const empty = openDb(":memory:");
    archiveDir = path.join(path.dirname(live), "archive-2");
    fs.rmSync(live, { recursive: true });
    await sync({}, empty);
    await writeArchive(archiveDir, "fake", path.join(live, "d.log"), Buffer.from("d\nold\n"));
    await sync({}, empty);
    expect(getSession(empty, "fake:d")).not.toBeNull();
  });

  it("records an unreadable archive copy and skips it until the copy changes", async () => {
    const lost = path.join(live, "z.log");
    const target = archivePath(archiveDir, "fake", lost);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "not gzip");
    const first = await sync();
    expect(first.errors.map((e) => [e.path, e.error.startsWith("unreadable archive copy: ")])).toEqual([[target, true]]);
    expect(syncStatus(db).errors.map((e) => e.path)).toEqual([lost]);

    expect((await sync({ archive: true })).errors).toEqual([]);
    expect((await sync({ full: true })).errors).toEqual([]);

    await writeArchive(archiveDir, "fake", lost, Buffer.from("z\nrecovered\n"));
    const fixed = await sync({ archive: true });
    expect(fixed.errors).toEqual([]);
    expect(sessionEvents(db, "fake:z").map((e) => e.text)).toEqual(["recovered"]);
    expect(syncStatus(db).errors).toEqual([]);
  });

  it("keeps the fuller of two archived-only copies of one session, whatever the read order", async () => {
    const pick = async (copies: Record<string, string>) => {
      const fresh = openDb(":memory:");
      archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "am-archive-dup-"));
      for (const [name, content] of Object.entries(copies)) await writeArchive(archiveDir, "fake", path.join(live, name), Buffer.from(content));
      await sync({}, fresh);
      const first = path.basename(getSession(fresh, "fake:dup")!.session.filePath);
      await sync({ full: true }, fresh);
      expect(path.basename(getSession(fresh, "fake:dup")!.session.filePath)).toBe(first);
      return first;
    };
    expect(await pick({ "x1.log": "dup\n1\n2\n3\n", "x2.log": "dup\n1\n" })).toBe("x1.log");
    expect(await pick({ "x1.log": "dup\n1\n", "x2.log": "dup\n1\n2\n3\n" })).toBe("x2.log");
    // Equal copies: the path that sorts first.
    expect(await pick({ "x1.log": "dup\n1\n", "x2.log": "dup\n2\n" })).toBe("x1.log");
  });

  it("reports every session it wrote or deleted, with its directory", async () => {
    const log = path.join(live, "a.log");
    fs.writeFileSync(log, "a\none\n");
    expect((await sync()).changed).toEqual([{ id: "fake:a", cwd: "/work/fake" }]);
    expect((await sync()).changed).toEqual([]);
    fs.appendFileSync(log, "two\n");
    expect((await sync()).changed).toEqual([{ id: "fake:a", cwd: "/work/fake" }]);
    // The log now parses to nothing: its session is deleted.
    fs.writeFileSync(log, "");
    const r = await sync();
    expect(r.changed).toEqual([{ id: "fake:a", cwd: "/work/fake" }]);
    expect(getSession(db, "fake:a")).toBeNull();
  });
});

describe("clipped tool input", () => {
  const MAX = 6_000;
  const body = (n: number) => Array.from({ length: n }, (_, i) => `+  const line${i} = ${JSON.stringify("synthetic ".repeat(4))};`).join("\n");
  const patch = [
    "*** Begin Patch",
    ...Array.from({ length: 12 }, (_, i) => [`*** Update File: src/file${i}.ts`, "@@", body(40)].join("\n")),
    "*** Add File: src/new.ts",
    body(60),
    "*** Delete File: src/old.ts",
    "*** Update File: src/from.ts",
    "*** Move to: src/to.ts",
    body(30),
    "*** End Patch",
  ].join("\n");
  const write = JSON.stringify({ file_path: "/work/src/big.ts", content: body(2000) });

  it("keeps JSON valid with every key, and every file a patch or edit names", () => {
    const cases: [string, string][] = [
      ["Write", write],
      ["apply_patch", JSON.stringify({ input: patch })],
      ["apply_patch", patch], // Codex custom tool: the raw patch, not JSON
      ["shell", JSON.stringify({ command: ["apply_patch", patch], workdir: "/work" })],
      ["edit", JSON.stringify({ input: `[src/a.ts#1A2B]\n${body(200)}\n[src/b.ts#3C4D]\nREM\n[src/c.ts#9F00]\nMV src/d.ts\n${body(50)}` })],
    ];
    for (const [tool, input] of cases) {
      expect(input.length).toBeGreaterThan(MAX);
      const clipped = clipToolInput(input, MAX)!;
      expect(clipped.length).toBeLessThanOrEqual(MAX);
      expect(clipped).toContain("… [truncated ");
      if (input.startsWith("{")) expect(Object.keys(JSON.parse(clipped))).toEqual(Object.keys(JSON.parse(input)));
      const ops = fileOps(tool, input, "/work");
      expect(ops.length).toBeGreaterThan(0);
      expect(fileOps(tool, clipped, "/work")).toEqual(ops);
    }
    expect(fileOps("apply_patch", JSON.stringify({ input: patch }), "/work")).toHaveLength(15);
  });

  it("stores the clipped input so file tracking still sees big writes and patches", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-clip-"));
    const adapter: Adapter = {
      id: "fake",
      label: "Fake",
      roots: () => [dir],
      match: (p) => p.endsWith(".log"),
      parser: () => ({
        push: () => true,
        result: () => ({
          source: "fake",
          nativeId: "clip",
          cwd: "/work",
          startedAt: 1,
          endedAt: 2,
          events: [
            { ts: 1, kind: "tool_call" as const, toolName: "Write", toolCallId: "w", toolInput: write },
            { ts: 2, kind: "tool_call" as const, toolName: "apply_patch", toolCallId: "p", toolInput: JSON.stringify({ input: patch }) },
          ],
          usage: [],
        }),
      }),
    };
    fs.writeFileSync(path.join(dir, "a.log"), "x");
    const db = openDb(":memory:");
    await syncAll(db, { env: {}, adapters: [adapter], prices: DEFAULT_PRICES, archiveDir: path.join(dir, "archive") });
    const [w, p] = sessionEvents(db, "fake:clip");
    expect(w.toolInput!.length).toBeLessThanOrEqual(MAX);
    expect(fileOps(w.toolName, w.toolInput, "/work")).toEqual(fileOps("Write", write, "/work"));
    expect(fileOps(p.toolName, p.toolInput, "/work").map((o) => o.op)).toEqual([...Array(12).fill("edit"), "write", "delete", "move"]);
  });
});
