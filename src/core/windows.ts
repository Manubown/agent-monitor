/**
 * Claude subscription usage windows ("5-hour blocks"), following ccusage's
 * documented rules (https://ccusage.com/guide/blocks-reports):
 *
 * - A block starts at the first request, floored to the full UTC hour.
 * - It lasts exactly 5 hours. Blocks are half-open: [start, start + 5 h).
 * - A request at or after the block end, or after a gap of 5 h or more since
 *   the previous request, starts a new block.
 * - A block is active while `now` is before its end and its last request is
 *   less than 5 h ago.
 * - The idle time between two blocks is reported as a gap.
 *
 * ccusage keeps a request exactly at the end in the old block; here the end is
 * exclusive, matching how the window itself is described (5 hours, not 5 h + 1 ms).
 */

export const BLOCK_MS = 5 * 3600_000;
const HOUR_MS = 3600_000;

export interface UsageInput {
  ts: number;
  model: string;
  /** Session the request belongs to (normally the top-level session of the tree). */
  sessionId: string;
  title?: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** API-equivalent cost; null when the model is unpriced. */
  cost: number | null;
}

export interface BlockTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface BlockSession {
  sessionId: string;
  title: string | null;
  requests: number;
  tokens: number;
  cost: number | null;
}

export interface UsageBlock {
  kind: "block";
  start: number;
  /** start + 5 h (exclusive). */
  end: number;
  firstRequest: number;
  lastRequest: number;
  active: boolean;
  requests: number;
  tokens: BlockTokens;
  /** input + output + cache read + cache write. */
  totalTokens: number;
  /** Sum of priced requests; null when none could be priced. */
  cost: number | null;
  unpricedRequests: number;
  /** Models by total tokens, heaviest first. */
  models: string[];
  /** Sessions by total tokens, heaviest first. */
  sessions: BlockSession[];
}

export interface UsageGap {
  kind: "gap";
  /** End of the previous block. */
  start: number;
  /** Start of the next block. */
  end: number;
}

export type UsagePeriod = UsageBlock | UsageGap;

const floorToHour = (ts: number): number => Math.floor(ts / HOUR_MS) * HOUR_MS;

const total = (t: { input: number; output: number; cacheRead: number; cacheWrite: number }): number => t.input + t.output + t.cacheRead + t.cacheWrite;

function buildBlock(start: number, rows: UsageInput[], now: number): UsageBlock {
  const end = start + BLOCK_MS;
  const tokens: BlockTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  let cost: number | null = null;
  let unpricedRequests = 0;
  const models = new Map<string, number>();
  const sessions = new Map<string, BlockSession>();
  for (const r of rows) {
    tokens.input += r.input;
    tokens.output += r.output;
    tokens.cacheRead += r.cacheRead;
    tokens.cacheWrite += r.cacheWrite;
    tokens.reasoning += r.reasoning;
    if (r.cost === null) unpricedRequests++;
    else cost = (cost ?? 0) + r.cost;
    const t = total(r);
    models.set(r.model, (models.get(r.model) ?? 0) + t);
    const s = sessions.get(r.sessionId) ?? { sessionId: r.sessionId, title: r.title ?? null, requests: 0, tokens: 0, cost: null };
    s.requests++;
    s.tokens += t;
    if (r.cost !== null) s.cost = (s.cost ?? 0) + r.cost;
    sessions.set(r.sessionId, s);
  }
  const lastRequest = rows[rows.length - 1].ts;
  return {
    kind: "block",
    start,
    end,
    firstRequest: rows[0].ts,
    lastRequest,
    active: now < end && now - lastRequest < BLOCK_MS,
    requests: rows.length,
    tokens,
    totalTokens: total(tokens),
    cost,
    unpricedRequests,
    models: [...models.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m),
    sessions: [...sessions.values()].sort((a, b) => b.tokens - a.tokens),
  };
}

/** Group requests into 5-hour blocks, oldest first, with gaps between non-adjacent blocks. */
export function usageBlocks(rows: readonly UsageInput[], now: number): UsagePeriod[] {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  const periods: UsagePeriod[] = [];
  let start = 0;
  let current: UsageInput[] = [];
  const close = () => {
    if (current.length) periods.push(buildBlock(start, current, now));
  };
  for (const row of sorted) {
    const last = current[current.length - 1];
    if (last && row.ts < start + BLOCK_MS && row.ts - last.ts < BLOCK_MS) {
      current.push(row);
      continue;
    }
    close();
    const next = floorToHour(row.ts);
    if (last && next > start + BLOCK_MS) periods.push({ kind: "gap", start: start + BLOCK_MS, end: next });
    start = next;
    current = [row];
  }
  close();
  return periods;
}

export interface BurnRate {
  tokensPerMinute: number;
  /** Null when no request in the block could be priced. */
  costPerHour: number | null;
  /** Tokens and cost at the block end if the current rate continues. */
  projectedTokens: number;
  projectedCost: number | null;
}

/**
 * Burn rate of a block over its active span (first to last request, as ccusage
 * does), projected from `now` to the block end. Null for a block with a single
 * instant of activity, where no rate can be measured.
 */
export function burnRate(block: UsageBlock, now: number): BurnRate | null {
  const minutes = (block.lastRequest - block.firstRequest) / 60_000;
  if (minutes <= 0) return null;
  const tokensPerMinute = block.totalTokens / minutes;
  const costPerMinute = block.cost === null ? null : block.cost / minutes;
  const remaining = Math.max(0, (block.end - now) / 60_000);
  return {
    tokensPerMinute,
    costPerHour: costPerMinute === null ? null : costPerMinute * 60,
    projectedTokens: block.totalTokens + tokensPerMinute * remaining,
    projectedCost: block.cost === null || costPerMinute === null ? null : block.cost + costPerMinute * remaining,
  };
}
