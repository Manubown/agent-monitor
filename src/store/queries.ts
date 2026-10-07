import type { SQLInputValue } from "node:sqlite";
import type { AutoTag } from "../core/autotags";
import { normalizeModel } from "../core/pricing";
import type { UsageInput } from "../core/windows";
import type { Db } from "./db";
import { SUBTREE } from "./tree";

/** Scope applied to every query on a page, so all numbers on screen agree. */
export interface Filters {
  /** Epoch ms lower bound (inclusive). */
  from?: number;
  /** Epoch ms upper bound (exclusive); with `from` it makes a custom window such as one local day. */
  to?: number;
  source?: string;
  /** Exact working directory. */
  cwd?: string;
  /** Substring match on title or working directory. */
  q?: string;
  /** Manual or automatic tag; matches tagged sessions and everything they spawned. */
  tag?: string;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

/**
 * Sessions with an event or a model request inside `[from, to)`: what "active on this day" means for the day panel
 * and for a custom window. A tree's `ended_at` alone cannot say it, because a session that started before the window
 * and ended after it may have done nothing inside.
 */
function activityWindow(from: number | undefined, to: number): { sql: string; params: number[] } {
  const bounds = from === undefined ? "ts < ?" : "ts >= ? AND ts < ?";
  const args = from === undefined ? [to] : [from, to];
  return {
    sql: `SELECT session_id FROM events WHERE ${bounds} UNION SELECT session_id FROM usage WHERE ${bounds}`,
    params: [...args, ...args],
  };
}

/**
 * The time column of queries that scope whole sessions ("active in the range"). Its lower bound is the session's last
 * activity, but an upper bound has to ask for activity inside the window: `ended_at < to` would drop every session
 * that is still running, and would disagree with `listSessions` and the day panel.
 */
export const SESSION_ACTIVE = "s.ended_at";

/** WHERE clause over the `sessions` alias `s`; `tsColumn` is the time column to bound (null: leave time to the caller). */
export function where(f: Filters, tsColumn: string | null): { sql: string; params: SQLInputValue[] } {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (tsColumn === SESSION_ACTIVE && f.to !== undefined) {
    const window = activityWindow(f.from, f.to);
    clauses.push(`s.id IN (${window.sql})`);
    params.push(...window.params);
  } else {
    if (tsColumn && f.from !== undefined) {
      clauses.push(`${tsColumn} >= ?`);
      params.push(f.from);
    }
    if (tsColumn && f.to !== undefined) {
      clauses.push(`${tsColumn} < ?`);
      params.push(f.to);
    }
  }
  if (f.source) {
    clauses.push("s.source = ?");
    params.push(f.source);
  }
  if (f.cwd) {
    clauses.push("s.cwd = ?");
    params.push(f.cwd);
  }
  if (f.q) {
    clauses.push("(s.title LIKE ? OR s.cwd LIKE ? OR s.native_id LIKE ?)");
    const like = `%${f.q}%`;
    params.push(like, like, like);
  }
  if (f.tag) {
    clauses.push(
      `s.id IN (WITH RECURSIVE tagged(id) AS (
         SELECT session_id FROM (SELECT session_id FROM user.tags WHERE tag = ? UNION SELECT session_id FROM auto_tags WHERE tag = ?)
         UNION SELECT c.id FROM sessions c JOIN tagged ON c.parent_id = tagged.id) SELECT id FROM tagged)`,
    );
    params.push(f.tag, f.tag);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

const TOKEN_SUMS = `
  COALESCE(SUM(u.input), 0)       AS input,
  COALESCE(SUM(u.output), 0)      AS output,
  COALESCE(SUM(u.cache_read), 0)  AS cacheRead,
  COALESCE(SUM(u.cache_write), 0) AS cacheWrite,
  COALESCE(SUM(u.reasoning), 0)   AS reasoning,
  COUNT(u.seq)                    AS requests,
  SUM(u.cost_usd)                 AS cost`;

export interface Overview extends TokenTotals {
  sessions: number;
  subagents: number;
  userMessages: number;
  toolCalls: number;
  errors: number;
  requests: number;
  cost: number | null;
  estimatedCost: number | null;
  unpricedTokens: number;
}

export function overview(db: Db, f: Filters): Overview {
  // A session counts when it was active in the range, not only when it started there (and not only when it ended in it).
  const ws = where(f, SESSION_ACTIVE);
  const sessions = db
    .prepare(
      `SELECT COALESCE(SUM(s.parent_id IS NULL), 0) AS sessions, COALESCE(SUM(s.parent_id IS NOT NULL), 0) AS subagents,
              COALESCE(SUM(s.user_messages), 0) AS userMessages, COALESCE(SUM(s.tool_calls), 0) AS toolCalls,
              COALESCE(SUM(s.errors + s.tool_errors), 0) AS errors
       FROM sessions s ${ws.sql}`,
    )
    .get(...ws.params) as Pick<Overview, "sessions" | "subagents" | "userMessages" | "toolCalls" | "errors">;
  const wu = where(f, "u.ts");
  const usage = db
    .prepare(
      `SELECT ${TOKEN_SUMS},
              SUM(CASE WHEN u.cost_source = 'estimated' THEN u.cost_usd END) AS estimatedCost,
              COALESCE(SUM(CASE WHEN u.cost_source = 'unpriced' THEN u.input + u.output + u.cache_read + u.cache_write END), 0) AS unpricedTokens
       FROM usage u JOIN sessions s ON s.id = u.session_id ${wu.sql}`,
    )
    .get(...wu.params) as Omit<Overview, keyof typeof sessions>;
  return { ...sessions, ...usage };
}

export interface DailyRow extends TokenTotals {
  day: string;
  source: string;
  requests: number;
  cost: number | null;
}

/** Usage per local calendar day and source. */
export function daily(db: Db, f: Filters): DailyRow[] {
  const w = where(f, "u.ts");
  return db
    .prepare(
      `SELECT date(u.ts / 1000, 'unixepoch', 'localtime') AS day, s.source AS source, ${TOKEN_SUMS}
       FROM usage u JOIN sessions s ON s.id = u.session_id ${w.sql}
       GROUP BY day, s.source ORDER BY day`,
    )
    .all(...w.params) as unknown as DailyRow[];
}

/** Event counts in equal time bins from `from` to `to`: the skyline of the pixel bands. */
export interface EventTimeline {
  from: number;
  to: number;
  binMs: number;
  counts: number[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BIN_STEPS = [1000, 5000, 10_000, 30_000, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];
/** About one bin per band column on a wide screen (narrower bands merge bins); headroom keeps exact 30-day ranges at 3 h. */
const TIMELINE_BINS = 256;

/** The smallest step from the ladder that covers `span` in at most TIMELINE_BINS bins. */
const binFor = (span: number): number => BIN_STEPS.find((b) => span / b <= TIMELINE_BINS) ?? Math.ceil(span / TIMELINE_BINS / (7 * DAY)) * 7 * DAY;

/** Bins `rows` of (bin index, count); indices outside the range (clock skew) are clamped onto its ends. */
function toTimeline(from: number, to: number, binMs: number, rows: { bin: number; n: number }[]): EventTimeline {
  const counts = new Array<number>(Math.max(1, Math.ceil((to - from) / binMs))).fill(0);
  for (const r of rows) counts[Math.min(counts.length - 1, Math.max(0, r.bin))] += r.n;
  return { from, to, binMs, counts };
}

/** Events of every kind per time bin over the filtered range (from the first filtered event when unbounded) up to `to`. */
export function eventTimeline(db: Db, f: Filters, to: number = Date.now()): EventTimeline {
  const w = where(f, "e.ts");
  const firstEvent = (): number | null => {
    // Row shape fixed by the SELECT list.
    const row = db.prepare(`SELECT MIN(e.ts) AS first FROM events e JOIN sessions s ON s.id = e.session_id ${w.sql}`).get(...w.params) as { first: number | null };
    return row.first;
  };
  const from = Math.min(f.from ?? firstEvent() ?? to, to);
  const binMs = binFor(to - from);
  const rows = db
    .prepare(`SELECT CAST((e.ts - ?) / ? AS INTEGER) AS bin, COUNT(*) AS n FROM events e JOIN sessions s ON s.id = e.session_id ${w.sql} GROUP BY bin`)
    .all(from, binMs, ...w.params) as unknown as { bin: number; n: number }[];
  return toTimeline(from, to, binMs, rows);
}

/** Events per time bin of a session and everything it spawned, over the tree's own span. Null without events. */
export function sessionEventTimeline(db: Db, sessionId: string): EventTimeline | null {
  const span = db.prepare(`${SUBTREE} SELECT MIN(e.ts) AS lo, MAX(e.ts) AS hi FROM events e JOIN tree ON e.session_id = tree.id`).get(sessionId) as {
    lo: number | null;
    hi: number | null;
  };
  if (span.lo === null || span.hi === null) return null;
  // Inclusive end: the last event gets a bin of its own rather than sitting on the boundary.
  const binMs = binFor(span.hi - span.lo + 1);
  const rows = db
    .prepare(`${SUBTREE} SELECT CAST((e.ts - ?) / ? AS INTEGER) AS bin, COUNT(*) AS n FROM events e JOIN tree ON e.session_id = tree.id GROUP BY bin`)
    .all(sessionId, span.lo, binMs) as unknown as { bin: number; n: number }[];
  return toTimeline(span.lo, span.hi + 1, binMs, rows);
}

export interface ModelRow extends TokenTotals {
  model: string;
  source: string;
  requests: number;
  cost: number | null;
  costSource: string;
}

export function byModel(db: Db, f: Filters): ModelRow[] {
  const w = where(f, "u.ts");
  return db
    .prepare(
      `SELECT u.model AS model, s.source AS source, ${TOKEN_SUMS},
              CASE WHEN COUNT(DISTINCT u.cost_source) = 1 THEN MIN(u.cost_source) ELSE 'mixed' END AS costSource
       FROM usage u JOIN sessions s ON s.id = u.session_id ${w.sql}
       GROUP BY u.model, s.source ORDER BY COALESCE(SUM(u.cost_usd), 0) DESC, output DESC`,
    )
    .all(...w.params) as unknown as ModelRow[];
}

export interface ProjectRow extends TokenTotals {
  cwd: string | null;
  sessions: number;
  requests: number;
  cost: number | null;
  lastActive: number;
}

export function byProject(db: Db, f: Filters): ProjectRow[] {
  const w = where(f, "u.ts");
  return db
    .prepare(
      `SELECT s.cwd AS cwd, COUNT(DISTINCT CASE WHEN s.parent_id IS NULL THEN s.id END) AS sessions, ${TOKEN_SUMS},
              MAX(u.ts) AS lastActive
       FROM usage u JOIN sessions s ON s.id = u.session_id ${w.sql}
       GROUP BY s.cwd ORDER BY COALESCE(SUM(u.cost_usd), 0) DESC, output DESC`,
    )
    .all(...w.params) as unknown as ProjectRow[];
}

export interface ToolRow {
  tool: string;
  calls: number;
  errors: number;
}

export function byTool(db: Db, f: Filters, sessionId?: string): ToolRow[] {
  const w = where(f, "e.ts");
  const scope = sessionId ? `${w.sql ? `${w.sql} AND` : "WHERE"} e.session_id = ?` : w.sql;
  const params = sessionId ? [...w.params, sessionId] : w.params;
  return db
    .prepare(
      `SELECT COALESCE(e.tool_name, '(unknown)') AS tool,
              SUM(e.kind = 'tool_call') AS calls,
              SUM(e.kind = 'tool_result' AND e.is_error = 1) AS errors
       FROM events e JOIN sessions s ON s.id = e.session_id ${scope}
       ${scope ? "AND" : "WHERE"} e.kind IN ('tool_call', 'tool_result')
       GROUP BY tool HAVING calls > 0 ORDER BY calls DESC`,
    )
    .all(...params) as unknown as ToolRow[];
}

export interface SessionRow {
  id: string;
  source: string;
  nativeId: string;
  parentId: string | null;
  /** Subagents: seq of the event holding the prompt the spawning agent sent (see `dispatchPrompts`). */
  dispatchSeq: number | null;
  filePath: string;
  title: string | null;
  cwd: string | null;
  gitBranch: string | null;
  agentVersion: string | null;
  models: string[];
  startedAt: number;
  endedAt: number;
  eventCount: number;
  userMessages: number;
  toolCalls: number;
  toolErrors: number;
  errors: number;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number | null;
  costSource: string;
  /** Manual tags, alphabetical. */
  tags: string[];
  /** Automatic tags (src/core/autotags.ts), alphabetical, without those also set manually. */
  autoTags: AutoTag[];
}

const SESSION_COLUMNS = `
  s.id, s.source, s.native_id AS nativeId, s.parent_id AS parentId, s.dispatch_seq AS dispatchSeq, s.file_path AS filePath, s.title, s.cwd,
  s.git_branch AS gitBranch, s.agent_version AS agentVersion, s.models, s.started_at AS startedAt, s.ended_at AS endedAt,
  s.event_count AS eventCount, s.user_messages AS userMessages, s.tool_calls AS toolCalls, s.tool_errors AS toolErrors,
  s.errors, s.requests, s.input_tokens AS input, s.output_tokens AS output, s.cache_read_tokens AS cacheRead,
  s.cache_write_tokens AS cacheWrite, s.reasoning_tokens AS reasoning, s.cost_usd AS cost, s.cost_source AS costSource,
  (SELECT json_group_array(tag) FROM (SELECT tag FROM user.tags WHERE session_id = s.id ORDER BY tag)) AS tags,
  (SELECT json_group_array(json_object('tag', tag, 'reason', reason)) FROM (
     SELECT tag, reason FROM auto_tags WHERE session_id = s.id AND tag NOT IN (SELECT tag FROM user.tags WHERE session_id = s.id) ORDER BY tag
   )) AS autoTags`;

const toSession = (row: Record<string, unknown>): SessionRow =>
  ({
    ...row,
    models: JSON.parse(String(row.models)),
    tags: JSON.parse(String(row.tags ?? "[]")),
    autoTags: JSON.parse(String(row.autoTags ?? "[]")),
  }) as SessionRow;

/** A top-level session with its subagents' work rolled in. */
export interface SessionSummary extends SessionRow {
  subagents: number;
  total: TokenTotals & { cost: number | null; toolCalls: number; errors: number; lastActive: number };
}

/**
 * Every session id with the id of its top-level ancestor. Only sessions below a root are reached; sync stores no parent
 * cycles (writeSession breaks them), so that is every session.
 */
export const TREE = `
  WITH RECURSIVE tree(root, id) AS (
    SELECT id, id FROM sessions WHERE parent_id IS NULL OR parent_id NOT IN (SELECT id FROM sessions)
    UNION ALL
    SELECT tree.root, c.id FROM sessions c JOIN tree ON c.parent_id = tree.id
  )`;

const ROLLUP = `
  COUNT(*) - 1 AS subagents,
  SUM(x.input_tokens) AS t_input, SUM(x.output_tokens) AS t_output, SUM(x.cache_read_tokens) AS t_cacheRead,
  SUM(x.cache_write_tokens) AS t_cacheWrite, SUM(x.reasoning_tokens) AS t_reasoning, SUM(x.cost_usd) AS t_cost,
  SUM(x.tool_calls) AS t_toolCalls, SUM(x.errors + x.tool_errors) AS t_errors, MAX(x.ended_at) AS t_lastActive`;

const toSummary = (row: Record<string, unknown>): SessionSummary => {
  const base = toSession(row);
  return {
    ...base,
    subagents: Number(row.subagents),
    total: {
      input: Number(row.t_input),
      output: Number(row.t_output),
      cacheRead: Number(row.t_cacheRead),
      cacheWrite: Number(row.t_cacheWrite),
      reasoning: Number(row.t_reasoning),
      cost: row.t_cost === null ? null : Number(row.t_cost),
      toolCalls: Number(row.t_toolCalls),
      errors: Number(row.t_errors),
      lastActive: Number(row.t_lastActive),
    },
  };
};

/** Orders for the sessions list; every one but `recent` ranks by the rolled-up totals of the session tree. */
export const SESSION_SORTS = ["recent", "cost", "tokens", "requests", "tools", "errors", "duration"] as const;
export type SessionSort = (typeof SESSION_SORTS)[number];

export const isSessionSort = (v: unknown): v is SessionSort => SESSION_SORTS.includes(v as SessionSort);

const SORT_KEY: Record<Exclude<SessionSort, "recent">, string> = {
  cost: "SUM(x.cost_usd)",
  tokens: "SUM(x.input_tokens + x.output_tokens + x.cache_read_tokens + x.cache_write_tokens)",
  requests: "SUM(x.requests)",
  tools: "SUM(x.tool_calls)",
  errors: "SUM(x.errors + x.tool_errors)",
  duration: "MAX(x.ended_at) - s.started_at",
};

/**
 * Top-level sessions with activity (their own or a subagent's) in the range, most recently active first unless `sort`
 * says otherwise (descending; unpriced cost sorts last). The order is total (ties broken by last activity, then id) so
 * pages never overlap; `limit: -1` returns every row.
 */
export function listSessions(
  db: Db,
  f: Filters,
  page: { limit: number; offset: number },
  sort: SessionSort = "recent",
): { rows: SessionSummary[]; total: number } {
  const w = where(f, null);
  // An open-ended range only needs the tree's last activity; a bounded one asks for activity inside the window.
  const window = f.to === undefined ? null : activityWindow(f.from, f.to);
  const cte = window ? `${TREE}, active(id) AS (${window.sql})` : TREE;
  const having = window ? "HAVING MAX(x.id IN (SELECT id FROM active)) = 1" : f.from !== undefined ? "HAVING MAX(x.ended_at) >= ?" : "";
  const params = [...(window?.params ?? []), ...w.params, ...(!window && f.from !== undefined ? [f.from] : [])];
  const grouped = `FROM tree JOIN sessions s ON s.id = tree.root JOIN sessions x ON x.id = tree.id ${w.sql} GROUP BY s.id ${having}`;
  const order = `${sort === "recent" ? "" : `${SORT_KEY[sort]} DESC, `}MAX(x.ended_at) DESC, s.id`;
  const rows = db
    .prepare(`${cte} SELECT ${SESSION_COLUMNS}, ${ROLLUP} ${grouped} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, page.limit, page.offset) as Record<string, unknown>[];
  const { total } = db.prepare(`${cte} SELECT COUNT(*) AS total FROM (SELECT s.id ${grouped})`).get(...params) as { total: number };
  return { rows: rows.map(toSummary), total };
}

/** A session tree counts as active while its last activity (own or a subagent's) is this recent. */
export const ACTIVE_WINDOW_MS = 120_000;

export const isActive = (lastActive: number, now: number): boolean => now - lastActive <= ACTIVE_WINDOW_MS;

export interface ActiveSession extends SessionSummary {
  /** Model of the session's most recent request (falls back to its heaviest model). */
  currentModel: string | null;
  /** Most recent event anywhere in the tree. */
  lastEvent: { kind: string; toolName: string | null; ts: number } | null;
}

/** Top-level sessions whose tree was active within ACTIVE_WINDOW_MS of `now`, most recently active first. */
export function activeSessions(db: Db, now: number): ActiveSession[] {
  const rows = db
    .prepare(
      `${TREE} SELECT ${SESSION_COLUMNS}, ${ROLLUP}
       FROM tree JOIN sessions s ON s.id = tree.root JOIN sessions x ON x.id = tree.id
       GROUP BY s.id HAVING MAX(x.ended_at) >= ? ORDER BY MAX(x.ended_at) DESC, s.id`,
    )
    .all(now - ACTIVE_WINDOW_MS) as Record<string, unknown>[];
  const lastEvent = db.prepare(
    `${SUBTREE}
     SELECT kind, tool_name AS toolName, ts FROM events WHERE session_id IN (SELECT id FROM tree) ORDER BY ts DESC, seq DESC LIMIT 1`,
  );
  const lastModel = db.prepare("SELECT model FROM usage WHERE session_id = ? ORDER BY ts DESC, seq DESC LIMIT 1");
  return rows.map((row) => {
    const s = toSummary(row);
    const model = lastModel.get(s.id) as { model: string } | undefined;
    return {
      ...s,
      currentModel: model?.model ?? s.models[0] ?? null,
      lastEvent: (lastEvent.get(s.id) as ActiveSession["lastEvent"] | undefined) ?? null,
    };
  });
}

/**
 * Every tag, manual or automatic, with the number of sessions carrying it; `auto` when no session has it manually.
 * Manual tags first, then most used. Plain objects: the result is passed to a client component.
 */
export function allTags(db: Db): { tag: string; count: number; auto: boolean }[] {
  const rows = db
    .prepare(
      `SELECT tag, COUNT(DISTINCT session_id) AS count, MIN(auto) AS auto
       FROM (SELECT tag, session_id, 0 AS auto FROM user.tags UNION ALL SELECT tag, session_id, 1 FROM auto_tags)
       GROUP BY tag ORDER BY auto, count DESC, tag`,
    )
    .all() as { tag: string; count: number; auto: number }[];
  return rows.map(({ tag, count, auto }) => ({ tag, count, auto: auto === 1 }));
}

const TAG_PATTERN = /^[a-z0-9][a-z0-9_/-]{0,39}$/;

/** Canonical form of a user-typed tag ("#Bug-Fix " -> "bug-fix"); null when it is not a valid tag. */
export function normalizeTag(raw: string): string | null {
  const tag = raw.trim().replace(/^#+/, "").trim().toLowerCase();
  return TAG_PATTERN.test(tag) ? tag : null;
}

/** Claude usage rows for the 5-hour window view, attributed to their top-level session. */
export function claudeUsage(db: Db, f: Filters): UsageInput[] {
  const w = where(f, "u.ts");
  const rows = db
    .prepare(
      `${TREE} SELECT u.ts, u.model, tree.root AS sessionId, r.title, u.input, u.output, u.cache_read AS cacheRead,
              u.cache_write AS cacheWrite, u.reasoning, u.cost_usd AS cost
       FROM usage u JOIN tree ON tree.id = u.session_id JOIN sessions r ON r.id = tree.root JOIN sessions s ON s.id = u.session_id
       ${w.sql} ${w.sql ? "AND" : "WHERE"} lower(u.model) LIKE '%claude%'
       ORDER BY u.ts`,
    )
    .all(...w.params) as unknown as UsageInput[];
  return rows.filter((r) => normalizeModel(r.model).startsWith("claude"));
}

export interface EventRow {
  seq: number;
  ts: number;
  kind: string;
  text: string | null;
  toolName: string | null;
  toolCallId: string | null;
  toolInput: string | null;
  isError: number;
  model: string | null;
}

export interface UsageRow extends TokenTotals {
  seq: number;
  ts: number;
  model: string;
  cost: number | null;
  costSource: string;
}

export interface SessionDetail {
  session: SessionSummary;
  parent: { id: string; title: string | null } | null;
  /** Top-level ancestor (the session itself when it has no parent): what a resume command reopens. */
  root: { id: string; source: string; nativeId: string; cwd: string | null; filePath: string };
  children: SessionRow[];
  /** Events per timeline chip over the whole session (the timeline itself is paged, see `timelinePage`). */
  timelineCounts: Record<TimelineKind, number>;
  usage: UsageRow[];
  tools: ToolRow[];
}

export function getSession(db: Db, id: string): SessionDetail | null {
  const row = db
    .prepare(
      `${SUBTREE}
       SELECT ${SESSION_COLUMNS}, ${ROLLUP}
       FROM tree t JOIN sessions x ON x.id = t.id JOIN sessions s ON s.id = ?
       GROUP BY s.id`,
    )
    .get(id, id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const session = toSummary(row);
  const parent = session.parentId
    ? ((db.prepare("SELECT id, title FROM sessions WHERE id = ?").get(session.parentId) as SessionDetail["parent"]) ?? null)
    : null;
  const root = db
    .prepare(
      `WITH RECURSIVE up(id, parent, depth) AS (
         SELECT id, parent_id, 0 FROM sessions WHERE id = ?
         UNION ALL SELECT p.id, p.parent_id, up.depth + 1 FROM sessions p JOIN up ON p.id = up.parent WHERE up.depth < 64)
       SELECT s.id, s.source, s.native_id AS nativeId, s.cwd, s.file_path AS filePath
       FROM up JOIN sessions s ON s.id = up.id ORDER BY up.depth DESC LIMIT 1`,
    )
    .get(id) as SessionDetail["root"];
  const children = (
    db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions s WHERE s.parent_id = ? ORDER BY s.started_at`).all(id) as Record<string, unknown>[]
  ).map(toSession);
  const timelineCounts = db
    .prepare(
      `SELECT ${TIMELINE_KINDS.map((k) => `COALESCE(SUM(${k === "tools" ? "kind = 'tool_call'" : KIND_MATCH[k]}), 0) AS ${k}`).join(", ")}
       FROM events WHERE session_id = ?`,
    )
    .get(id) as Record<TimelineKind, number>;
  const usage = db
    .prepare(
      `SELECT seq, ts, model, input, output, cache_read AS cacheRead, cache_write AS cacheWrite, reasoning, cost_usd AS cost, cost_source AS costSource
       FROM usage WHERE session_id = ? ORDER BY seq`,
    )
    .all(id) as unknown as UsageRow[];
  return { session, parent, root, children, timelineCounts: { ...timelineCounts }, usage, tools: byTool(db, {}, id) };
}

/** Events per timeline page: long sessions have thousands, and the page re-renders on every live update. */
export const TIMELINE_PAGE = 200;

/** The slice [from, to) of a session's events the timeline shows. */
export interface TimelineWindow {
  from: number;
  to: number;
  total: number;
  /** The window runs to the newest event and keeps following it as the session grows. */
  tail: boolean;
}

/**
 * Which events the timeline shows. Default: the newest page, following live
 * updates. `at` (a search hit): a page centered on that event. `from`/`to`: an
 * explicit range, grown a page at a time by the "earlier"/"later" links; no
 * `to` means "up to the newest event".
 */
export function timelineWindow(total: number, p: { from?: number; to?: number; at?: number }): TimelineWindow {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.trunc(n)));
  if (p.at !== undefined && p.at >= 0 && p.at < total) {
    const to = Math.min(total, Math.max(0, Math.trunc(p.at) - TIMELINE_PAGE / 2) + TIMELINE_PAGE);
    return { from: Math.max(0, to - TIMELINE_PAGE), to, total, tail: to === total };
  }
  const to = p.to === undefined ? total : clamp(p.to, 0, total);
  const from = p.from === undefined ? Math.max(0, to - TIMELINE_PAGE) : clamp(p.from, 0, to);
  return { from, to, total, tail: p.to === undefined };
}

/** Event types the timeline filter toggles; `tools` is a call and its result, `error` also covers failed tool results. */
export const TIMELINE_KINDS = ["user", "assistant", "thinking", "tools", "system", "error"] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/** Shown while the URL names none: thinking and system notes are noise to most readers. */
export const DEFAULT_TIMELINE_KINDS: readonly TimelineKind[] = ["user", "assistant", "tools", "error"];

const KIND_MATCH: Record<TimelineKind, string> = {
  user: "kind = 'user'",
  assistant: "kind = 'assistant'",
  thinking: "kind = 'thinking'",
  tools: "kind IN ('tool_call', 'tool_result')",
  system: "kind = 'system'",
  error: "(kind = 'error' OR (kind = 'tool_result' AND is_error = 1))",
};

/** The `kinds` query parameter (comma-separated); absent means the defaults, empty means none. */
export function parseTimelineKinds(v: string | string[] | undefined): TimelineKind[] {
  if (v === undefined) return [...DEFAULT_TIMELINE_KINDS];
  const named = new Set((Array.isArray(v) ? v.join(",") : v).split(","));
  return TIMELINE_KINDS.filter((k) => named.has(k));
}

export interface TimelinePage extends TimelineWindow {
  /** The page's events in order; `from`/`to`/`total` count matching events, not sequence numbers. */
  events: EventRow[];
}

/**
 * One page of the events matching `kinds`. Paging runs over the matching
 * events only, so a filter never leaves a page empty while matches exist
 * elsewhere. `at` (a sequence number, from a search hit or a graph) centers the
 * page on that event and keeps it listed even when its type is filtered out.
 */
export function timelinePage(db: Db, id: string, p: { kinds: readonly TimelineKind[]; from?: number; to?: number; at?: number }): TimelinePage {
  const kinds = p.kinds.map((k) => KIND_MATCH[k]).join(" OR ") || "0";
  const at = p.at ?? -1;
  const match = `session_id = ? AND (${kinds} OR seq = ?)`;
  // The hit always matches when it exists; `before` is its position among the matching events.
  const counts = db
    .prepare(`SELECT COUNT(*) AS total, SUM(seq < ?) AS before, MAX(seq = ?) AS found FROM events WHERE ${match}`)
    .get(at, at, id, at) as { total: number; before: number | null; found: number | null };
  // A stale hit (no such event) falls back to the newest page; an explicit range (paging around the hit) wins over centering.
  const centered = p.at !== undefined && counts.found && p.from === undefined && p.to === undefined;
  const win = timelineWindow(counts.total, { from: p.from, to: p.to, at: centered ? (counts.before ?? 0) : undefined });
  const events = db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE ${match} ORDER BY seq LIMIT ? OFFSET ?`)
    .all(id, at, win.to - win.from, win.from) as unknown as EventRow[];
  return { ...win, events };
}

const EVENT_COLUMNS = "seq, ts, kind, text, tool_name AS toolName, tool_call_id AS toolCallId, tool_input AS toolInput, is_error AS isError, model";

/** Events with seq in [from, to), in order; omit `to` for "to the end". */
export function sessionEvents(db: Db, id: string, from = 0, to?: number): EventRow[] {
  return db
    .prepare(
      `SELECT ${EVENT_COLUMNS}
       FROM events WHERE session_id = ? AND seq >= ? AND (? IS NULL OR seq < ?) ORDER BY seq`,
    )
    .all(id, from, to ?? null, to ?? null) as unknown as EventRow[];
}

/** Values for the filter controls. */
export function filterOptions(db: Db): { sources: string[]; projects: string[] } {
  const sources = (db.prepare("SELECT DISTINCT source FROM sessions ORDER BY source").all() as { source: string }[]).map((r) => r.source);
  const projects = (
    db.prepare("SELECT cwd FROM sessions WHERE cwd IS NOT NULL GROUP BY cwd ORDER BY MAX(ended_at) DESC").all() as { cwd: string }[]
  ).map((r) => r.cwd);
  return { sources, projects };
}

export interface SyncStatus {
  files: number;
  missing: number;
  errors: { path: string; error: string }[];
  lastSync: number | null;
}

export function syncStatus(db: Db): SyncStatus {
  const r = db
    .prepare("SELECT COUNT(*) AS files, COALESCE(SUM(missing), 0) AS missing, MAX(synced_at) AS lastSync FROM files")
    .get() as { files: number; missing: number; lastSync: number | null };
  const errors = db.prepare("SELECT path, error FROM files WHERE error IS NOT NULL").all() as { path: string; error: string }[];
  return { ...r, errors };
}
