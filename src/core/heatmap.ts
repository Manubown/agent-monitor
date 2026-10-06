/**
 * Activity heatmap layout: local hour slots laid out on whole Monday-first weeks, plus the weekday x hour grid and the
 * color levels. Pure, so the client component can share it; the SQL lives in src/store/insights.ts.
 */

const DAY_MS = 86400_000;

/** Weeks shown when the range is unbounded ("All time"). */
export const HEATMAP_WEEKS = 26;

export interface HeatDay {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  events: number;
  /** Distinct sessions with events that day; a subagent run counts as its parent. */
  sessions: number;
  /** Null when nothing that day could be priced. */
  cost: number | null;
  /** False for the padding that fills the first and last week. */
  inRange: boolean;
}

export interface Heatmap {
  firstDay: string;
  lastDay: string;
  /** Whole Monday-first weeks, column by column: index = week * 7 + weekday. */
  days: HeatDay[];
  weeks: number;
  /** Weekday x local hour, index = weekday * 24 + hour (weekday 0 = Monday). Sessions are summed per day and hour. */
  hours: { events: number[]; sessions: number[]; cost: (number | null)[] };
  totals: { events: number; sessions: number; cost: number | null };
}

/** Local events per hour slot and root session: `slot` is "YYYY-MM-DD HH" in local time. */
export interface SlotRow {
  slot: string;
  root: string;
  events: number;
}

export interface CostRow {
  slot: string;
  cost: number | null;
}

const parseDay = (day: string): number => {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
/** 0 = Monday … 6 = Sunday. Calendar arithmetic runs on day strings in UTC, so DST transitions never skip or repeat a day. */
export const weekdayOf = (day: string): number => (new Date(parseDay(day)).getUTCDay() + 6) % 7;

/** Local calendar day of `ts` (the process time zone, as SQLite's 'localtime'). */
export const localDay = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const addCost = (a: number | null, b: number | null): number | null => (b === null ? a : (a ?? 0) + b);

/** Start of the heatmap window: the range's own start, or local midnight on the Monday HEATMAP_WEEKS - 1 weeks before this week's. */
export function heatmapStart(from: number | undefined, now: number = Date.now()): number {
  if (from !== undefined) return from;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - (HEATMAP_WEEKS - 1) * 7);
  return d.getTime();
}

/** Lays slot rows out on whole weeks from `firstDay` to `lastDay` (inclusive); rows outside are dropped. */
export function buildHeatmap(slots: SlotRow[], costs: CostRow[], firstDay: string, lastDay: string): Heatmap {
  const first = parseDay(firstDay);
  const last = parseDay(lastDay);
  const start = first - weekdayOf(firstDay) * DAY_MS;
  const end = last + (6 - weekdayOf(lastDay)) * DAY_MS;
  const days: HeatDay[] = [];
  const index = new Map<string, HeatDay>();
  for (let t = start; t <= end; t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    const cell: HeatDay = { day, weekday: days.length % 7, events: 0, sessions: 0, cost: null, inRange: t >= first && t <= last };
    days.push(cell);
    if (cell.inRange) index.set(day, cell);
  }

  const hours = { events: new Array<number>(168).fill(0), sessions: new Array<number>(168).fill(0), cost: new Array<number | null>(168).fill(null) };
  const roots = new Map<string, Set<string>>();
  const all = new Set<string>();
  let events = 0;
  for (const r of slots) {
    const day = r.slot.slice(0, 10);
    const cell = index.get(day);
    if (!cell) continue;
    const h = cell.weekday * 24 + Number(r.slot.slice(11, 13));
    cell.events += r.events;
    events += r.events;
    hours.events[h] += r.events;
    // One row per (slot, root): each row is one session active in that hour.
    hours.sessions[h] += 1;
    let set = roots.get(day);
    if (!set) roots.set(day, (set = new Set()));
    set.add(r.root);
    all.add(r.root);
  }
  for (const [day, set] of roots) index.get(day)!.sessions = set.size;

  let cost: number | null = null;
  for (const r of costs) {
    const cell = index.get(r.slot.slice(0, 10));
    if (!cell || r.cost === null) continue;
    const h = cell.weekday * 24 + Number(r.slot.slice(11, 13));
    cell.cost = addCost(cell.cost, r.cost);
    hours.cost[h] = addCost(hours.cost[h], r.cost);
    cost = addCost(cost, r.cost);
  }
  return { firstDay, lastDay, days, weeks: days.length / 7, hours, totals: { events, sessions: all.size, cost } };
}

/**
 * Color level 0..steps per value: 0 for nothing, otherwise by quantile among the non-zero values, so one outlier day
 * does not wash out the rest. The largest value always gets the top level.
 */
export function heatLevels(values: (number | null)[], steps = 4): number[] {
  const sorted = values.filter((v): v is number => v !== null && v > 0).sort((a, b) => a - b);
  const thresholds = Array.from({ length: steps - 1 }, (_, k) => sorted[Math.floor(((k + 1) * sorted.length) / steps)]);
  return values.map((v) => (v === null || v <= 0 ? 0 : 1 + thresholds.filter((t) => t <= v).length));
}
