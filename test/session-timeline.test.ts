import { describe, expect, it } from "vitest";
import { nonNegativeInt } from "../app/lib/params";
import { atTarget, cappedRange, isFollowing, pagerLink, pagerRanges, shownKind, TIMELINE_MAX, timelineHref } from "../app/sessions/[id]/timeline";
import { DEFAULT_TIMELINE_KINDS, TIMELINE_PAGE, type TimelineKind, timelineWindow } from "../src/store/queries";

const SID = "omp:abc";

/** What the page does with a timeline URL: parse `from`/`to`/`at`, cap the range, take the window (centered on `at` when no range is given). */
function open(href: string, total: number, atIndex?: number) {
  const url = new URL(href, "http://127.0.0.1");
  expect(url.pathname).toBe(`/sessions/${encodeURIComponent(SID)}`);
  const q = (k: string) => url.searchParams.get(k) ?? undefined;
  const toParam = nonNegativeInt(q("to"));
  const range = cappedRange({ from: nonNegativeInt(q("from")), to: toParam });
  const at = nonNegativeInt(q("at"));
  const win = timelineWindow(total, { ...range, at: at !== undefined && range.from === undefined && range.to === undefined ? atIndex : undefined });
  return { win, at, following: isFollowing(win, toParam) };
}

describe("cappedRange", () => {
  it("leaves the default, centered and narrow ranges alone", () => {
    expect(cappedRange({})).toEqual({ from: undefined, to: undefined });
    expect(cappedRange({ to: 500 })).toEqual({ from: undefined, to: 500 });
    expect(cappedRange({ from: 100, to: 600 })).toEqual({ from: 100, to: 600 });
  });

  it("caps open and wide ranges at TIMELINE_MAX from their start", () => {
    expect(cappedRange({ from: 0 })).toEqual({ from: 0, to: TIMELINE_MAX });
    expect(cappedRange({ from: 10, to: 1_000_000 })).toEqual({ from: 10, to: 10 + TIMELINE_MAX });
    expect(cappedRange({ from: 900, to: 100 })).toEqual({ from: 100, to: 900 });
    // Whatever comes in, the window it gives stays within the cap.
    for (const p of [{ from: 0 }, { from: 0, to: Number.MAX_SAFE_INTEGER }, { from: Number.MAX_SAFE_INTEGER }]) {
      const w = timelineWindow(50_000, cappedRange(p));
      expect(w.to - w.from).toBeLessThanOrEqual(TIMELINE_MAX);
    }
  });
});

describe("isFollowing", () => {
  it("follows the default window and an open end that fits", () => {
    expect(isFollowing(timelineWindow(500, {}), undefined)).toBe(true);
    expect(isFollowing(timelineWindow(500, cappedRange({ from: 100 })), undefined)).toBe(true);
  });

  it("stops for an explicit end, and for an open end once the session outgrows the cap", () => {
    expect(isFollowing(timelineWindow(500, cappedRange({ from: 100, to: 500 })), 500)).toBe(false);
    // `?from=100` with 1,200 events: pinned at [100, 1100), the "newer events" pager offers the rest.
    const w = timelineWindow(1_200, cappedRange({ from: 100 }));
    expect(w).toMatchObject({ from: 100, to: 100 + TIMELINE_MAX });
    expect(isFollowing(w, undefined)).toBe(false);
  });
});

describe("pagerRanges", () => {
  it("grows a following window toward the start while it fits", () => {
    const win = timelineWindow(5_000, {});
    const p = pagerRanges(win, true);
    expect(p.earlier).toEqual({ from: win.from - TIMELINE_PAGE, to: null });
    expect(p.earlierCount).toBe(TIMELINE_PAGE);
    expect(p.laterCount).toBe(0);
  });

  it("slides instead of growing past the cap, and back again", () => {
    const total = 5_000;
    let win = timelineWindow(total, {});
    let following = true;
    for (let i = 0; i < 12; i++) {
      const { earlier } = pagerRanges(win, following);
      win = timelineWindow(total, cappedRange({ from: earlier.from, ...(earlier.to === null ? {} : { to: earlier.to }) }));
      following = earlier.to === null && win.to === total;
      expect(win.to - win.from).toBeLessThanOrEqual(TIMELINE_MAX);
    }
    expect(win).toMatchObject({ from: total - TIMELINE_PAGE * 13, to: total - TIMELINE_PAGE * 13 + TIMELINE_MAX });
    expect(following).toBe(false);
    // "Later" moves the window back toward the newest events, also capped.
    const { later, laterCount } = pagerRanges(win, false);
    expect(laterCount).toBe(TIMELINE_PAGE);
    expect(later).toEqual({ from: win.from + TIMELINE_PAGE, to: win.to + TIMELINE_PAGE });
  });

  it("follows again once later reaches the newest event", () => {
    const p = pagerRanges({ from: 3_900, to: 4_900, total: 5_000 }, false);
    expect(p.later).toEqual({ from: 4_000, to: null });
    expect(p.laterCount).toBe(100);
  });

  it("clamps at the start", () => {
    const p = pagerRanges({ from: 50, to: 250, total: 250 }, true);
    expect(p.earlier).toEqual({ from: 0, to: null });
    expect(p.earlierCount).toBe(50);
  });
});

describe("timelineHref", () => {
  const kinds = [...DEFAULT_TIMELINE_KINDS];

  it("omits defaults and writes the rest", () => {
    expect(timelineHref(SID, kinds)).toBe("/sessions/omp%3Aabc");
    expect(timelineHref(SID, ["user"], { at: 7, from: 5, to: 9 })).toBe("/sessions/omp%3Aabc?kinds=user&at=7&from=5&to=9");
    expect(timelineHref(SID, [])).toBe("/sessions/omp%3Aabc?kinds=");
  });

  it("pages a short session back to its first event (from=0 is written)", () => {
    // 250 matching events: the default window is [50, 250); "Show 50 earlier" must reach event 0, not reset to the default.
    const total = 250;
    const first = open(timelineHref(SID, kinds), total);
    expect(first.win).toMatchObject({ from: 50, to: 250 });
    const { earlier, earlierCount } = pagerRanges(first.win, first.following);
    expect(earlierCount).toBe(50);
    const href = timelineHref(SID, kinds, earlier);
    expect(href).toBe("/sessions/omp%3Aabc?from=0");
    const next = open(href, total);
    expect(next.win).toMatchObject({ from: 0, to: 250 });
    // Still the newest events, so live updates keep coming in.
    expect(next.following).toBe(true);
  });

  it("pages back to the start of a session just under the cap", () => {
    const total = TIMELINE_MAX - 10;
    let view = open(timelineHref(SID, kinds), total);
    while (view.win.from > 0) {
      const { earlier, earlierCount } = pagerRanges(view.win, view.following);
      expect(earlierCount).toBeGreaterThan(0);
      const next = open(timelineHref(SID, kinds, earlier), total);
      expect(next.win.from).toBeLessThan(view.win.from);
      view = next;
    }
    expect(view.win).toMatchObject({ from: 0, to: total });
  });

  it("keeps `at` with from=0 when paging back from a hit", () => {
    const total = 300;
    // A hit at index 120: centered window [20, 220).
    const view = open(timelineHref(SID, kinds, { at: 999 }), total, 120);
    expect(view.win).toMatchObject({ from: 20, to: 220 });
    const { earlier } = pagerRanges(view.win, view.following);
    const href = timelineHref(SID, kinds, pagerLink(earlier, 999, { index: 120, extra: false }));
    expect(href).toBe("/sessions/omp%3Aabc?at=999&from=0&to=220");
    expect(open(href, total).win).toMatchObject({ from: 0, to: 220 });
  });
});

describe("pagerLink", () => {
  const range = (from: number, to: number | null) => ({ from, to });

  it("passes ranges through without a target", () => {
    expect(pagerLink(range(0, 200), undefined, null)).toEqual({ from: 0, to: 200 });
  });

  it("keeps `at` while the new range lists the target", () => {
    expect(pagerLink(range(100, 1_100), 7, { index: 100, extra: false })).toEqual({ from: 100, to: 1_100, at: 7 });
    expect(pagerLink(range(100, null), 7, { index: 5_000, extra: true })).toEqual({ from: 100, to: null, at: 7 });
    // A target the window does not list is left alone.
    expect(pagerLink(range(0, 200), 7, null)).toEqual({ from: 0, to: 200, at: 7 });
  });

  it("drops `at` once a slide leaves the target behind", () => {
    // Window [1000, 2000) with the hit at its last row; sliding earlier to [800, 1800) would hide it.
    expect(pagerLink(range(800, 1_800), 7, { index: 1_999, extra: false })).toEqual({ from: 800, to: 1_800 });
    expect(pagerLink(range(800, 1_800), 7, { index: 1_999, extra: true })).toEqual({ from: 800, to: 1_800 });
    // Sliding later past a hit of a matching type keeps the numbers.
    expect(pagerLink(range(1_200, 2_200), 7, { index: 1_100, extra: false })).toEqual({ from: 1_200, to: 2_200 });
  });

  it("moves a range after a filtered-out target back by one, so the same events stay listed", () => {
    expect(pagerLink(range(1_200, 2_200), 7, { index: 1_100, extra: true })).toEqual({ from: 1_199, to: 2_199 });
    expect(pagerLink(range(1_200, null), 7, { index: 1_100, extra: true })).toEqual({ from: 1_199, to: null });
  });

  it("never leaves `at` in a link whose window would not list it", () => {
    // Slide a window around a hit both ways: every link either keeps the hit in range or drops `at`.
    const total = 6_000;
    const hit = 3_000;
    for (const start of [{ from: hit - 999, to: hit + 1 }, { from: hit, to: hit + 1_000 }]) {
      let win = timelineWindow(total, start);
      for (let i = 0; i < 8; i++) {
        const p = pagerRanges(win, false);
        for (const r of [p.earlier, p.later]) {
          const link = pagerLink(r, 42, { index: hit, extra: false });
          if (link.at !== undefined) {
            const w = timelineWindow(total, cappedRange({ from: link.from, ...(link.to == null ? {} : { to: link.to }) }));
            expect(hit >= w.from && hit < w.to).toBe(true);
          }
        }
        win = timelineWindow(total, { from: p.earlier.from, to: p.earlier.to ?? undefined });
      }
    }
  });
});

describe("atTarget", () => {
  const events = [
    { seq: 10, kind: "user", isError: 0 },
    { seq: 11, kind: "thinking", isError: 0 },
    { seq: 12, kind: "tool_result", isError: 1 },
  ];
  const kinds: TimelineKind[] = ["user", "error"];

  it("finds the target's position and whether it matched only as the target", () => {
    expect(atTarget({ from: 40, events }, 10, kinds)).toEqual({ index: 40, extra: false });
    expect(atTarget({ from: 40, events }, 11, kinds)).toEqual({ index: 41, extra: true });
    expect(atTarget({ from: 40, events }, 12, kinds)).toEqual({ index: 42, extra: false });
    expect(atTarget({ from: 40, events }, 99, kinds)).toBeNull();
    expect(atTarget({ from: 40, events }, undefined, kinds)).toBeNull();
  });

  it("matches kinds the same way as the timeline filter", () => {
    expect(shownKind({ kind: "tool_call", isError: 0 }, ["tools"])).toBe(true);
    expect(shownKind({ kind: "tool_result", isError: 1 }, ["error"])).toBe(true);
    expect(shownKind({ kind: "tool_result", isError: 0 }, ["error"])).toBe(false);
    expect(shownKind({ kind: "system", isError: 0 }, DEFAULT_TIMELINE_KINDS)).toBe(false);
    expect(shownKind({ kind: "error", isError: 0 }, DEFAULT_TIMELINE_KINDS)).toBe(true);
  });
});
