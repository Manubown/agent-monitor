import { classifyError, ERROR_CATEGORY_KEYS, type ErrorCategory } from "../core/errors";
import { buildHeatmap, type CostRow, type Heatmap, heatmapStart, localDay, type SlotRow } from "../core/heatmap";
import type { Db } from "./db";
import { type Filters, where } from "./queries";

/*
 * Overview insights: the activity heatmap and the error taxonomy. Days and hours are local to the server process
 * (SQLite 'localtime', i.e. the TZ the server runs in), the same as the per-day charts.
 */

/** Events, sessions and cost per local day and per weekday x hour over the filtered range (the last HEATMAP_WEEKS weeks when unbounded). */
export function activityHeatmap(db: Db, f: Filters, now: number = Date.now()): Heatmap {
  const from = heatmapStart(f.from, now);
  const scoped = { ...f, from };
  const we = where(scoped, "e.ts");
  const slots = db
    .prepare(
      `SELECT strftime('%Y-%m-%d %H', e.ts / 1000, 'unixepoch', 'localtime') AS slot, COALESCE(s.parent_id, s.id) AS root, COUNT(*) AS events
       FROM events e JOIN sessions s ON s.id = e.session_id ${we.sql}
       GROUP BY slot, root`,
    )
    .all(...we.params) as unknown as SlotRow[];
  const wu = where(scoped, "u.ts");
  const costs = db
    .prepare(
      `SELECT strftime('%Y-%m-%d %H', u.ts / 1000, 'unixepoch', 'localtime') AS slot, SUM(u.cost_usd) AS cost
       FROM usage u JOIN sessions s ON s.id = u.session_id ${wu.sql}
       GROUP BY slot`,
    )
    .all(...wu.params) as unknown as CostRow[];
  return buildHeatmap(slots, costs, localDay(from), localDay(now));
}

// ---------- error taxonomy ----------

/** Characters of an error's text read from the database: its head plus its tail, where test and build summaries end up. */
const HEAD_CHARS = 1200;
const TAIL_CHARS = 400;
/** Characters of an example shown on the errors page. */
const SNIPPET_CHARS = 280;

export interface ErrorEvent {
  sessionId: string;
  title: string | null;
  seq: number;
  ts: number;
  /** Local calendar day. */
  day: string;
  source: string;
  /** Null for agent `error` events, which belong to no tool. */
  tool: string | null;
  kind: string;
  /** Clipped: head and tail of long texts. */
  text: string;
  category: ErrorCategory;
}

/** Failed tool results and error events in range, newest first, classified. */
export function errorEvents(db: Db, f: Filters): ErrorEvent[] {
  const w = where(f, "e.ts");
  // CROSS JOIN keeps sessions as the outer loop: only sessions with recorded failures are visited, each through the
  // events primary key, instead of scanning the whole events table.
  const rows = db
    .prepare(
      `SELECT e.session_id AS sessionId, s.title AS title, e.seq AS seq, e.ts AS ts, date(e.ts / 1000, 'unixepoch', 'localtime') AS day,
              s.source AS source, e.tool_name AS tool, e.kind AS kind,
              CASE WHEN length(e.text) > ${HEAD_CHARS + TAIL_CHARS} THEN substr(e.text, 1, ${HEAD_CHARS}) || char(10) || '…' || char(10) || substr(e.text, -${TAIL_CHARS})
                   ELSE COALESCE(e.text, '') END AS text
       FROM sessions s CROSS JOIN events e ON e.session_id = s.id
       ${w.sql ? `${w.sql} AND` : "WHERE"} (s.tool_errors > 0 OR s.errors > 0)
         AND (e.kind = 'error' OR (e.kind = 'tool_result' AND e.is_error = 1))
       ORDER BY e.ts DESC, e.seq DESC`,
    )
    .all(...w.params) as unknown as Omit<ErrorEvent, "category">[];
  return rows.map((r) => ({ ...r, category: classifyError(r.text, r.tool) }));
}

export type CategoryCounts = Record<ErrorCategory, number>;

export interface ErrorBreakdown<K> {
  key: K;
  total: number;
  counts: CategoryCounts;
}

export interface ErrorExample {
  sessionId: string;
  title: string | null;
  seq: number;
  ts: number;
  source: string;
  tool: string | null;
  snippet: string;
}

export interface ErrorTaxonomy {
  total: number;
  sessions: number;
  /** Every category, largest first (zeros last). */
  byCategory: { category: ErrorCategory; count: number }[];
  /** Largest first. */
  byTool: ErrorBreakdown<string | null>[];
  bySource: ErrorBreakdown<string>[];
  /** Days with errors, oldest first. */
  byDay: ErrorBreakdown<string>[];
  /** Newest first, at most `examples` per category. */
  examples: Record<ErrorCategory, ErrorExample[]>;
}

const emptyCounts = (): CategoryCounts => Object.fromEntries(ERROR_CATEGORY_KEYS.map((k) => [k, 0])) as CategoryCounts;

/** Whitespace collapsed, clipped to `max` characters. */
export const snippet = (text: string, max = SNIPPET_CHARS): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Totals per category, tool, source and day plus the newest examples; `events` newest first. */
export function summarizeErrors(events: ErrorEvent[], examples = 5): ErrorTaxonomy {
  const totals = emptyCounts();
  const tools = new Map<string | null, ErrorBreakdown<string | null>>();
  const sources = new Map<string, ErrorBreakdown<string>>();
  const days = new Map<string, ErrorBreakdown<string>>();
  const sessions = new Set<string>();
  const picked = Object.fromEntries(ERROR_CATEGORY_KEYS.map((k) => [k, [] as ErrorExample[]])) as Record<ErrorCategory, ErrorExample[]>;
  const bump = <K>(map: Map<K, ErrorBreakdown<K>>, key: K, category: ErrorCategory) => {
    let row = map.get(key);
    if (!row) map.set(key, (row = { key, total: 0, counts: emptyCounts() }));
    row.total += 1;
    row.counts[category] += 1;
  };
  for (const e of events) {
    totals[e.category] += 1;
    sessions.add(e.sessionId);
    bump(tools, e.tool, e.category);
    bump(sources, e.source, e.category);
    bump(days, e.day, e.category);
    const list = picked[e.category];
    if (list.length < examples) list.push({ sessionId: e.sessionId, title: e.title, seq: e.seq, ts: e.ts, source: e.source, tool: e.tool, snippet: snippet(e.text) });
  }
  const largest = <K>(map: Map<K, ErrorBreakdown<K>>) => [...map.values()].sort((a, b) => b.total - a.total);
  return {
    total: events.length,
    sessions: sessions.size,
    byCategory: ERROR_CATEGORY_KEYS.map((category) => ({ category, count: totals[category] })).sort((a, b) => b.count - a.count),
    byTool: largest(tools),
    bySource: largest(sources),
    byDay: [...days.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    examples: picked,
  };
}

export function errorTaxonomy(db: Db, f: Filters, examples = 5): ErrorTaxonomy {
  return summarizeErrors(errorEvents(db, f), examples);
}
