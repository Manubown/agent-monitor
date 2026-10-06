import { beforeEach, describe, expect, it } from "vitest";
import { callEnds, costLayout, dominantBand, issuedBy, mergeThin, packTracks, subtreeCosts, subtreeEnd } from "../app/components/graph/flameLayout";
import { sessionActivity } from "../src/store/activity";
import { type Db, openDb } from "../src/store/db";
import { sessionFlame } from "../src/store/flame";

const T = Date.UTC(2026, 9, 1, 12);

// root(0) -> a(1) -> a1(2); root -> b(3)
const TREE = [
  { parent: null, depth: 0 },
  { parent: 0, depth: 1 },
  { parent: 1, depth: 2 },
  { parent: 0, depth: 1 },
];

describe("callEnds", () => {
  it("ends at the result, else the agent's next call, else the agent's end", () => {
    const actions = [
      { agent: 0, ts: 10 },
      { agent: 0, ts: 20 },
      { agent: 1, ts: 15 },
      { agent: 0, ts: 30 },
    ];
    expect(callEnds(actions, [12, null, null, null], [50, 40])).toEqual([12, 30, 40, 50]);
  });

  it("never ends before the call", () => {
    expect(callEnds([{ agent: 0, ts: 10 }], [5], [8])).toEqual([10]);
  });
});

describe("packTracks", () => {
  it("reuses a track once it is free and opens new ones for overlaps", () => {
    const spans = [
      { start: 0, end: 10 },
      { start: 5, end: 8 },
      { start: 10, end: 12 },
      { start: 9, end: 11 },
    ];
    expect(packTracks(spans)).toEqual({ track: [0, 1, 0, 1], count: 2 });
  });

  it("keeps a gap between spans on one track", () => {
    expect(packTracks([{ start: 0, end: 10 }, { start: 11, end: 12 }], Number.POSITIVE_INFINITY, 2).track).toEqual([0, 1]);
  });

  it("caps the track count, overlapping on the track that frees up first", () => {
    const spans = [
      { start: 0, end: 100 },
      { start: 0, end: 5 },
      { start: 1, end: 3 },
    ];
    expect(packTracks(spans, 2)).toEqual({ track: [0, 1, 1], count: 2 });
  });
});

describe("subtrees and the cost layout", () => {
  it("finds the contiguous subtree of an agent", () => {
    expect(subtreeEnd(TREE, 0)).toBe(4);
    expect(subtreeEnd(TREE, 1)).toBe(3);
    expect(subtreeEnd(TREE, 3)).toBe(4);
  });

  it("sums costs up the tree, unpriced counting as nothing", () => {
    expect(subtreeCosts(TREE, [1, 2, null, 3])).toEqual([6, 2, 0, 3]);
  });

  it("splits each box among its children, then its own cost", () => {
    const boxes = costLayout(TREE, [2, 1, 1, 4], 0, 0, 80);
    expect(boxes).toEqual([
      { x0: 0, x1: 80, self: 60 },
      { x0: 0, x1: 20, self: 10 },
      { x0: 0, x1: 10, self: 0 },
      { x0: 20, x1: 60, self: 20 },
    ]);
  });

  it("lays out a zoomed subtree across the full width and leaves the rest out", () => {
    const boxes = costLayout(TREE, [2, 1, 1, 4], 1, 100, 50);
    expect(boxes).toEqual([null, { x0: 100, x1: 150, self: 125 }, { x0: 100, x1: 125, self: 100 }, null]);
  });

  it("gives unpriced agents zero width", () => {
    const boxes = costLayout(TREE, [null, null, null, null], 0, 0, 80);
    expect(boxes.map((b) => b && b.x1 - b.x0)).toEqual([0, 0, 0, 0]);
  });
});

describe("issuedBy", () => {
  it("attributes each call to the latest request of its agent at or before it", () => {
    const requests = [
      { agent: 0, ts: 10 },
      { agent: 0, ts: 20 },
      { agent: 1, ts: 5 },
    ];
    const actions = [
      { agent: 0, ts: 5 },
      { agent: 0, ts: 10 },
      { agent: 0, ts: 19 },
      { agent: 0, ts: 25 },
      { agent: 1, ts: 6 },
      { agent: 2, ts: 30 },
    ];
    expect(issuedBy(actions, requests)).toEqual([null, 0, 0, 1, 2, null]);
  });
});

describe("mergeThin", () => {
  it("keeps wide blocks and bins runs of thin ones", () => {
    const blocks = [
      { x0: 0, x1: 10, index: 0 },
      { x0: 10, x1: 10.2, index: 1 },
      { x0: 10.5, x1: 11, index: 2 },
      { x0: 12.9, x1: 13, index: 3 },
      { x0: 13.2, x1: 13.4, index: 4 },
      { x0: 20, x1: 25, index: 5 },
    ];
    expect(mergeThin(blocks)).toEqual([
      { x0: 0, x1: 10, items: [0] },
      { x0: 10, x1: 13, items: [1, 2, 3] },
      { x0: 13.2, x1: 13.4, items: [4] },
      { x0: 20, x1: 25, items: [5] },
    ]);
  });

  it("draws thousands of calls in one pixel as one bin", () => {
    const blocks = Array.from({ length: 5000 }, (_, i) => ({ x0: i / 5000, x1: (i + 1) / 5000, index: i }));
    const out = mergeThin(blocks);
    expect(out).toHaveLength(1);
    expect(out[0].items).toHaveLength(5000);
  });
});

describe("dominantBand", () => {
  it("shows failures, else the most common category, ties in legend order", () => {
    expect(dominantBand([])).toBeNull();
    expect(dominantBand(["read", "read", "error"])).toBe("error");
    expect(dominantBand(["shell", "read", "shell"])).toBe("shell");
    expect(dominantBand(["shell", "read"])).toBe("read");
  });
});

function insertSession(db: Db, id: string, opts: { parentId?: string; cost?: number | null; source?: string } = {}): void {
  const [source, nativeId] = id.split(":");
  db.prepare(
    `INSERT INTO sessions (id, source, native_id, parent_id, file_path, title, cwd, git_branch, agent_version, models,
       started_at, ended_at, event_count, user_messages, tool_calls, tool_errors, errors, requests,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, cost_source, events_hash)
     VALUES (?, ?, ?, ?, ?, ?, '/work', NULL, NULL, '[]', ?, ?, 0, 0, 0, 0, 0, 2, 10, 20, 30, 40, 0, ?, ?, '')`,
  ).run(id, source, nativeId, opts.parentId ?? null, `/logs/${nativeId}.jsonl`, nativeId, T, T, opts.cost ?? null, opts.source ?? "none");
}

function insertEvents(db: Db, sessionId: string, events: { ts: number; kind: string; tool?: string; callId?: string }[]): void {
  const stmt = db.prepare("INSERT INTO events (session_id, seq, ts, kind, tool_name, tool_call_id, tool_input) VALUES (?, ?, ?, ?, ?, ?, '{}')");
  events.forEach((e, seq) => stmt.run(sessionId, seq, e.ts, e.kind, e.tool ?? null, e.callId ?? null));
}

function insertUsage(db: Db, sessionId: string, rows: { ts: number; cost: number | null }[]): void {
  const stmt = db.prepare(
    "INSERT INTO usage (session_id, seq, ts, model, input, output, cache_read, cache_write, reasoning, cost_usd, cost_source) VALUES (?, ?, ?, 'm', 1, 2, 3, 4, 0, ?, ?)",
  );
  rows.forEach((r, seq) => stmt.run(sessionId, seq, r.ts, r.cost, r.cost === null ? "unpriced" : "reported"));
}

describe("sessionFlame", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("returns per-agent costs, result times and anchored requests aligned with the activity", () => {
    insertSession(db, "omp:root", { cost: 1.5, source: "reported" });
    insertSession(db, "omp:sub", { parentId: "omp:root" });
    insertEvents(db, "omp:root", [
      { ts: T, kind: "user" },
      { ts: T + 1000, kind: "tool_call", tool: "read", callId: "r1" },
      { ts: T + 1000, kind: "tool_call", tool: "bash", callId: "b1" },
      { ts: T + 1500, kind: "tool_result", tool: "bash", callId: "b1" },
      { ts: T + 4000, kind: "tool_result", tool: "read", callId: "r1" },
      { ts: T + 5000, kind: "tool_call", tool: "task" },
    ]);
    insertEvents(db, "omp:sub", [
      { ts: T + 6000, kind: "tool_call", tool: "grep" },
      { ts: T + 6200, kind: "tool_result", tool: "grep" },
    ]);
    insertUsage(db, "omp:root", [
      { ts: T + 1000, cost: 1 },
      { ts: T + 5000, cost: 0.5 },
    ]);
    insertUsage(db, "omp:sub", [{ ts: T + 7000, cost: null }]);

    const act = sessionActivity(db, "omp:root", "/home/me")!;
    const flame = sessionFlame(db, act);

    expect(flame.costs).toEqual([
      { cost: 1.5, costSource: "reported", tokens: 100, requests: 2 },
      { cost: null, costSource: "none", tokens: 100, requests: 2 },
    ]);
    const resultOf = (agent: number, tool: string) => flame.results[act.actions.findIndex((a) => a.agent === agent && a.tool === tool)];
    expect(resultOf(0, "read")).toBe(T + 4000);
    expect(resultOf(0, "bash")).toBe(T + 1500);
    expect(resultOf(0, "task")).toBeNull();
    // Paired by tool name when there is no call id.
    expect(resultOf(1, "grep")).toBe(T + 6200);

    expect(flame.requests.map((r) => [r.agent, r.cost, r.tokens, r.seq])).toEqual([
      [0, 1, 10, 1],
      [0, 0.5, 10, 5],
      // No event at or after the request: no anchor; unpriced stays null.
      [1, null, 10, null],
    ]);
  });
});
