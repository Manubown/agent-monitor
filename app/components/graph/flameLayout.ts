/**
 * Pure layout pieces of the flame view (FlameGraph.tsx): call durations,
 * track packing, cost-proportional flame layout, request attribution and
 * merging of sub-pixel blocks. Shared with the tests.
 */
import type { ActionCategory } from "../../../src/store/activity";

export type Band = ActionCategory | "error";

export interface Span {
  start: number;
  end: number;
}

/**
 * When each call ended: its result, else the agent's next call, else the agent's last activity; never before the call.
 * `actions` are grouped by agent and in call order within each agent (as `sessionActivity` returns them).
 */
export function callEnds(actions: readonly { agent: number; ts: number }[], results: readonly (number | null)[], agentEnds: readonly number[]): number[] {
  const ends: number[] = new Array(actions.length);
  const next = new Map<number, number>();
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i];
    const end = results[i] ?? next.get(a.agent) ?? agentEnds[a.agent] ?? a.ts;
    ends[i] = Math.max(a.ts, end);
    next.set(a.agent, a.ts);
  }
  return ends;
}

/**
 * Greedy interval packing: spans in start order each go on the first track that is free (its last end + `gap` at or
 * before the start). With every one of `maxTracks` busy, a span goes on the track that frees up first and overlaps it.
 */
export function packTracks(spans: readonly Span[], maxTracks = Number.POSITIVE_INFINITY, gap = 0): { track: number[]; count: number } {
  const order = spans.map((_, i) => i).sort((a, b) => spans[a].start - spans[b].start || a - b);
  const track: number[] = new Array(spans.length);
  const ends: number[] = [];
  for (const i of order) {
    const s = spans[i];
    let t = ends.findIndex((end) => end + gap <= s.start);
    if (t < 0 && ends.length < maxTracks) t = ends.length;
    if (t < 0) t = ends.indexOf(Math.min(...ends));
    track[i] = t;
    ends[t] = Math.max(ends[t] ?? s.end, s.end);
  }
  return { track, count: ends.length };
}

/** `[root, end)`: `root` and its descendants, a contiguous run because agents are in depth-first order. */
export function subtreeEnd(agents: readonly { depth: number }[], root: number): number {
  let end = root + 1;
  while (end < agents.length && agents[end].depth > agents[root].depth) end++;
  return end;
}

/** Cost of each agent plus all its descendants; unpriced agents count as nothing. Agents in depth-first order. */
export function subtreeCosts(agents: readonly { parent: number | null }[], costs: readonly (number | null)[]): number[] {
  const total = costs.map((c) => c ?? 0);
  for (let i = agents.length - 1; i > 0; i--) {
    const p = agents[i].parent;
    if (p !== null) total[p] += total[i];
  }
  return total;
}

export interface CostBox {
  x0: number;
  x1: number;
  /** Where the agent's own cost starts: after its children. */
  self: number;
}

/**
 * Flame layout by cost: `root` spans `[x0, x0 + width]`; every agent's box is split among its children (left to right
 * in agent order, each as wide as its subtree cost) followed by its own cost. Agents outside the subtree are null;
 * agents without priced cost get zero width.
 */
export function costLayout(
  agents: readonly { parent: number | null; depth: number }[],
  costs: readonly (number | null)[],
  root: number,
  x0: number,
  width: number,
): (CostBox | null)[] {
  const totals = subtreeCosts(agents, costs);
  const boxes: (CostBox | null)[] = agents.map(() => null);
  const end = subtreeEnd(agents, root);
  const scale = totals[root] > 0 ? width / totals[root] : 0;
  /** Next free x inside each placed agent's box. */
  const cursor = new Map<number, number>();
  for (let i = root; i < end; i++) {
    const p = agents[i].parent;
    const start = i === root ? x0 : (cursor.get(p!) ?? x0);
    const w = totals[i] * scale;
    if (i !== root) cursor.set(p!, start + w);
    cursor.set(i, start);
    boxes[i] = { x0: start, x1: start + w, self: start };
  }
  // Own cost follows the children.
  for (let i = root; i < end; i++) boxes[i]!.self = cursor.get(i)!;
  return boxes;
}

/**
 * Model request that issued each call: the latest request of the same agent at or before the call, null before the
 * first. `requests` are grouped by agent, each agent's in time order.
 */
export function issuedBy(actions: readonly { agent: number; ts: number }[], requests: readonly { agent: number; ts: number }[]): (number | null)[] {
  const byAgent = new Map<number, number[]>();
  requests.forEach((r, i) => {
    const list = byAgent.get(r.agent);
    if (list) list.push(i);
    else byAgent.set(r.agent, [i]);
  });
  return actions.map((a) => {
    const list = byAgent.get(a.agent);
    if (!list) return null;
    // Last request with ts <= a.ts.
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (requests[list[mid]].ts <= a.ts) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 ? list[lo - 1] : null;
  });
}

export interface Block {
  x0: number;
  x1: number;
  /** Indices of the merged items, in x order. */
  items: number[];
}

/**
 * Blocks of one track in x order, with runs of blocks narrower than `minPx` merged into bins up to `binPx` wide, so a
 * track never draws more than about one mark per pixel column however many calls it holds.
 */
export function mergeThin(blocks: readonly { x0: number; x1: number; index: number }[], minPx = 2, binPx = 3): Block[] {
  const out: Block[] = [];
  let bin: Block | null = null;
  for (const b of blocks) {
    if (b.x1 - b.x0 >= minPx) {
      out.push({ x0: b.x0, x1: b.x1, items: [b.index] });
      bin = null;
    } else if (bin && b.x0 - bin.x0 < binPx) {
      bin.items.push(b.index);
      bin.x1 = Math.max(bin.x1, b.x1);
    } else {
      bin = { x0: b.x0, x1: b.x1, items: [b.index] };
      out.push(bin);
    }
  }
  return out;
}

/** Order of bands on ties: the legend's. */
const BAND_ORDER: Band[] = ["read", "write", "search", "shell", "web", "agent", "other"];

/** The color of a merged block: failed if any call failed (so failures never vanish in a bin), else the most common category. */
export function dominantBand(bands: readonly Band[]): Band | null {
  if (!bands.length) return null;
  if (bands.includes("error")) return "error";
  const counts = new Map<Band, number>();
  for (const b of bands) counts.set(b, (counts.get(b) ?? 0) + 1);
  let best: Band = "other";
  let most = 0;
  for (const b of BAND_ORDER) {
    const n = counts.get(b) ?? 0;
    if (n > most) [best, most] = [b, n];
  }
  return best;
}
