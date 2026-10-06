/**
 * The session page's timeline window: the ranges its pagers link to and the URLs they write. Pure, so tests can
 * import it. Ranges count matching events (see `timelinePage` in `src/store/queries.ts`), not sequence numbers.
 */
import { DEFAULT_TIMELINE_KINDS, TIMELINE_PAGE, type TimelineKind, type TimelineWindow } from "../../../src/store/queries";

/** Most events listed at once: "Show earlier"/"Show later" grow the window up to this size, then slide it. */
export const TIMELINE_MAX = 1_000;

/**
 * The range to ask `timelinePage` for, at most `max` events wide: swapped bounds are put in order, an open end
 * (`from` alone: "up to the newest") ends `max` events after `from`, and a wider range keeps its start.
 */
export function cappedRange(p: { from?: number; to?: number }, max = TIMELINE_MAX): { from?: number; to?: number } {
  let { from, to } = p;
  if (from !== undefined && to !== undefined && from > to) [from, to] = [to, from];
  if (from !== undefined && (to === undefined || to - from > max)) to = from + max;
  return { from, to };
}

/**
 * Whether the window keeps showing the newest events on live updates. The default window and a centered one on the
 * last page do. An explicit `to` pins the end. `from` alone (an open end) follows only while the range fits in
 * `TIMELINE_MAX` events: `cappedRange` reads it as [from, from + max), so once the session grows past that the window
 * stays put and the "N newer events" pager below it offers the rest.
 */
export function isFollowing(win: Pick<TimelineWindow, "to" | "total" | "tail">, toParam: number | undefined): boolean {
  return win.to === win.total && (win.tail || toParam === undefined);
}

/** A window range for a link; `to: null` runs to the newest event and keeps following it. */
export interface PagerRange {
  from: number;
  to: number | null;
}

/**
 * Where the "earlier" and "later" links of window `win` lead, and how many events each brings in. Both grow the
 * window a page at a time; once it would pass `max` events it slides instead, dropping events at the other end.
 * `following`: the window runs to the newest event and should keep doing so.
 */
export function pagerRanges(
  win: { from: number; to: number; total: number },
  following: boolean,
  page = TIMELINE_PAGE,
  max = TIMELINE_MAX,
): { earlier: PagerRange; earlierCount: number; later: PagerRange; laterCount: number } {
  const from = Math.max(0, win.from - page);
  const earlier = { from, to: following && win.total - from <= max ? null : Math.min(win.to, from + max) };
  const to = Math.min(win.total, win.to + page);
  const later = { from: Math.max(win.from, to - max), to: to >= win.total ? null : to };
  return { earlier, earlierCount: win.from - from, later, laterCount: to - win.to };
}

/** Whether an event is one of the shown types (the same rule as `timelinePage`'s filter). */
export function shownKind(e: { kind: string; isError: number | boolean }, kinds: readonly TimelineKind[]): boolean {
  switch (e.kind) {
    case "tool_call":
      return kinds.includes("tools");
    case "tool_result":
      return kinds.includes("tools") || (Boolean(e.isError) && kinds.includes("error"));
    default:
      return (kinds as readonly string[]).includes(e.kind);
  }
}

/**
 * The `?at=` target in the current window: its position among the matching events, and whether it only matches
 * because it is the target (its type is filtered out). Null when the window does not list it.
 */
export interface AtTarget {
  index: number;
  extra: boolean;
}

export function atTarget(
  win: { from: number; events: readonly { seq: number; kind: string; isError: number | boolean }[] },
  at: number | undefined,
  kinds: readonly TimelineKind[],
): AtTarget | null {
  if (at === undefined) return null;
  const i = win.events.findIndex((e) => e.seq === at);
  return i === -1 ? null : { index: win.from + i, extra: !shownKind(win.events[i], kinds) };
}

export interface TimelineLink {
  from?: number;
  to?: number | null;
  at?: number;
}

/**
 * A pager link from a window that lists the `at` target: `at` stays while the new range still lists it. A range that
 * slides past it drops `at`, so the URL never names an event the page no longer shows; without `at` a target whose
 * type is filtered out stops matching, so a range after it moves back by one to keep the same events. A target the
 * window does not list (stale, or out of range already) is left as it is.
 */
export function pagerLink(range: PagerRange, at: number | undefined, target: AtTarget | null): TimelineLink {
  if (at === undefined) return range;
  if (!target || (range.from <= target.index && (range.to === null || target.index < range.to))) return { ...range, at };
  if (!target.extra || range.from <= target.index) return range;
  return { from: range.from - 1, to: range.to === null ? null : range.to - 1 };
}

/**
 * Timeline URL of a session. `from` is written whenever it is given, 0 included (`from=0` alone is the start of the
 * session up to `TIMELINE_MAX` events, see `cappedRange`); `to: null` leaves the end open. Default kinds are omitted.
 */
export function timelineHref(sessionId: string, kinds: readonly TimelineKind[], p: TimelineLink = {}): string {
  const qs = new URLSearchParams();
  const isDefault = kinds.length === DEFAULT_TIMELINE_KINDS.length && kinds.every((k) => DEFAULT_TIMELINE_KINDS.includes(k));
  if (!isDefault) qs.set("kinds", kinds.join(","));
  if (p.at !== undefined) qs.set("at", String(p.at));
  if (p.from !== undefined) qs.set("from", String(p.from));
  if (p.to != null) qs.set("to", String(p.to));
  return `/sessions/${encodeURIComponent(sessionId)}${qs.size ? `?${qs}` : ""}`;
}
