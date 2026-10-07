import { beforeEach, describe, expect, it } from "vitest";
import { filtersFrom } from "../app/lib/server";
import { dayEnd, dayStart, isDay } from "../src/core/day";
import { dayActivity } from "../src/store/day";
import { type Db, openDb } from "../src/store/db";
import { listProjects } from "../src/store/projects";
import { daily, listSessions, overview } from "../src/store/queries";

const DAY = "2026-10-06";
const PREV = "2026-10-05";
const NEXT = "2026-10-07";
const start = dayStart(DAY);
const end = dayEnd(DAY);
const MIN = 60_000;
/** `h` hours into the day, in local time. */
const at = (h: number, m = 0) => start + h * 3600_000 + m * MIN;

function insertSession(db: Db, id: string, opts: { parentId?: string; startedAt?: number; endedAt?: number; cwd?: string; title?: string } = {}): void {
  const [source, nativeId] = id.split(":");
  db.prepare(
    `INSERT INTO sessions (id, source, native_id, parent_id, file_path, title, cwd, git_branch, agent_version, models,
       started_at, ended_at, event_count, user_messages, tool_calls, tool_errors, errors, requests,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, cost_source, events_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, '[]', ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 'none', '')`,
  ).run(
    id,
    source,
    nativeId,
    opts.parentId ?? null,
    `/logs/${nativeId}.jsonl`,
    opts.title ?? nativeId,
    opts.cwd ?? "/work/proj",
    opts.startedAt ?? start,
    opts.endedAt ?? opts.startedAt ?? start,
  );
}

interface Ev {
  ts: number;
  kind: string;
  tool?: string;
  input?: unknown;
  text?: string;
}

let seqs: Record<string, number>;

function insertEvents(db: Db, sessionId: string, events: Ev[]): void {
  const stmt = db.prepare("INSERT INTO events (session_id, seq, ts, kind, text, tool_name, tool_input, is_error) VALUES (?, ?, ?, ?, ?, ?, ?, 0)");
  for (const e of events) {
    const seq = (seqs[sessionId] = (seqs[sessionId] ?? -1) + 1);
    stmt.run(sessionId, seq, e.ts, e.kind, e.text ?? null, e.tool ?? null, e.input === undefined ? null : JSON.stringify(e.input));
  }
}

function insertUsage(db: Db, sessionId: string, rows: { ts: number; tokens?: number; cost?: number | null; source?: string }[]): void {
  const stmt = db.prepare(
    `INSERT INTO usage (session_id, seq, ts, model, input, output, cache_read, cache_write, reasoning, cost_usd, cost_source)
     VALUES (?, ?, ?, 'm', ?, 0, 0, 0, 0, ?, ?)`,
  );
  rows.forEach((u, i) => stmt.run(sessionId, i, u.ts, u.tokens ?? 100, u.cost === undefined ? 1 : u.cost, u.source ?? "reported"));
}

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  seqs = {};
});

describe("local calendar days", () => {
  it("accepts only real days written as YYYY-MM-DD", () => {
    expect(isDay("2026-10-06")).toBe(true);
    expect(isDay("2024-02-29")).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-10-6", "20261006", "2026-10-06T00:00", " 2026-10-06", "0026-10-06", "", undefined]) {
      expect(isDay(bad), String(bad)).toBe(false);
    }
  });

  it("spans one local day, whatever its length", () => {
    expect(dayEnd(DAY)).toBe(dayStart(NEXT));
    expect(dayEnd(DAY) - dayStart(DAY)).toBeGreaterThanOrEqual(23 * 3600_000);
    expect(dayEnd(DAY) - dayStart(DAY)).toBeLessThanOrEqual(25 * 3600_000);
    // Month and year ends roll over.
    expect(dayEnd("2026-12-31")).toBe(dayStart("2027-01-01"));
    expect(dayEnd("2026-02-28")).toBe(dayStart("2026-03-01"));
  });
});

describe("filtersFrom day window", () => {
  it("replaces the range with the from/to days", () => {
    const f = filtersFrom({ range: "7d", from: PREV, to: DAY });
    expect(f.from).toBe(dayStart(PREV));
    expect(f.to).toBe(dayEnd(DAY));
    expect(f.days).toEqual({ from: PREV, to: DAY });
    // The range id survives, so clearing the window returns to it.
    expect(f.range).toBe("7d");
  });

  it("makes one day out of from = to", () => {
    const f = filtersFrom({ from: DAY, to: DAY });
    expect([f.from, f.to]).toEqual([dayStart(DAY), dayEnd(DAY)]);
  });

  it("leaves the other end open when only one day is given", () => {
    expect(filtersFrom({ range: "all", from: DAY })).toMatchObject({ from: dayStart(DAY), to: undefined, days: { from: DAY } });
    expect(filtersFrom({ range: "all", to: DAY })).toMatchObject({ from: undefined, to: dayEnd(DAY), days: { to: DAY } });
  });

  it("falls back to the range when the days are not usable", () => {
    for (const params of [{ from: DAY, to: PREV }, { from: "2026-02-30" }, { to: "tomorrow" }, { from: "2026-10-6" }]) {
      const f = filtersFrom({ range: "all", ...params });
      expect(f.days, JSON.stringify(params)).toBeUndefined();
      expect(f.from).toBeUndefined();
      expect(f.to).toBeUndefined();
    }
  });

  it("keeps the other filters next to the window", () => {
    const f = filtersFrom({ from: DAY, source: "omp", project: "/work/proj", tag: "bug", q: "fix" });
    expect(f).toMatchObject({ source: "omp", cwd: "/work/proj", tag: "bug", q: "fix" });
  });
});

describe("filters with an upper bound", () => {
  beforeEach(() => {
    insertSession(db, "omp:inside", { startedAt: at(9), endedAt: at(10) });
    insertUsage(db, "omp:inside", [{ ts: at(9), tokens: 10 }]);
    insertEvents(db, "omp:inside", [{ ts: at(9), kind: "user", text: "inside" }]);
    insertSession(db, "omp:after", { startedAt: dayStart(NEXT), endedAt: dayStart(NEXT) + MIN });
    insertUsage(db, "omp:after", [{ ts: dayStart(NEXT), tokens: 20 }]);
    insertEvents(db, "omp:after", [{ ts: dayStart(NEXT), kind: "user", text: "after" }]);
  });

  it("cuts usage aggregates at the exclusive upper bound", () => {
    expect(overview(db, { from: start, to: end }).input).toBe(10);
    expect(daily(db, { from: start, to: end }).map((d) => d.day)).toEqual([DAY]);
    expect(overview(db, { from: start }).input).toBe(30);
  });

  it("keeps a row that lands exactly on the lower bound and drops one on the upper", () => {
    insertSession(db, "omp:edges", { startedAt: start, endedAt: end });
    insertUsage(db, "omp:edges", [
      { ts: start, tokens: 1 },
      { ts: end, tokens: 2 },
    ]);
    expect(overview(db, { from: start, to: end }).input).toBe(11);
  });

  it("lists only sessions that did something inside the window", () => {
    // Active before and after the day, idle through it: in range by its span, but nothing happened on the day.
    insertSession(db, "omp:straddles", { startedAt: dayStart(PREV), endedAt: dayStart(NEXT) + MIN });
    insertEvents(db, "omp:straddles", [
      { ts: dayStart(PREV) + MIN, kind: "user", text: "before" },
      { ts: dayStart(NEXT) + MIN, kind: "user", text: "after" },
    ]);
    const ids = listSessions(db, { from: start, to: end }, { limit: -1, offset: 0 }).rows.map((r) => r.id);
    expect(ids).toEqual(["omp:inside"]);
    // Without the upper bound the straddling session counts again, through its last activity.
    expect(listSessions(db, { from: start }, { limit: -1, offset: 0 }).rows.map((r) => r.id).sort()).toEqual(["omp:after", "omp:inside", "omp:straddles"]);
  });

  it("takes an upper bound without a lower one", () => {
    const { rows, total } = listSessions(db, { to: end }, { limit: -1, offset: 0 });
    expect(rows.map((r) => r.id)).toEqual(["omp:inside"]);
    expect(total).toBe(1);
  });

  it("counts the same sessions everywhere, however the window cuts their span", () => {
    // 22:00 the evening before until 02:00 into the day: it worked in both days, and ends after the earlier window.
    insertSession(db, "omp:midnight", { startedAt: dayStart(PREV) + 22 * 3600_000, endedAt: at(2) });
    insertEvents(db, "omp:midnight", [
      { ts: dayStart(PREV) + 22 * 3600_000, kind: "user", text: "late" },
      { ts: at(2), kind: "assistant", text: "done" },
    ]);
    // Still running when the window ends.
    insertSession(db, "omp:running", { startedAt: at(10), endedAt: dayStart(NEXT) + 5 * 3600_000 });
    insertEvents(db, "omp:running", [
      { ts: at(10), kind: "user", text: "go" },
      { ts: dayStart(NEXT) + 5 * 3600_000, kind: "assistant", text: "still at it" },
    ]);

    const yesterday = { from: dayStart(PREV), to: dayEnd(PREV) };
    expect(overview(db, yesterday).sessions).toBe(1);
    expect(listSessions(db, yesterday, { limit: -1, offset: 0 }).total).toBe(1);
    expect(dayActivity(db, {}, PREV, 8, "/home/me").total).toBe(1);
    expect(listProjects(db, yesterday, "/home/me").map((p) => p.cwd)).toEqual(["/work/proj"]);

    const today = { from: start, to: end };
    const listed = listSessions(db, today, { limit: -1, offset: 0 }).rows.map((r) => r.id).sort();
    expect(listed).toEqual(["omp:inside", "omp:midnight", "omp:running"]);
    expect(overview(db, today).sessions).toBe(listed.length);
    expect(dayActivity(db, {}, DAY, 8, "/home/me").total).toBe(listed.length);
  });
});

describe("dayActivity", () => {
  it("counts a session on every day it worked, with that day's share", () => {
    insertSession(db, "omp:night", { startedAt: dayStart(DAY) - 2 * 3600_000, endedAt: at(1) });
    insertEvents(db, "omp:night", [
      { ts: dayStart(DAY) - 2 * 3600_000, kind: "user", text: "yesterday's prompt" },
      { ts: at(0, 30), kind: "user", text: "after midnight" },
    ]);
    insertUsage(db, "omp:night", [
      { ts: dayStart(DAY) - 2 * 3600_000, tokens: 300, cost: 3 },
      { ts: at(0, 30), tokens: 100, cost: 1 },
    ]);

    const today = dayActivity(db, {}, DAY, 8, "/home/me");
    expect(today.sessions.map((s) => s.id)).toEqual(["omp:night"]);
    expect(today.sessions[0]).toMatchObject({ tokens: 100, cost: 1, requests: 1, promptCount: 1 });
    expect(today.sessions[0].prompts.map((p) => p.text)).toEqual(["after midnight"]);
    expect(today).toMatchObject({ total: 1, tokens: 100, cost: 1, prompts: 1, requests: 1 });

    const yesterday = dayActivity(db, {}, PREV, 8, "/home/me");
    expect(yesterday.sessions.map((s) => s.id)).toEqual(["omp:night"]);
    expect(yesterday.sessions[0]).toMatchObject({ tokens: 300, cost: 3, requests: 1 });
    expect(yesterday.sessions[0].prompts.map((p) => p.text)).toEqual(["yesterday's prompt"]);
  });

  it("takes events or model requests as activity, and neither as none", () => {
    insertSession(db, "omp:events-only", { startedAt: at(8), endedAt: at(8) });
    insertEvents(db, "omp:events-only", [{ ts: at(8), kind: "assistant", text: "thinking out loud" }]);
    insertSession(db, "omp:usage-only", { startedAt: at(9), endedAt: at(9) });
    insertUsage(db, "omp:usage-only", [{ ts: at(9), tokens: 7, cost: 0.5 }]);
    // Started and ended around the day but did nothing in it.
    insertSession(db, "omp:idle", { startedAt: dayStart(PREV), endedAt: dayStart(NEXT) });
    insertEvents(db, "omp:idle", [{ ts: dayStart(PREV), kind: "user", text: "before" }]);

    const a = dayActivity(db, {}, DAY, 8, "/home/me");
    expect(a.sessions.map((s) => s.id).sort()).toEqual(["omp:events-only", "omp:usage-only"]);
    expect(a.total).toBe(2);
    expect(a.sessions.find((s) => s.id === "omp:usage-only")).toMatchObject({ tokens: 7, toolCalls: 0 });
    expect(a.sessions.find((s) => s.id === "omp:events-only")).toMatchObject({ tokens: 0, cost: null, costSource: "none" });
  });

  it("agrees with the sessions list for the same window", () => {
    insertSession(db, "omp:a", { startedAt: at(1), endedAt: at(2) });
    insertEvents(db, "omp:a", [{ ts: at(1), kind: "user", text: "a" }]);
    insertSession(db, "omp:b", { startedAt: at(3), endedAt: at(4) });
    insertUsage(db, "omp:b", [{ ts: at(3), tokens: 5 }]);
    insertSession(db, "omp:other-day", { startedAt: dayStart(NEXT), endedAt: dayStart(NEXT) });
    insertEvents(db, "omp:other-day", [{ ts: dayStart(NEXT), kind: "user", text: "next" }]);

    const panel = dayActivity(db, {}, DAY, 1, "/home/me");
    const list = listSessions(db, { from: start, to: end }, { limit: -1, offset: 0 });
    expect(panel.total).toBe(list.total);
    expect(panel.total).toBe(2);
    // The panel shows its first page; the count still speaks for the whole day.
    expect(panel.sessions).toHaveLength(1);
    expect(panel.sessions[0].id).toBe(list.rows[0].id);
  });

  it("rolls a subagent's work into the day of its parent", () => {
    insertSession(db, "omp:parent", { startedAt: dayStart(PREV), endedAt: at(5) });
    insertEvents(db, "omp:parent", [{ ts: dayStart(PREV), kind: "user", text: "do it" }]);
    insertSession(db, "omp:sub", { parentId: "omp:parent", startedAt: at(4), endedAt: at(5) });
    insertEvents(db, "omp:sub", [{ ts: at(4), kind: "tool_call", tool: "Write", input: { file_path: "/work/proj/src/sub.ts" } }]);
    insertUsage(db, "omp:sub", [{ ts: at(4), tokens: 50, cost: 2 }]);

    const a = dayActivity(db, {}, DAY, 8, "/home/me");
    expect(a.sessions.map((s) => s.id)).toEqual(["omp:parent"]);
    expect(a.sessions[0]).toMatchObject({ subagents: 1, tokens: 50, cost: 2, toolCalls: 1, fileCount: 1 });
    expect(a.sessions[0].files).toEqual(["src/sub.ts"]);
    // The parent's own prompt was yesterday, so the day lists none.
    expect(a.sessions[0].promptCount).toBe(0);
    expect(a.prompts).toBe(0);
  });

  it("summarizes the day's prompts, tools and changed files", () => {
    insertSession(db, "omp:work", { startedAt: at(8), endedAt: at(12) });
    insertEvents(db, "omp:work", [
      { ts: at(8), kind: "user", text: "  fix   the parser  " },
      { ts: at(8, 1), kind: "tool_call", tool: "Read", input: { file_path: "/work/proj/src/parser.ts" } },
      { ts: at(8, 2), kind: "tool_call", tool: "Edit", input: { file_path: "/work/proj/src/parser.ts" } },
      { ts: at(8, 3), kind: "tool_call", tool: "Edit", input: { file_path: "/work/proj/src/lexer.ts" } },
      { ts: at(8, 4), kind: "tool_call", tool: "Bash", input: { command: "pnpm test" } },
      { ts: at(9), kind: "user", text: "now the tests" },
      // Next day: not part of this day's summary.
      { ts: dayStart(NEXT) + MIN, kind: "user", text: "tomorrow" },
    ]);

    const s = dayActivity(db, {}, DAY, 8, "/home/me").sessions[0];
    expect(s.prompts.map((p) => p.text)).toEqual(["fix the parser", "now the tests"]);
    expect(s.prompts.map((p) => p.seq)).toEqual([0, 5]);
    expect(s.promptCount).toBe(2);
    expect(s.toolCalls).toBe(4);
    expect(s.tools).toEqual([
      { tool: "Edit", calls: 2 },
      { tool: "Bash", calls: 1 },
      { tool: "Read", calls: 1 },
    ]);
    // Only changed files, shown relative to the session's directory; the read does not count.
    expect(s.files).toEqual(["src/lexer.ts", "src/parser.ts"]);
    expect(s.fileCount).toBe(2);
    expect([s.start, s.end]).toEqual([at(8), at(9)]);
  });

  it("applies the page filters to the day", () => {
    insertSession(db, "omp:keep", { startedAt: at(1), endedAt: at(2) });
    insertUsage(db, "omp:keep", [{ ts: at(1), tokens: 10, cost: 1 }]);
    insertSession(db, "claude:drop", { startedAt: at(1), endedAt: at(2) });
    insertUsage(db, "claude:drop", [{ ts: at(1), tokens: 99, cost: 9 }]);

    const a = dayActivity(db, { source: "omp" }, DAY, 8, "/home/me");
    expect(a.sessions.map((s) => s.id)).toEqual(["omp:keep"]);
    expect(a).toMatchObject({ total: 1, tokens: 10, cost: 1 });
  });

  it("marks a day whose requests could not all be priced", () => {
    insertSession(db, "omp:mixed", { startedAt: at(1), endedAt: at(2) });
    insertUsage(db, "omp:mixed", [
      { ts: at(1), tokens: 10, cost: 1, source: "reported" },
      { ts: at(2), tokens: 10, cost: null, source: "unpriced" },
    ]);
    const a = dayActivity(db, {}, DAY, 8, "/home/me");
    expect(a.costSource).toBe("partial");
    expect(a.sessions[0].costSource).toBe("partial");
    expect(a.sessions[0].cost).toBe(1);
  });

  it("reports an empty day without failing", () => {
    const a = dayActivity(db, {}, DAY, 8, "/home/me");
    expect(a).toMatchObject({ day: DAY, from: start, to: end, total: 0, tokens: 0, cost: null, requests: 0, prompts: 0 });
    expect(a.sessions).toEqual([]);
  });
});
