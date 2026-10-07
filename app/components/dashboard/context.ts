/**
 * What every dashboard widget is handed: the database, the page's filters and the few things the page itself already
 * knows (its clock, the end of the window, the label of the time scope, the open day, how to link back to itself).
 *
 * Widgets run their own queries, so a hidden one costs nothing. The two accessors below are the exception that keeps
 * that true: `overview` is the figure the page's own band already needs, and `dayAxis` is one `daily()` read plus the
 * day axis that both per-day charts draw. Each runs at most once per render, and only if something asks for it.
 */

import { adapters, sourceLabel } from "../../../src/adapters";
import type { Slot } from "../../../src/core/dashboard";
import type { Db } from "../../../src/store/db";
import { daily, type DailyRow, type Overview, overview } from "../../../src/store/queries";
import { dayRange, localDay, shortDay } from "../../lib/format";
import type { PageFilters } from "../../lib/server";
import type { ChartSeries } from "../StackedBarChart";
import { sourceColor } from "../ui";

/** The day axis both per-day charts share: one row per local day of the window, idle days included. */
export interface DayAxis {
  /** Full label per column ("Mon, 6 Oct"), for the tooltip and the table view. */
  labels: string[];
  /** Short axis label per column. */
  ticks: string[];
  /** Link per column: opens that day's panel, or closes it again when it is the open one. */
  hrefs: string[];
  /** One stacked series per tool present in the window, measured by `value`. */
  series: (value: (row: DailyRow) => number) => ChartSeries[];
}

export interface WidgetContext {
  db: Db;
  filters: PageFilters;
  /** The server's clock at render; passed around so every "x ago" on the page agrees. */
  now: number;
  /** End of the window: a custom range ends where it ends, not today. */
  until: number;
  /** "last 30 days", "all time", "6–8 Oct": the time scope in words. */
  rangeLabel: string;
  /** The day the `?day=` panel shows, or null. */
  day: string | null;
  /** The page's filters as query parameters: what drill-downs and export links carry on. */
  query: Record<string, string | undefined>;
  /** A link back to the overview with the page's state kept, the customize mode included. */
  href: (changes: Record<string, string | undefined>) => string;
  /** Whether the layout shows a widget: an in-page anchor to a hidden card would lead nowhere. */
  shows: (id: string) => boolean;
  /** Body height the slot's preset allows, in pixels: a chart draws that tall, a table scrolls inside it. */
  height: number;
  overview: () => Overview;
  dayAxis: () => DayAxis;
}

export interface ContextInput {
  db: Db;
  filters: PageFilters;
  now: number;
  until: number;
  rangeLabel: string;
  day: string | null;
  query: Record<string, string | undefined>;
  /** The customize mode, kept by every link back to the overview. */
  customize: boolean;
  layout: readonly Slot[];
}

/** A path with the non-empty parameters of `query` appended. */
export function linkTo(path: string, query: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) qs.set(k, v);
  return qs.size ? `${path}?${qs}` : path;
}

export function widgetContext(input: ContextInput): WidgetContext {
  const shown = new Set(input.layout.map((s) => s.id));
  const href = (changes: Record<string, string | undefined>) => linkTo("/", { ...input.query, customize: input.customize ? "1" : undefined, ...changes });
  let totals: Overview | undefined;
  let axis: DayAxis | undefined;
  return {
    db: input.db,
    filters: input.filters,
    now: input.now,
    until: input.until,
    rangeLabel: input.rangeLabel,
    day: input.day,
    query: input.query,
    href,
    shows: (id) => shown.has(id),
    // Overwritten per slot in the grid; a widget rendered outside one gets the middle preset.
    height: 340,
    overview: () => (totals ??= overview(input.db, input.filters)),
    dayAxis: () => (axis ??= buildDayAxis(input, href)),
  };
}

function buildDayAxis(input: ContextInput, href: (changes: Record<string, string | undefined>) => string): DayAxis {
  const rows = daily(input.db, input.filters);
  // Continuous day axis so idle days show as gaps rather than disappearing.
  const firstDay = input.filters.from ? localDay(input.filters.from) : rows[0]?.day;
  const days = firstDay ? dayRange(firstDay, localDay(input.until)) : [];
  const present = new Set(rows.map((d) => d.source));
  const sources = [...adapters.map((a) => a.id), ...[...present].filter((s) => !adapters.some((a) => a.id === s))].filter((s) => present.has(s));
  return {
    labels: days.map((d) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })),
    ticks: days.map(shortDay),
    // A column opens the day panel below the charts; the day it already shows closes it again.
    hrefs: days.map((d) => `${href({ day: d === input.day ? undefined : d })}#day-panel`),
    series: (value) =>
      sources.map((source) => ({
        key: source,
        label: sourceLabel(source),
        color: sourceColor(source),
        values: days.map((day) => {
          const row = rows.find((d) => d.day === day && d.source === source);
          return row ? value(row) : 0;
        }),
      })),
  };
}


