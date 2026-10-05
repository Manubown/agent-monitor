import type { SQLInputValue } from "node:sqlite";
import { normalizeModel } from "../core/pricing";
import type { UsageInput } from "../core/windows";
import type { Db } from "./db";

/** Scope applied to every query on a page, so all numbers on screen agree. */
export interface Filters {
  /** Epoch ms lower bound (inclusive). */
  from?: number;
  source?: string;
  /** Exact working directory. */
  cwd?: string;
  /** Substring match on title or working directory. */
  q?: string;
  /** Manual tag; matches tagged sessions and everything they spawned. */
  tag?: string;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

/** WHERE clause over the `sessions` alias `s`; `tsColumn` is the time column to bound (null: leave time to the caller). */
function where(f: Filters, tsColumn: string | null): { sql: string; params: SQLInputValue[] } {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (tsColumn && f.from !== undefined) {
    clauses.push(`${tsColumn} >= ?`);
    params.push(f.from);
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
      `s.id IN (WITH RECURSIVE tagged(id) AS (SELECT session_id FROM user.tags WHERE tag = ?
         UNION SELECT c.id FROM sessions c JOIN tagged ON c.parent_id = tagged.id) SELECT id FROM tagged)`,
    );
    params.push(f.tag);
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
  // A session counts when it was active in the range, not only when it started there.
  const ws = where(f, "s.ended_at");
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
}

const SESSION_COLUMNS = `
  s.id, s.source, s.native_id AS nativeId, s.parent_id AS parentId, s.file_path AS filePath, s.title, s.cwd,
  s.git_branch AS gitBranch, s.agent_version AS agentVersion, s.models, s.started_at AS startedAt, s.ended_at AS endedAt,
  s.event_count AS eventCount, s.user_messages AS userMessages, s.tool_calls AS toolCalls, s.tool_errors AS toolErrors,
  s.errors, s.requests, s.input_tokens AS input, s.output_tokens AS output, s.cache_read_tokens AS cacheRead,
  s.cache_write_tokens AS cacheWrite, s.reasoning_tokens AS reasoning, s.cost_usd AS cost, s.cost_source AS costSource,
  (SELECT json_group_array(tag) FROM (SELECT tag FROM user.tags WHERE session_id = s.id ORDER BY tag)) AS tags`;

const toSession = (row: Record<string, unknown>): SessionRow =>
  ({ ...row, models: JSON.parse(String(row.models)), tags: JSON.parse(String(row.tags ?? "[]")) }) as SessionRow;

/** A top-level session with its subagents' work rolled in. */
export interface SessionSummary extends SessionRow {
  subagents: number;
  total: TokenTotals & { cost: number | null; toolCalls: number; errors: number; lastActive: number };
}

/** Every session id with the id of its top-level ancestor. */
const TREE = `
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

/**
 * Top-level sessions with activity (their own or a subagent's) in the range, most recently active first.
 * The order is total (ties broken by id) so pages never overlap; `limit: -1` returns every row.
 */
export function listSessions(db: Db, f: Filters, page: { limit: number; offset: number }): { rows: SessionSummary[]; total: number } {
  const w = where(f, null);
  const having = f.from !== undefined ? "HAVING MAX(x.ended_at) >= ?" : "";
  const params = f.from !== undefined ? [...w.params, f.from] : w.params;
  const grouped = `FROM tree JOIN sessions s ON s.id = tree.root JOIN sessions x ON x.id = tree.id ${w.sql} GROUP BY s.id ${having}`;
  const rows = db
    .prepare(`${TREE} SELECT ${SESSION_COLUMNS}, ${ROLLUP} ${grouped} ORDER BY MAX(x.ended_at) DESC, s.id LIMIT ? OFFSET ?`)
    .all(...params, page.limit, page.offset) as Record<string, unknown>[];
  const { total } = db.prepare(`${TREE} SELECT COUNT(*) AS total FROM (SELECT s.id ${grouped})`).get(...params) as { total: number };
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
    `WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT c.id FROM sessions c JOIN t ON c.parent_id = t.id)
     SELECT kind, tool_name AS toolName, ts FROM events WHERE session_id IN (SELECT id FROM t) ORDER BY ts DESC, seq DESC LIMIT 1`,
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

/** Every manual tag with the number of sessions carrying it, most used first. Plain objects: the result is passed to a client component. */
export function allTags(db: Db): { tag: string; count: number }[] {
  const rows = db.prepare("SELECT tag, COUNT(*) AS count FROM user.tags GROUP BY tag ORDER BY count DESC, tag").all() as { tag: string; count: number }[];
  return rows.map(({ tag, count }) => ({ tag, count }));
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
  /** Events per kind over the whole session (the timeline itself is paged, see `sessionEvents`). */
  kindCounts: Record<string, number>;
  usage: UsageRow[];
  tools: ToolRow[];
}

export function getSession(db: Db, id: string): SessionDetail | null {
  const row = db
    .prepare(
      `WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT c.id FROM sessions c JOIN tree ON c.parent_id = tree.id)
       SELECT ${SESSION_COLUMNS}, ${ROLLUP}
       FROM tree JOIN sessions x ON x.id = tree.id JOIN sessions s ON s.id = ?
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
  const kindCounts: Record<string, number> = {};
  for (const r of db.prepare("SELECT kind, COUNT(*) AS n FROM events WHERE session_id = ? GROUP BY kind").all(id) as { kind: string; n: number }[]) {
    kindCounts[r.kind] = r.n;
  }
  const usage = db
    .prepare(
      `SELECT seq, ts, model, input, output, cache_read AS cacheRead, cache_write AS cacheWrite, reasoning, cost_usd AS cost, cost_source AS costSource
       FROM usage WHERE session_id = ? ORDER BY seq`,
    )
    .all(id) as unknown as UsageRow[];
  return { session, parent, root, children, kindCounts, usage, tools: byTool(db, {}, id) };
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

/** Events with seq in [from, to), in order; omit `to` for "to the end". */
export function sessionEvents(db: Db, id: string, from = 0, to?: number): EventRow[] {
  return db
    .prepare(
      `SELECT seq, ts, kind, text, tool_name AS toolName, tool_call_id AS toolCallId, tool_input AS toolInput, is_error AS isError, model
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
