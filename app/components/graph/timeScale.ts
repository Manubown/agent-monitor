/**
 * A time axis that squeezes idle stretches: gaps longer than `gapMs` between
 * activity become fixed-width breaks, so a session that sat idle overnight
 * still shows its active stretches at a readable scale. Pure; shared by the
 * time graph and its tests.
 */

export interface TimeSegment {
  start: number;
  end: number;
  x0: number;
  x1: number;
}

export interface TimeBreak {
  /** Idle period [from, to]. */
  from: number;
  to: number;
  x0: number;
  x1: number;
}

export interface TimeScale {
  segments: TimeSegment[];
  breaks: TimeBreak[];
  /** Pixel position of `ts`; times inside a break are spread across it, times outside the range are clamped. */
  x: (ts: number) => number;
}

export interface TimeScaleOptions {
  /** Idle gaps longer than this become breaks. */
  gapMs?: number;
  /** Width of one break. */
  breakPx?: number;
  /** Narrowest an active stretch is drawn, so a single burst stays visible. */
  minPx?: number;
}

export const IDLE_GAP_MS = 10 * 60_000;

/** Active stretches of `times`: runs whose consecutive gaps are at most `gapMs`. */
export function activeSpans(times: readonly number[], gapMs: number = IDLE_GAP_MS): { start: number; end: number }[] {
  const sorted = [...times].sort((a, b) => a - b);
  const spans: { start: number; end: number }[] = [];
  for (const t of sorted) {
    const last = spans.at(-1);
    if (last && t - last.end <= gapMs) last.end = t;
    else spans.push({ start: t, end: t });
  }
  return spans;
}

/** Map `times` onto [x0, x0 + width] with idle gaps compressed into breaks. */
export function timeScale(times: readonly number[], x0: number, width: number, options: TimeScaleOptions = {}): TimeScale {
  const { gapMs = IDLE_GAP_MS, breakPx = 36, minPx = 8 } = options;
  const spans = activeSpans(times, gapMs);
  if (!spans.length) return { segments: [], breaks: [], x: () => x0 };
  const breakW = spans.length > 1 ? Math.min(breakPx, (width * 0.5) / (spans.length - 1)) : 0;
  const available = Math.max(0, width - breakW * (spans.length - 1));
  const floor = Math.min(minPx, available / spans.length);
  const total = spans.reduce((sum, s) => sum + (s.end - s.start), 0);
  const spare = available - floor * spans.length;

  const segments: TimeSegment[] = [];
  const breaks: TimeBreak[] = [];
  let cursor = x0;
  for (const [i, s] of spans.entries()) {
    const w = floor + (total > 0 ? (spare * (s.end - s.start)) / total : spare / spans.length);
    segments.push({ start: s.start, end: s.end, x0: cursor, x1: cursor + w });
    cursor += w;
    const next = spans[i + 1];
    if (next) {
      breaks.push({ from: s.end, to: next.start, x0: cursor, x1: cursor + breakW });
      cursor += breakW;
    }
  }

  const x = (ts: number): number => {
    if (ts < segments[0].start) return segments[0].x0;
    // Last segment starting at or before ts.
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].start <= ts) lo = mid;
      else hi = mid - 1;
    }
    const seg = segments[lo];
    if (ts <= seg.end) return seg.end === seg.start ? (seg.x0 + seg.x1) / 2 : seg.x0 + ((ts - seg.start) / (seg.end - seg.start)) * (seg.x1 - seg.x0);
    const gap = breaks[lo];
    if (!gap) return seg.x1;
    return gap.x0 + ((ts - gap.from) / (gap.to - gap.from)) * (gap.x1 - gap.x0);
  };

  return { segments, breaks, x };
}

const STEPS = [1, 5, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400].map((s) => s * 1000);

/**
 * Axis ticks: within each active stretch, round local times at least `spacingPx`
 * apart, plus the start of every stretch. `tzOffsetMs` is the local offset from UTC
 * (east positive) so ticks land on local minute/hour boundaries.
 */
export function timeTicks(scale: TimeScale, spacingPx: number, tzOffsetMs = 0): { ts: number; x: number }[] {
  const ticks: { ts: number; x: number }[] = [];
  const push = (ts: number, x: number) => {
    const prev = ticks.at(-1);
    if (!prev || x - prev.x >= spacingPx) ticks.push({ ts, x });
  };
  for (const seg of scale.segments) {
    push(seg.start, seg.x0);
    const span = seg.end - seg.start;
    const w = seg.x1 - seg.x0;
    if (span <= 0 || w < spacingPx) continue;
    const step = STEPS.find((s) => (s / span) * w >= spacingPx) ?? STEPS.at(-1)!;
    const first = Math.ceil((seg.start + tzOffsetMs) / step) * step - tzOffsetMs;
    for (let t = first; t <= seg.end; t += step) push(t, scale.x(t));
  }
  return ticks;
}
