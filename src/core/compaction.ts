/**
 * Context compaction: the agent summarized its conversation and continued with
 * a much smaller context. Adapters turn the tool's own compaction record into a
 * `system` event with the text COMPACTION_TEXT; requests without such a marker
 * are checked for a large context drop instead (an inferred compaction).
 */

/** Text of the normalized compaction marker event (kind `system`). */
export const COMPACTION_TEXT = "Conversation compacted";

export const isCompactionMarker = (kind: string, text: string | null | undefined): boolean =>
  kind === "system" && (text ?? "").startsWith(COMPACTION_TEXT);

/** An unmarked drop counts as a compaction when the context shrinks by at least this share of the previous request… */
export const INFERRED_MIN_DROP_SHARE = 0.5;
/** …and by at least this many tokens. */
export const INFERRED_MIN_DROP_TOKENS = 20_000;

/** One model request: the context it sent (uncached input + cache read + cache write). */
export interface ContextRequest {
  ts: number;
  model: string;
  context: number;
}

export interface Compaction {
  /** Index of the first request after the compaction; `requests.length` when none followed yet. */
  index: number;
  ts: number;
  /** No compaction record in the log; derived from a context drop. */
  inferred: boolean;
  /** Context of the last request before the boundary, if any. */
  before: number | null;
  /** Context of the first request after the boundary, if any. */
  after: number | null;
  /** `before - after` when both are known. */
  drop: number | null;
}

/**
 * Compaction boundaries of one agent's requests (in time order), from marker timestamps plus inferred drops.
 * Requests with no context (failed calls) are skipped when comparing. Inferred drops need two consecutive requests
 * to the same model: switching models is not a compaction.
 */
export function detectCompactions(requests: readonly ContextRequest[], markers: readonly number[]): Compaction[] {
  const out: Compaction[] = [];
  const firstAtOrAfter = (ts: number) => {
    const i = requests.findIndex((r) => r.ts >= ts);
    return i < 0 ? requests.length : i;
  };
  const lastBefore = (index: number): number | null => {
    for (let i = index - 1; i >= 0; i--) if (requests[i].context > 0) return requests[i].context;
    return null;
  };
  const firstFrom = (index: number): number | null => {
    for (let i = index; i < requests.length; i++) if (requests[i].context > 0) return requests[i].context;
    return null;
  };

  const marked = new Set<number>();
  for (const ts of [...markers].sort((a, b) => a - b)) {
    const index = firstAtOrAfter(ts);
    if (marked.has(index)) continue;
    marked.add(index);
    const before = lastBefore(index);
    const after = firstFrom(index);
    out.push({ index, ts, inferred: false, before, after, drop: before !== null && after !== null ? before - after : null });
  }

  let prev = -1;
  let markerSince = false;
  for (let i = 0; i < requests.length; i++) {
    if (marked.has(i)) markerSince = true;
    const r = requests[i];
    if (r.context <= 0) continue;
    if (prev >= 0 && !markerSince) {
      const p = requests[prev];
      const drop = p.context - r.context;
      if (p.model === r.model && drop >= INFERRED_MIN_DROP_TOKENS && drop >= p.context * INFERRED_MIN_DROP_SHARE) {
        out.push({ index: i, ts: r.ts, inferred: true, before: p.context, after: r.context, drop });
      }
    }
    prev = i;
    markerSince = false;
  }
  return out.sort((a, b) => a.index - b.index || a.ts - b.ts);
}
