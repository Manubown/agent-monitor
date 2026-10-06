import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildHeatmap, HEATMAP_WEEKS, heatLevels, heatmapStart, localDay, weekdayOf } from "../src/core/heatmap";
import { type Db, openDb } from "../src/store/db";
import { activityHeatmap } from "../src/store/insights";

const DAY = 86400_000;

describe("buildHeatmap", () => {
  it("pads the range to whole Monday-first weeks", () => {
    // 2026-10-01 is a Thursday, 2026-10-06 a Tuesday.
    const h = buildHeatmap([], [], "2026-10-01", "2026-10-06");
    expect(h.weeks).toBe(2);
    expect(h.days[0]).toMatchObject({ day: "2026-09-28", weekday: 0, inRange: false });
    expect(h.days[3]).toMatchObject({ day: "2026-10-01", weekday: 3, inRange: true });
    expect(h.days[8]).toMatchObject({ day: "2026-10-06", weekday: 1, inRange: true });
    expect(h.days[13]).toMatchObject({ day: "2026-10-11", weekday: 6, inRange: false });
  });

  it("never skips or repeats a day across DST changes", () => {
    const h = buildHeatmap([], [], "2026-03-25", "2026-11-04");
    const days = h.days.map((d) => d.day);
    expect(new Set(days).size).toBe(days.length);
    expect(days).toContain("2026-03-29");
    expect(days).toContain("2026-10-25");
    expect(h.days.every((d) => d.weekday === weekdayOf(d.day))).toBe(true);
  });

  it("sums events per day and hour and counts distinct sessions", () => {
    const h = buildHeatmap(
      [
        { slot: "2026-10-04 10", root: "a", events: 1 },
        { slot: "2026-10-04 10", root: "b", events: 1 },
        { slot: "2026-10-04 23", root: "a", events: 2 },
        { slot: "2026-10-05 00", root: "a", events: 3 },
        { slot: "2026-09-01 00", root: "c", events: 9 }, // before the range
      ],
      [
        { slot: "2026-10-04 10", cost: 0.5 },
        { slot: "2026-10-04 23", cost: null }, // unpriced stays unpriced
        { slot: "2026-10-05 00", cost: 0.25 },
      ],
      "2026-10-01",
      "2026-10-06",
    );
    const sun = h.days.find((d) => d.day === "2026-10-04")!;
    const mon = h.days.find((d) => d.day === "2026-10-05")!;
    expect(sun).toMatchObject({ weekday: 6, events: 4, sessions: 2, cost: 0.5 });
    expect(mon).toMatchObject({ weekday: 0, events: 3, sessions: 1, cost: 0.25 });
    expect(h.days.find((d) => d.day === "2026-10-02")).toMatchObject({ events: 0, sessions: 0, cost: null });
    expect(h.hours.events[6 * 24 + 10]).toBe(2);
    expect(h.hours.sessions[6 * 24 + 10]).toBe(2);
    expect(h.hours.events[6 * 24 + 23]).toBe(2);
    expect(h.hours.cost[6 * 24 + 23]).toBeNull();
    expect(h.hours.events[0]).toBe(3);
    expect(h.totals).toEqual({ events: 7, sessions: 2, cost: 0.75 });
  });
});

describe("heatLevels", () => {
  it("keeps zero and missing at level 0 and gives the maximum the top level", () => {
    expect(heatLevels([0, null, 1, 2, 3, 4])).toEqual([0, 0, 1, 2, 3, 4]);
    expect(heatLevels([5, 5])).toEqual([4, 4]);
    expect(heatLevels([0, 0])).toEqual([0, 0]);
  });

  it("uses quantiles, so one outlier does not flatten the rest", () => {
    expect(heatLevels([1, 2, 3, 4, 1000])).toEqual([1, 2, 3, 4, 4]);
  });
});

describe("heatmapStart", () => {
  it("uses the range start when there is one", () => {
    expect(heatmapStart(123, 456)).toBe(123);
  });

  it("starts unbounded ranges at local midnight on a Monday, HEATMAP_WEEKS weeks back", () => {
    const now = new Date(2026, 9, 7, 15, 30).getTime(); // a Wednesday
    const start = new Date(heatmapStart(undefined, now));
    expect(start.getDay()).toBe(1);
    expect([start.getHours(), start.getMinutes()]).toEqual([0, 0]);
    const weeks = Math.round((new Date(2026, 9, 5).getTime() - start.getTime()) / DAY) / 7;
    expect(weeks).toBe(HEATMAP_WEEKS - 1);
  });
});

function insertSession(db: Db, id: string, opts: { parentId?: string; source?: string } = {}): void {
  const [source, nativeId] = id.split(":");
  db.prepare(
    `INSERT INTO sessions (id, source, native_id, parent_id, file_path, title, cwd, git_branch, agent_version, models,
       started_at, ended_at, event_count, user_messages, tool_calls, tool_errors, errors, requests,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, cost_source, events_hash)
     VALUES (?, ?, ?, ?, ?, ?, '/work/proj', NULL, NULL, '[]', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 'none', '')`,
  ).run(id, opts.source ?? source, nativeId, opts.parentId ?? null, `/logs/${nativeId}.jsonl`, nativeId);
}

const insertEvent = (db: Db, sessionId: string, seq: number, ts: number) =>
  db.prepare("INSERT INTO events (session_id, seq, ts, kind) VALUES (?, ?, ?, 'assistant')").run(sessionId, seq, ts);

const insertUsage = (db: Db, sessionId: string, seq: number, ts: number, cost: number | null) =>
  db
    .prepare(
      `INSERT INTO usage (session_id, seq, ts, model, input, output, cache_read, cache_write, reasoning, cost_usd, cost_source)
       VALUES (?, ?, ?, 'm', 1, 1, 0, 0, 0, ?, ?)`,
    )
    .run(sessionId, seq, ts, cost, cost === null ? "unpriced" : "estimated");

// A zone with a half-hour offset, so a bucket computed in UTC (or whole-hour offsets) would land on the wrong day or hour.
// Worker-thread pools ignore TZ changes for both JS and SQLite alike; expectations come from local Date either way.
describe("activityHeatmap", () => {
  const savedTz = process.env.TZ;
  let db: Db;
  beforeAll(() => {
    process.env.TZ = "Asia/Kolkata";
  });
  afterAll(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });
  beforeEach(() => {
    db = openDb(":memory:");
    insertSession(db, "omp:a");
    insertSession(db, "omp:sub", { parentId: "omp:a" });
    insertSession(db, "codex:b");
  });

  it("buckets by local day and hour, matching the JS local calendar at midnight", () => {
    const lateSunday = new Date(2026, 9, 4, 23, 59).getTime();
    const earlyMonday = new Date(2026, 9, 5, 0, 1).getTime();
    insertEvent(db, "omp:a", 1, lateSunday);
    insertEvent(db, "omp:sub", 1, earlyMonday);
    insertEvent(db, "omp:a", 2, earlyMonday);
    insertUsage(db, "omp:a", 1, lateSunday, 0.5);
    insertUsage(db, "omp:a", 2, earlyMonday, null);
    const now = new Date(2026, 9, 6, 12).getTime();
    const h = activityHeatmap(db, { from: new Date(2026, 9, 1).getTime() }, now);

    expect([h.firstDay, h.lastDay]).toEqual(["2026-10-01", localDay(now)]);
    const sun = h.days.find((d) => d.day === "2026-10-04")!;
    const mon = h.days.find((d) => d.day === "2026-10-05")!;
    expect(sun).toMatchObject({ events: 1, sessions: 1, cost: 0.5 });
    // The subagent's event counts toward its parent's session.
    expect(mon).toMatchObject({ events: 2, sessions: 1, cost: null });
    expect(h.hours.events[6 * 24 + 23]).toBe(1);
    expect(h.hours.events[0 * 24 + 0]).toBe(2);
  });

  it("respects the time and source filters", () => {
    const now = new Date(2026, 9, 6, 12).getTime();
    insertEvent(db, "omp:a", 1, new Date(2026, 8, 30, 12).getTime()); // before the range
    insertEvent(db, "omp:a", 2, new Date(2026, 9, 2, 12).getTime());
    insertEvent(db, "codex:b", 1, new Date(2026, 9, 2, 13).getTime());
    insertUsage(db, "codex:b", 1, new Date(2026, 9, 2, 13).getTime(), 2);
    const from = new Date(2026, 9, 1).getTime();

    expect(activityHeatmap(db, { from }, now).totals).toEqual({ events: 2, sessions: 2, cost: 2 });
    expect(activityHeatmap(db, { from, source: "omp" }, now).totals).toEqual({ events: 1, sessions: 1, cost: null });
    expect(activityHeatmap(db, { from, source: "codex" }, now).days.find((d) => d.day === "2026-10-02")).toMatchObject({ events: 1, sessions: 1, cost: 2 });
  });

  it("covers the last HEATMAP_WEEKS weeks when the range is unbounded", () => {
    const now = new Date(2026, 9, 7, 12).getTime();
    insertEvent(db, "omp:a", 1, new Date(2025, 0, 1).getTime()); // long ago: outside the window
    insertEvent(db, "omp:a", 2, new Date(2026, 9, 6, 9).getTime());
    const h = activityHeatmap(db, {}, now);
    expect(h.weeks).toBe(HEATMAP_WEEKS);
    expect(h.totals.events).toBe(1);
  });
});
