import { beforeEach, describe, expect, it } from "vitest";
import { csvField, toCsv } from "../app/api/export/csv";
import { claudeCodeAdapter } from "../src/adapters/claude-code";
import { codexAdapter } from "../src/adapters/codex";
import { ompAdapter } from "../src/adapters/omp";
import { type Db, openDb } from "../src/store/db";
import {
  ACTIVE_WINDOW_MS,
  activeSessions,
  allTags,
  byModel,
  claudeUsage,
  eventTimeline,
  getSession,
  listSessions,
  normalizeTag,
  overview,
  sessionEvents,
  sessionEventTimeline,
  TIMELINE_PAGE,
  timelinePage,
  timelineWindow,
  parseTimelineKinds,
} from "../src/store/queries";

const T = Date.UTC(2026, 9, 1, 12); // range start used by the time-filter tests
const H = 3600_000;

interface SessionSpec {
  id: string;
  parentId?: string;
  startedAt: number;
  endedAt: number;
  source?: string;
  title?: string;
}

function insertSession(db: Db, s: SessionSpec): void {
  const [source, nativeId] = s.id.split(":");
  db.prepare(
    `INSERT INTO sessions (id, source, native_id, parent_id, file_path, title, cwd, git_branch, agent_version, models,
       started_at, ended_at, event_count, user_messages, tool_calls, tool_errors, errors, requests,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, cost_source, events_hash)
     VALUES (?, ?, ?, ?, ?, ?, '/work/proj', NULL, NULL, '[]', ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 'none', '')`,
  ).run(s.id, s.source ?? source, nativeId, s.parentId ?? null, `/logs/${nativeId}.jsonl`, s.title ?? nativeId, s.startedAt, s.endedAt);
}

function insertUsage(db: Db, sessionId: string, seq: number, ts: number, model: string, output: number, cost: number | null = null): void {
  db.prepare(
    `INSERT INTO usage (session_id, seq, ts, model, input, output, cache_read, cache_write, reasoning, cost_usd, cost_source)
     VALUES (?, ?, ?, ?, 10, ?, 0, 0, 0, ?, ?)`,
  ).run(sessionId, seq, ts, model, output, cost, cost === null ? "unpriced" : "estimated");
}

function insertEvent(db: Db, sessionId: string, seq: number, ts: number, kind: string, toolName?: string): void {
  db.prepare("INSERT INTO events (session_id, seq, ts, kind, tool_name) VALUES (?, ?, ?, ?, ?)").run(sessionId, seq, ts, kind, toolName ?? null);
}

const tag = (db: Db, sessionId: string, t: string) =>
  db.prepare("INSERT INTO user.tags (session_id, tag, created_at) VALUES (?, ?, 0)").run(sessionId, t);

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("listSessions time filter", () => {
  beforeEach(() => {
    insertSession(db, { id: "omp:spans", startedAt: T - 10 * H, endedAt: T + H });
    insertSession(db, { id: "omp:before", startedAt: T - 10 * H, endedAt: T - H });
    insertSession(db, { id: "omp:parent", startedAt: T - 6 * H, endedAt: T - 5 * H });
    insertSession(db, { id: "omp:child", parentId: "omp:parent", startedAt: T - 5 * H, endedAt: T + 2 * H });
  });

  it("lists sessions active in the range, including ones started before it", () => {
    const { rows, total } = listSessions(db, { from: T }, { limit: 50, offset: 0 });
    expect(ids(rows)).toEqual(["omp:parent", "omp:spans"]);
    expect(total).toBe(2);
  });

  it("keeps a parent in range through its subagent's activity and rolls the subagent in", () => {
    const parent = listSessions(db, { from: T }, { limit: 50, offset: 0 }).rows.find((r) => r.id === "omp:parent");
    expect(parent?.subagents).toBe(1);
    expect(parent?.total.lastActive).toBe(T + 2 * H);
  });

  it("drops sessions that ended before the range", () => {
    expect(ids(listSessions(db, { from: T }, { limit: 50, offset: 0 }).rows)).not.toContain("omp:before");
    expect(ids(listSessions(db, {}, { limit: 50, offset: 0 }).rows)).toContain("omp:before");
  });

  it("pages through a total order without overlap, ties broken by id", () => {
    insertSession(db, { id: "omp:tie-b", startedAt: T, endedAt: T + 3 * H });
    insertSession(db, { id: "omp:tie-a", startedAt: T, endedAt: T + 3 * H });
    const pages = [0, 1, 2, 3].map((offset) => ids(listSessions(db, { from: T }, { limit: 1, offset }).rows));
    expect(pages).toEqual([["omp:tie-a"], ["omp:tie-b"], ["omp:parent"], ["omp:spans"]]);
    expect(listSessions(db, { from: T }, { limit: -1, offset: 0 }).rows).toHaveLength(4);
  });
});

describe("listSessions sort", () => {
  const set = (id: string, cols: Record<string, number | null>) =>
    db.prepare(`UPDATE sessions SET ${Object.keys(cols).map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(cols), id);

  beforeEach(() => {
    // "big-tree" is small on its own but its subagent makes it the largest tree on every measure.
    insertSession(db, { id: "omp:big-tree", startedAt: T, endedAt: T + H });
    insertSession(db, { id: "omp:big-sub", parentId: "omp:big-tree", startedAt: T, endedAt: T + 9 * H });
    insertSession(db, { id: "omp:mid", startedAt: T, endedAt: T + 4 * H });
    insertSession(db, { id: "omp:unpriced", startedAt: T, endedAt: T + 2 * H });
    set("omp:big-tree", { cost_usd: 1, input_tokens: 10, output_tokens: 10, requests: 1, tool_calls: 1, errors: 0, tool_errors: 1 });
    set("omp:big-sub", { cost_usd: 9, input_tokens: 500, cache_read_tokens: 500, requests: 20, tool_calls: 30, errors: 2, tool_errors: 3 });
    set("omp:mid", { cost_usd: 5, input_tokens: 300, output_tokens: 100, requests: 8, tool_calls: 12, errors: 1, tool_errors: 1 });
    set("omp:unpriced", { input_tokens: 50, requests: 2, tool_calls: 2 });
  });

  const order = (sort?: Parameters<typeof listSessions>[3]) => ids(listSessions(db, {}, { limit: -1, offset: 0 }, sort).rows);

  it("ranks by the totals of the whole session tree, highest first", () => {
    for (const sort of ["cost", "tokens", "requests", "tools", "errors", "duration"] as const) {
      expect(order(sort), sort).toEqual(["omp:big-tree", "omp:mid", "omp:unpriced"]);
    }
  });

  it("defaults to most recently active first, counting subagent activity", () => {
    set("omp:mid", { ended_at: T + 10 * H });
    expect(order()).toEqual(["omp:mid", "omp:big-tree", "omp:unpriced"]);
    expect(order("recent")).toEqual(order());
  });

  it("puts sessions without a cost after priced ones", () => {
    set("omp:mid", { cost_usd: 0 });
    expect(order("cost")).toEqual(["omp:big-tree", "omp:mid", "omp:unpriced"]);
  });

  it("breaks ties by last activity, then id, so pages never overlap", () => {
    insertSession(db, { id: "omp:tie-b", startedAt: T, endedAt: T + 3 * H });
    insertSession(db, { id: "omp:tie-a", startedAt: T, endedAt: T + 3 * H });
    insertSession(db, { id: "omp:tie-late", startedAt: T, endedAt: T + 5 * H });
    for (const id of ["omp:tie-a", "omp:tie-b", "omp:tie-late"]) set(id, { cost_usd: 5 });
    const expected = ["omp:big-tree", "omp:tie-late", "omp:mid", "omp:tie-a", "omp:tie-b", "omp:unpriced"];
    expect(order("cost")).toEqual(expected);
    const pages = expected.map((_, offset) => ids(listSessions(db, {}, { limit: 1, offset }, "cost").rows));
    expect(pages.flat()).toEqual(expected);
    expect(listSessions(db, {}, { limit: 2, offset: 0 }, "cost").total).toBe(6);
  });
});

describe("tags", () => {
  beforeEach(() => {
    insertSession(db, { id: "omp:a", startedAt: T, endedAt: T + H });
    insertSession(db, { id: "omp:a-sub", parentId: "omp:a", startedAt: T, endedAt: T + H });
    insertSession(db, { id: "omp:b", startedAt: T, endedAt: T + H });
    insertUsage(db, "omp:a", 0, T, "claude-opus-5-5", 100, 1);
    insertUsage(db, "omp:a-sub", 0, T, "claude-haiku-4-5", 50, 0.5);
    insertUsage(db, "omp:b", 0, T, "claude-opus-5-5", 1000, 10);
    tag(db, "omp:a", "bug");
    tag(db, "omp:a", "auth/login");
    tag(db, "omp:b", "bug");
  });

  it("filters sessions by tag", () => {
    tag(db, "omp:b", "perf");
    expect(ids(listSessions(db, { tag: "perf" }, { limit: 50, offset: 0 }).rows)).toEqual(["omp:b"]);
    expect(ids(listSessions(db, { tag: "bug" }, { limit: 50, offset: 0 }).rows).sort()).toEqual(["omp:a", "omp:b"]);
    expect(listSessions(db, { tag: "nope" }, { limit: 50, offset: 0 }).total).toBe(0);
  });

  it("counts a tagged session's subagents in usage queries", () => {
    const o = overview(db, { tag: "auth/login" });
    expect(o.output).toBe(150);
    expect(o.cost).toBeCloseTo(1.5);
    expect(byModel(db, { tag: "auth/login" }).map((m) => m.model).sort()).toEqual(["claude-haiku-4-5", "claude-opus-5-5"]);
  });

  it("exposes tags on summaries, alphabetically, and counts them", () => {
    expect(getSession(db, "omp:a")?.session.tags).toEqual(["auth/login", "bug"]);
    expect(allTags(db)).toEqual([
      { tag: "bug", count: 2, auto: false },
      { tag: "auth/login", count: 1, auto: false },
    ]);
  });

  it("normalizes and validates tag input", () => {
    expect(normalizeTag("  #Bug-Fix ")).toBe("bug-fix");
    expect(normalizeTag("##area/ui_x")).toBe("area/ui_x");
    expect(normalizeTag("a".repeat(40))).toBe("a".repeat(40));
    expect(normalizeTag("a".repeat(41))).toBeNull();
    expect(normalizeTag("")).toBeNull();
    expect(normalizeTag("#")).toBeNull();
    expect(normalizeTag("-lead")).toBeNull();
    expect(normalizeTag("two words")).toBeNull();
    expect(normalizeTag("emoji✓")).toBeNull();
  });
});

describe("activeSessions", () => {
  const now = T;

  it("includes trees whose last activity is within the window, inclusive", () => {
    insertSession(db, { id: "omp:edge", startedAt: now - H, endedAt: now - ACTIVE_WINDOW_MS });
    insertSession(db, { id: "omp:stale", startedAt: now - H, endedAt: now - ACTIVE_WINDOW_MS - 1 });
    expect(ids(activeSessions(db, now))).toEqual(["omp:edge"]);
  });

  it("is kept active by a subagent and reports the tree's latest event and model", () => {
    insertSession(db, { id: "omp:main", startedAt: now - H, endedAt: now - 10 * 60_000 });
    insertSession(db, { id: "omp:main-sub", parentId: "omp:main", startedAt: now - 5 * 60_000, endedAt: now - 12_000 });
    insertEvent(db, "omp:main", 0, now - 10 * 60_000, "tool_call", "Task");
    insertEvent(db, "omp:main-sub", 0, now - 20_000, "tool_call", "Read");
    insertEvent(db, "omp:main-sub", 1, now - 12_000, "tool_call", "Bash");
    insertUsage(db, "omp:main", 0, now - 20 * 60_000, "claude-haiku-4-5", 1);
    insertUsage(db, "omp:main", 1, now - 10 * 60_000, "claude-opus-5-5", 1);

    const [s] = activeSessions(db, now);
    expect(s.id).toBe("omp:main");
    expect(s.subagents).toBe(1);
    expect(s.lastEvent).toEqual({ kind: "tool_call", toolName: "Bash", ts: now - 12_000 });
    expect(s.currentModel).toBe("claude-opus-5-5");
    expect(activeSessions(db, now - 12_000 + ACTIVE_WINDOW_MS + 1)).toEqual([]);
  });
});

describe("event timelines", () => {
  beforeEach(() => {
    insertSession(db, { id: "omp:main", startedAt: T, endedAt: T + 2 * H, source: "omp" });
    insertSession(db, { id: "omp:main-sub", parentId: "omp:main", startedAt: T + H, endedAt: T + 2 * H });
    insertSession(db, { id: "codex:other", startedAt: T, endedAt: T + H });
    insertEvent(db, "omp:main", 0, T, "user");
    insertEvent(db, "omp:main", 1, T + 30 * 60_000, "tool_call", "Read");
    insertEvent(db, "omp:main-sub", 0, T + 2 * H - 1, "tool_call", "Bash");
    insertEvent(db, "codex:other", 0, T + 10 * 60_000, "assistant");
  });

  it("counts filtered events in hourly bins over a 7-day range", () => {
    const to = T + 7 * 24 * H;
    const t = eventTimeline(db, { from: T, source: "omp" }, to);
    expect(t).toMatchObject({ from: T, to, binMs: H });
    expect(t.counts).toHaveLength(168);
    expect(t.counts.slice(0, 3)).toEqual([2, 1, 0]);
    expect(t.counts.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("starts an unbounded range at the first matching event", () => {
    const t = eventTimeline(db, {}, T + 24 * H);
    expect(t.from).toBe(T);
    expect(t.binMs).toBe(10 * 60_000);
    expect(t.counts[0]).toBe(1);
    expect(t.counts[1]).toBe(1);
    expect(t.counts.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("covers a session tree over its own span, subagents included", () => {
    const t = sessionEventTimeline(db, "omp:main");
    expect(t).toMatchObject({ from: T, to: T + 2 * H, binMs: 30_000 });
    expect(t?.counts).toHaveLength(240);
    expect([t?.counts[0], t?.counts[60], t?.counts[239]]).toEqual([1, 1, 1]);
    expect(sessionEventTimeline(db, "omp:missing")).toBeNull();
  });
});

describe("claudeUsage", () => {
  it("keeps Claude models only, attributed to the top-level session", () => {
    insertSession(db, { id: "omp:root", startedAt: T, endedAt: T + H, title: "Root" });
    insertSession(db, { id: "omp:root-sub", parentId: "omp:root", startedAt: T, endedAt: T + H });
    insertUsage(db, "omp:root", 0, T, "anthropic/claude-opus-5-5", 1);
    insertUsage(db, "omp:root-sub", 0, T + 1, "us.anthropic.claude-haiku-4-5-v1:0", 1);
    insertUsage(db, "omp:root", 1, T + 2, "gpt-5.5", 1);
    insertUsage(db, "omp:root", 2, T + 3, "not-claude-but-says-claude", 1);
    const rows = claudeUsage(db, {});
    expect(rows.map((r) => [r.model, r.sessionId, r.title])).toEqual([
      ["anthropic/claude-opus-5-5", "omp:root", "Root"],
      ["us.anthropic.claude-haiku-4-5-v1:0", "omp:root", "Root"],
    ]);
  });
});

describe("getSession root", () => {
  it("resolves the top-level ancestor of nested subagents", () => {
    insertSession(db, { id: "omp:top", startedAt: T, endedAt: T + H });
    insertSession(db, { id: "omp:mid", parentId: "omp:top", startedAt: T, endedAt: T + H });
    insertSession(db, { id: "omp:leaf", parentId: "omp:mid", startedAt: T, endedAt: T + H });
    expect(getSession(db, "omp:leaf")?.root).toMatchObject({ id: "omp:top", nativeId: "top", filePath: "/logs/top.jsonl" });
    expect(getSession(db, "omp:top")?.root.id).toBe("omp:top");
  });
});

describe("parent cycles", () => {
  // A malformed log can make two sessions each other's parent; tree queries must stop instead of recursing forever.
  beforeEach(() => {
    insertSession(db, { id: "omp:a", parentId: "omp:b", startedAt: T, endedAt: T + H });
    insertSession(db, { id: "omp:b", parentId: "omp:a", startedAt: T, endedAt: T + H });
    insertSession(db, { id: "omp:live", startedAt: T, endedAt: T + H });
    insertEvent(db, "omp:a", 0, T, "user_message");
    insertEvent(db, "omp:b", 0, T + 1, "tool_call", "bash");
  });

  it("returns a session inside a cycle, counting each member once", { timeout: 2000 }, () => {
    const detail = getSession(db, "omp:a");
    expect(detail?.session.subagents).toBe(1);
    expect(ids(detail?.children ?? [])).toEqual(["omp:b"]);
    expect(sessionEventTimeline(db, "omp:a")).not.toBeNull();
  });

  it("lists active trees without walking into the cycle", { timeout: 2000 }, () => {
    expect(ids(activeSessions(db, T + H))).toEqual(["omp:live"]);
  });
});

describe("resume commands", () => {
  it("builds each tool's resume command with POSIX quoting", () => {
    expect(claudeCodeAdapter.resumeCommand?.({ nativeId: "abc-123", cwd: "/home/me/My Project", filePath: "/x.jsonl" })).toBe(
      "cd '/home/me/My Project' && claude --resume abc-123",
    );
    expect(ompAdapter.resumeCommand?.({ nativeId: "id1", cwd: "/w/it's", filePath: "/home/me/.omp/agent/sessions/-w/2026_id1.jsonl" })).toBe(
      "cd '/w/it'\\''s' && omp --resume /home/me/.omp/agent/sessions/-w/2026_id1.jsonl",
    );
    expect(codexAdapter.resumeCommand?.({ nativeId: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", cwd: "/w", filePath: "/r.jsonl" })).toBe(
      "cd /w && codex resume 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    );
    expect(claudeCodeAdapter.resumeCommand?.({ nativeId: "x", filePath: "/x.jsonl" })).toBe("claude --resume x");
    expect(codexAdapter.resumeCommand?.({ nativeId: "rollout-2026-10-01T12-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", filePath: "/r.jsonl" })).toBe(
      "codex resume 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    );
  });

  it("returns nothing for subagents", () => {
    const sub = { nativeId: "p/agent-1", parentNativeId: "p", cwd: "/w", filePath: "/s.jsonl" };
    expect(claudeCodeAdapter.resumeCommand?.(sub)).toBeUndefined();
    expect(ompAdapter.resumeCommand?.(sub)).toBeUndefined();
    expect(codexAdapter.resumeCommand?.(sub)).toBeUndefined();
  });
});

describe("CSV export", () => {
  it("quotes per RFC 4180 with CRLF line ends", () => {
    expect(toCsv(["a", "b"], [["x,y", 'say "hi"'], ["line\nbreak", "cr\rhere"], [null, 3]])).toBe(
      'a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak","cr\rhere"\r\n,3\r\n',
    );
  });

  it("neutralizes formula injection in text but not in numbers", () => {
    expect(csvField("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("-cmd")).toBe("'-cmd");
    expect(csvField("@x")).toBe("'@x");
    expect(csvField('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvField(-12.5)).toBe("-12.5");
    expect(csvField("plain")).toBe("plain");
    expect(csvField(undefined)).toBe("");
  });
});

describe("timeline paging", () => {
  it("defaults to the newest page and follows the session as it grows", () => {
    expect(timelineWindow(1000, {})).toEqual({ from: 1000 - TIMELINE_PAGE, to: 1000, total: 1000, tail: true });
    expect(timelineWindow(50, {})).toEqual({ from: 0, to: 50, total: 50, tail: true });
    expect(timelineWindow(0, {})).toEqual({ from: 0, to: 0, total: 0, tail: true });
  });

  it("centers a page on a search hit, clamped to the session", () => {
    expect(timelineWindow(1000, { at: 500 })).toEqual({ from: 500 - TIMELINE_PAGE / 2, to: 500 + TIMELINE_PAGE / 2, total: 1000, tail: false });
    expect(timelineWindow(1000, { at: 3 })).toMatchObject({ from: 0, to: TIMELINE_PAGE, tail: false });
    expect(timelineWindow(1000, { at: 999 })).toMatchObject({ from: 1000 - TIMELINE_PAGE, to: 1000, tail: true });
    // A hit beyond the end (stale link) falls back to the newest page.
    expect(timelineWindow(100, { at: 400 })).toMatchObject({ from: 0, to: 100, tail: true });
  });

  it("honors explicit ranges and clamps them", () => {
    expect(timelineWindow(1000, { from: 400 })).toEqual({ from: 400, to: 1000, total: 1000, tail: true });
    expect(timelineWindow(1000, { from: 400, to: 600 })).toEqual({ from: 400, to: 600, total: 1000, tail: false });
    expect(timelineWindow(1000, { from: 900, to: 5000 })).toMatchObject({ from: 900, to: 1000 });
    expect(timelineWindow(1000, { from: 700, to: 600 })).toMatchObject({ from: 600, to: 600 });
  });

  it("loads exactly the requested slice of events", () => {
    const db = openDb(":memory:");
    insertSession(db, { id: "omp:big", startedAt: T, endedAt: T + H });
    const insert = db.prepare("INSERT INTO events (session_id, seq, ts, kind, text) VALUES ('omp:big', ?, ?, 'assistant', ?)");
    for (let seq = 0; seq < 10; seq++) insert.run(seq, T + seq, `e${seq}`);
    expect(sessionEvents(db, "omp:big", 3, 6).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(sessionEvents(db, "omp:big", 8).map((e) => e.seq)).toEqual([8, 9]);
    expect(getSession(db, "omp:big")?.timelineCounts).toEqual({ user: 0, assistant: 10, thinking: 0, tools: 0, system: 0, error: 0 });
  });

  it("pages over the events of the selected types only", () => {
    const db = openDb(":memory:");
    insertSession(db, { id: "omp:mix", startedAt: T, endedAt: T + H });
    const insert = db.prepare("INSERT INTO events (session_id, seq, ts, kind, text, is_error) VALUES ('omp:mix', ?, ?, ?, ?, ?)");
    // Three replies early on, then far more than a page of tool traffic with one failure.
    for (let seq = 0; seq < 3; seq++) insert.run(seq, T + seq, "assistant", `reply ${seq}`, 0);
    for (let seq = 3; seq < 3 + 2 * TIMELINE_PAGE; seq++) insert.run(seq, T + seq, seq % 2 ? "tool_call" : "tool_result", null, seq === 100 ? 1 : 0);

    const replies = timelinePage(db, "omp:mix", { kinds: ["assistant"] });
    expect(replies.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(replies).toMatchObject({ from: 0, to: 3, total: 3, tail: true });

    // "error" covers failed tool results even with the tools chip off.
    expect(timelinePage(db, "omp:mix", { kinds: ["error"] }).events.map((e) => e.seq)).toEqual([100]);
    expect(getSession(db, "omp:mix")?.timelineCounts).toMatchObject({ assistant: 3, tools: TIMELINE_PAGE, error: 1 });

    // A hit of a hidden type stays listed and the page is centered on it among the matches.
    const hit = timelinePage(db, "omp:mix", { kinds: ["assistant"], at: 250 });
    expect(hit.events.map((e) => e.seq)).toEqual([0, 1, 2, 250]);
    // Paging around a hit keeps the explicit range.
    expect(timelinePage(db, "omp:mix", { kinds: ["tools"], at: 250, from: 0, to: 5 }).events.map((e) => e.seq)).toEqual([3, 4, 5, 6, 7]);
    expect(timelinePage(db, "omp:mix", { kinds: [] }).events).toEqual([]);
  });

  it("reads the kinds parameter", () => {
    expect(parseTimelineKinds(undefined)).toEqual(["user", "assistant", "tools", "error"]);
    expect(parseTimelineKinds("")).toEqual([]);
    expect(parseTimelineKinds("error,bogus,user")).toEqual(["user", "error"]);
  });
});
