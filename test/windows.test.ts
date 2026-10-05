import { describe, expect, it } from "vitest";
import { BLOCK_MS, burnRate, type UsageBlock, type UsageInput, usageBlocks } from "../src/core/windows";

const H = 3600_000;
const M = 60_000;
const DAY = Date.UTC(2026, 9, 1); // midnight UTC

const req = (ts: number, extra: Partial<UsageInput> = {}): UsageInput => ({
  ts,
  model: "claude-opus-5-5",
  sessionId: "omp:s1",
  input: 10,
  output: 90,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  cost: 1,
  ...extra,
});

const blocksOf = (periods: ReturnType<typeof usageBlocks>): UsageBlock[] => periods.filter((p): p is UsageBlock => p.kind === "block");

describe("usageBlocks", () => {
  it("returns nothing without requests", () => {
    expect(usageBlocks([], DAY)).toEqual([]);
  });

  it("floors the block start to the full UTC hour and lasts 5 hours", () => {
    const [b] = blocksOf(usageBlocks([req(DAY + 9 * H + 47 * M)], DAY + 20 * H));
    expect(b.start).toBe(DAY + 9 * H);
    expect(b.end).toBe(DAY + 14 * H);
    expect(b.end - b.start).toBe(BLOCK_MS);
  });

  it("keeps requests before the block end and starts a new block exactly at it", () => {
    const start = DAY + 9 * H;
    const periods = usageBlocks([req(start + 10 * M), req(start + 2 * H), req(start + 5 * H - 1), req(start + 5 * H)], DAY + 20 * H);
    const blocks = blocksOf(periods);
    expect(blocks.map((b) => [b.start, b.requests])).toEqual([
      [start, 3],
      [start + 5 * H, 1],
    ]);
    // Adjacent blocks: no gap between them.
    expect(periods.some((p) => p.kind === "gap")).toBe(false);
  });

  it("does not extend a block through continuous activity", () => {
    // A request every hour for 12 hours: blocks are cut every 5 hours, regardless of the short gaps.
    const rows = Array.from({ length: 12 }, (_, i) => req(DAY + i * H + 30 * M));
    expect(blocksOf(usageBlocks(rows, DAY + 30 * H)).map((b) => b.start)).toEqual([DAY, DAY + 5 * H, DAY + 10 * H]);
  });

  it("starts a new block after a gap of 5 hours or more and reports the idle period", () => {
    const periods = usageBlocks([req(DAY + 1 * H), req(DAY + 1 * H + 20 * M), req(DAY + 9 * H + 15 * M)], DAY + 20 * H);
    expect(periods.map((p) => [p.kind, p.start, p.end])).toEqual([
      ["block", DAY + 1 * H, DAY + 6 * H],
      ["gap", DAY + 6 * H, DAY + 9 * H],
      ["block", DAY + 9 * H, DAY + 14 * H],
    ]);
  });

  it("sorts unordered input and sums tokens, cost, models and sessions", () => {
    const rows = [
      req(DAY + 2 * H, { sessionId: "omp:b", model: "claude-haiku-4-5", output: 10, cost: null }),
      req(DAY + 1 * H, { sessionId: "omp:a", title: "A", cacheRead: 1000, cost: 2 }),
      req(DAY + 1 * H + M, { sessionId: "omp:a", title: "A", cost: 0.5 }),
    ];
    const [b] = blocksOf(usageBlocks(rows, DAY + 30 * H));
    expect(b).toMatchObject({
      start: DAY + H,
      firstRequest: DAY + H,
      lastRequest: DAY + 2 * H,
      requests: 3,
      tokens: { input: 30, output: 190, cacheRead: 1000, cacheWrite: 0, reasoning: 0 },
      totalTokens: 1220,
      cost: 2.5,
      unpricedRequests: 1,
      models: ["claude-opus-5-5", "claude-haiku-4-5"],
    });
    expect(b.sessions.map((s) => [s.sessionId, s.title, s.requests, s.tokens, s.cost])).toEqual([
      ["omp:a", "A", 2, 1200, 2.5],
      ["omp:b", null, 1, 20, null],
    ]);
  });

  it("marks only a block whose end is still ahead as active", () => {
    const rows = [req(DAY + 9 * H + 10 * M), req(DAY + 10 * H)];
    const at = (now: number) => blocksOf(usageBlocks(rows, now))[0].active;
    expect(at(DAY + 11 * H)).toBe(true);
    expect(at(DAY + 14 * H - 1)).toBe(true);
    expect(at(DAY + 14 * H)).toBe(false);
    const history = blocksOf(usageBlocks([req(DAY), req(DAY + 7 * H)], DAY + 8 * H));
    expect(history.map((b) => b.active)).toEqual([false, true]);
  });
});

describe("burnRate", () => {
  it("measures over the active span and projects to the block end", () => {
    const rows = [req(DAY + 9 * H, { output: 590 }), req(DAY + 9 * H + 10 * M, { output: 390 })];
    const [b] = blocksOf(usageBlocks(rows, DAY + 9 * H + 10 * M));
    const rate = burnRate(b, DAY + 9 * H + 10 * M);
    // 1000 tokens and $2 over 10 minutes; 290 minutes left.
    expect(rate?.tokensPerMinute).toBe(100);
    expect(rate?.costPerHour).toBeCloseTo(12);
    expect(rate?.projectedTokens).toBe(1000 + 100 * 290);
    expect(rate?.projectedCost).toBeCloseTo(2 + 0.2 * 290);
  });

  it("has no rate for a single request", () => {
    const [b] = blocksOf(usageBlocks([req(DAY)], DAY + M));
    expect(burnRate(b, DAY + M)).toBeNull();
  });
});
