import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Adapter } from "../src/core/adapter";
import { DEFAULT_PRICES } from "../src/core/pricing";
import type { AgentEvent } from "../src/core/types";
import { archivePath, writeArchive } from "../src/ingest/archive";
import { syncAll } from "../src/ingest/sync";
import type { IndexDoc, SearchIndex } from "../src/search/native";
import { type Db, openDb } from "../src/store/db";
import { activeSessions, getSession, listSessions, sessionEvents, syncStatus } from "../src/store/queries";

/**
 * Logs whose first line is a JSON header {id, cwd?, parent?} and whose other lines are one user message each, all
 * synthetic. An empty log parses to nothing.
 */
function treeAdapter(dir: string, onParse?: (events: AgentEvent[]) => AgentEvent[]): Adapter {
  return {
    id: "fake",
    label: "Fake",
    roots: () => [dir],
    match: (p) => p.endsWith(".log"),
    parse: (_p, content) => {
      const [header, ...rest] = content.split("\n").filter(Boolean);
      if (!header) return null;
      const h = JSON.parse(header) as { id: string; cwd?: string; parent?: string; ts?: number };
      const at = h.ts ?? 1000;
      const events: AgentEvent[] = rest.map((text, i) => ({ ts: at + i, kind: "user", text }));
      return {
        source: "fake",
        nativeId: h.id,
        parentNativeId: h.parent,
        cwd: h.cwd,
        startedAt: at,
        endedAt: at + rest.length,
        events: onParse ? onParse(events) : events,
        usage: [],
      };
    },
  };
}

const log = (header: { id: string; cwd?: string; parent?: string; ts?: number }, ...messages: string[]) =>
  `${[JSON.stringify(header), ...messages].join("\n")}\n`;

/** `changed` in a stable order, for comparing as a set. */
const sorted = (changed: { id: string; cwd: string | null }[]) =>
  [...changed].sort((a, b) => (a.id + (a.cwd ?? "")).localeCompare(b.id + (b.cwd ?? "")));

const parentOf = (db: Db, id: string) => (db.prepare("SELECT parent_id AS p FROM sessions WHERE id = ?").get(id) as { p: string | null }).p;

/** A database whose statements matching `sql` fail like a locked database while `on()` says so. */
function failing(db: Db, sql: RegExp, on: () => boolean): Db {
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") {
        return (text: string) => {
          const stmt = target.prepare(text);
          if (!sql.test(text)) return stmt;
          return new Proxy(stmt, {
            get(s, k) {
              const value = Reflect.get(s, k, s);
              if (typeof value !== "function") return value;
              return (...args: unknown[]) => {
                if (on()) throw new Error("database is locked");
                return (value as (...a: unknown[]) => unknown).apply(s, args);
              };
            },
          });
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("sync writes", () => {
  let dir: string;
  let live: string;
  let archiveDir: string;
  let db: Db;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-sync-writes-"));
    live = path.join(dir, "live");
    fs.mkdirSync(live);
    archiveDir = path.join(dir, "archive");
    db = openDb(":memory:");
  });
  const sync = (options: { adapter?: Adapter; db?: Db; index?: SearchIndex; archive?: boolean } = {}) =>
    syncAll(options.db ?? db, {
      env: {},
      adapters: [options.adapter ?? treeAdapter(live)],
      prices: DEFAULT_PRICES,
      archiveDir,
      index: options.index,
      archive: options.archive,
    });
  const put = (name: string, content: string) => fs.writeFileSync(path.join(live, name), content);

  it("reports a session's old directory when it moves, also when another file held it", async () => {
    put("a.log", log({ id: "a", cwd: "/w1" }, "one"));
    await sync();
    put("a.log", log({ id: "a", cwd: "/w2" }, "one"));
    expect(sorted((await sync()).changed)).toEqual([
      { id: "fake:a", cwd: "/w1" },
      { id: "fake:a", cwd: "/w2" },
    ]);
    // The tool moved the log and the session's directory changed: the row the old file stored is replaced.
    fs.renameSync(path.join(live, "a.log"), path.join(live, "b.log"));
    put("b.log", log({ id: "a", cwd: "/w3" }, "one", "two"));
    expect(sorted((await sync()).changed)).toEqual([
      { id: "fake:a", cwd: "/w2" },
      { id: "fake:a", cwd: "/w3" },
    ]);
    // Unchanged directory: listed once.
    fs.appendFileSync(path.join(live, "b.log"), "three\n");
    expect((await sync()).changed).toEqual([{ id: "fake:a", cwd: "/w3" }]);
  });

  it("reports the old parent of a subagent that moved to another parent or was deleted", async () => {
    put("p1.log", log({ id: "p1", cwd: "/p1" }, "hi"));
    put("p2.log", log({ id: "p2", cwd: "/p2" }, "hi"));
    put("c.log", log({ id: "c", cwd: "/c", parent: "p1" }, "sub"));
    await sync();
    put("c.log", log({ id: "c", cwd: "/c", parent: "p2" }, "sub"));
    expect(sorted((await sync()).changed)).toEqual([
      { id: "fake:c", cwd: "/c" },
      { id: "fake:p1", cwd: "/p1" },
    ]);
    put("c.log", "");
    expect(sorted((await sync()).changed)).toEqual([
      { id: "fake:c", cwd: "/c" },
      { id: "fake:p2", cwd: "/p2" },
    ]);
    expect(getSession(db, "fake:c")).toBeNull();
  });

  it("breaks a parent cycle at ingest, whatever the write order, so every session is listed", async () => {
    // Read in one sync: a (parent b) first, then b (parent a), which closes the cycle and becomes the root.
    put("a.log", log({ id: "a", parent: "b", ts: Date.now() }, "x"));
    put("b.log", log({ id: "b", parent: "a", ts: Date.now() }, "y"));
    await sync();
    expect([parentOf(db, "fake:a"), parentOf(db, "fake:b")]).toEqual(["fake:b", null]);
    const listed = listSessions(db, {}, { limit: -1, offset: 0 });
    expect(listed.rows.map((r) => [r.id, r.subagents])).toEqual([["fake:b", 1]]);
    expect(activeSessions(db, Date.now()).map((s) => s.id)).toEqual(["fake:b"]);
    // Re-writing either keeps the same shape: the check runs against what is stored.
    fs.appendFileSync(path.join(live, "a.log"), "more\n");
    fs.appendFileSync(path.join(live, "b.log"), "more\n");
    await sync();
    expect([parentOf(db, "fake:a"), parentOf(db, "fake:b")]).toEqual(["fake:b", null]);

    // The other order, across syncs: b first, then a closes the cycle.
    const other = openDb(":memory:");
    archiveDir = path.join(dir, "archive-2"); // A new database lists the archive: start from an empty one.
    fs.rmSync(path.join(live, "a.log"));
    await sync({ db: other });
    put("a.log", log({ id: "a", parent: "b" }, "x"));
    await sync({ db: other });
    expect([parentOf(other, "fake:a"), parentOf(other, "fake:b")]).toEqual([null, "fake:a"]);
    expect(listSessions(other, {}, { limit: -1, offset: 0 }).rows.map((r) => [r.id, r.subagents])).toEqual([["fake:a", 1]]);

    // A session naming itself as parent, and a longer cycle.
    const third = openDb(":memory:");
    archiveDir = path.join(dir, "archive-3");
    fs.rmSync(live, { recursive: true });
    fs.mkdirSync(live);
    put("s.log", log({ id: "s", parent: "s" }, "x"));
    put("t1.log", log({ id: "t1", parent: "t3" }, "x"));
    put("t2.log", log({ id: "t2", parent: "t1" }, "x"));
    put("t3.log", log({ id: "t3", parent: "t2" }, "x"));
    await sync({ db: third });
    expect(parentOf(third, "fake:s")).toBeNull();
    expect(listSessions(third, {}, { limit: -1, offset: 0 }).rows.map((r) => [r.id, r.subagents]).sort()).toEqual([
      ["fake:s", 0],
      ["fake:t3", 2],
    ]);
  });

  it("clips and indexes only the events an append writes", async () => {
    const reads = new Map<string, number>();
    // Counts every read of an event's tool input: the chained hash and the automatic tags read every event's, clipping
    // only those of the events it stores or indexes.
    const counting = treeAdapter(live, (events) =>
      events.map((e) => {
        const input = JSON.stringify({ content: `${e.text} `.repeat(2000) });
        return Object.defineProperty({ ...e, kind: "tool_call" as const, toolName: "Write" }, "toolInput", {
          enumerable: true,
          get: () => {
            reads.set(e.text!, (reads.get(e.text!) ?? 0) + 1);
            return input;
          },
        });
      }),
    );
    const docs: IndexDoc[] = [];
    let gen: number | null = null;
    const index: SearchIndex = {
      generation: () => gen,
      apply: (batch) => {
        docs.push(...batch.add);
        gen = batch.generation;
      },
      search: () => [],
      docCount: () => docs.length,
    };
    put("a.log", log({ id: "a", cwd: "/w" }, "one", "two"));
    await sync({ adapter: counting, index });
    put("a.log", log({ id: "a", cwd: "/w" }, "one", "two", "three"));
    reads.clear();
    docs.length = 0;
    await sync({ adapter: counting, index });
    const base = reads.get("one")!;
    expect(Object.fromEntries(reads)).toEqual({ one: base, two: base, three: base + 1 });
    expect(docs.map((d) => d.seq)).toEqual([2]);
    expect(sessionEvents(db, "fake:a").map((e) => e.toolInput!.length <= 6_000)).toEqual([true, true, true]);

    // A directory change re-indexes every event, so every one is clipped again.
    put("a.log", log({ id: "a", cwd: "/elsewhere" }, "one", "two", "three"));
    reads.clear();
    await sync({ adapter: counting, index });
    expect(Object.fromEntries(reads)).toEqual({ one: base + 1, two: base + 1, three: base + 1 });
  });

  it("retries an archived-only log whose write failed for a passing reason", async () => {
    let writeFails = true;
    let parses = 0;
    const base = treeAdapter(live);
    const adapter: Adapter = {
      ...base,
      parse: (p, content) => {
        const s = base.parse(p, content);
        if (s?.nativeId !== "gone") return s;
        parses++;
        // NaN violates NOT NULL in SQLite: the write fails although the parse succeeded.
        return { ...s, startedAt: writeFails ? Number.NaN : 1000 };
      },
    };
    // One live log so the database knows files (otherwise every sync lists the archive), and one only archived.
    put("live.log", log({ id: "live" }, "x"));
    await writeArchive(archiveDir, "fake", path.join(live, "gone.log"), Buffer.from(log({ id: "gone" }, "kept")));
    const first = await sync({ adapter });
    expect(first.errors.map((e) => path.basename(e.path))).toEqual(["gone.log"]);
    writeFails = false;
    const second = await sync({ adapter });
    expect(second.errors).toEqual([]);
    expect(sessionEvents(db, "fake:gone").map((e) => e.text)).toEqual(["kept"]);
    expect(syncStatus(db).errors).toEqual([]);
    // Stored now: later syncs neither list the archive nor parse it again.
    await sync({ adapter });
    expect(parses).toBe(2);
  });

  it("survives a failed archive bookkeeping write, and retries the copy later", async () => {
    const file = path.join(live, "a.log");
    put("a.log", log({ id: "a" }, "x"));
    const target = archivePath(archiveDir, "fake", file);
    fs.mkdirSync(target, { recursive: true }); // The copy's rename fails.
    await sync();
    fs.rmdirSync(target);
    let locked = true;
    const flaky = failing(db, /^UPDATE files SET error = \?/, () => locked);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    try {
      const r = await sync({ db: flaky });
      expect(r.errors.map((e) => [path.basename(e.path), e.error])).toEqual([["a.log", "database is locked"]]);
      expect(syncStatus(db).errors.map((e) => e.error.startsWith("archive: "))).toEqual([true]);
      locked = false;
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 122_000);
      expect((await sync()).errors).toEqual([]);
    } finally {
      now.mockRestore();
    }
    expect(syncStatus(db).errors).toEqual([]);
    expect(fs.statSync(target).isFile()).toBe(true);
  });

  it("rebuilds the search index after a sync could not record its generation", async () => {
    const docs = new Map<string, IndexDoc>();
    let gen: number | null = null;
    let resets = 0;
    const index: SearchIndex = {
      generation: () => gen,
      apply: (batch) => {
        if (batch.reset) {
          resets++;
          docs.clear();
        }
        for (const d of batch.add) docs.set(`${d.sessionId}#${d.seq}`, d);
        gen = batch.generation;
      },
      search: () => [],
      docCount: () => docs.size,
    };
    put("a.log", log({ id: "a" }, "one"));
    await sync({ index });
    expect(resets).toBe(1);
    let locked = true;
    const flaky = failing(db, /INSERT INTO meta/, () => locked);
    fs.appendFileSync(path.join(live, "a.log"), "two\n");
    await expect(sync({ db: flaky, index })).rejects.toThrow("database is locked");
    locked = false;
    // Nothing new, and the generation did not move: only the flag says the index missed "two".
    await sync({ db: flaky, index });
    expect(resets).toBe(2);
    expect([...docs.values()].some((d) => d.text === "two")).toBe(true);
    await sync({ index });
    expect(resets).toBe(2);
  });
});
