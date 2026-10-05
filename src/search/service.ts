import { sourceLabel } from "../adapters";
import type { AutoTag } from "../core/autotags";
import type { Db } from "../store/db";
import type { SearchIndex, SearchRequest } from "./native";
import { EVENT_KINDS, hasSessionFacets, isEmptyQuery, type ParsedQuery, parseQuery, type Sort } from "./query";

export interface SessionInfo {
  id: string;
  nativeId: string;
  title: string | null;
  source: string;
  sourceLabel: string;
  cwd: string | null;
  gitBranch: string | null;
  startedAt: number;
  endedAt: number;
  /** Spawning session, for subagents. */
  parentId: string | null;
  parentTitle: string | null;
  tags: string[];
  /** Automatic tags not also set manually. */
  autoTags: AutoTag[];
}

export interface ResultHit {
  seq: number;
  ts: number;
  kind: string;
  score: number;
  snippet: string;
  /** UTF-16 ranges into `snippet`. */
  highlights: [number, number][];
  toolName: string | null;
  isError: boolean;
}

export interface ResultGroup {
  session: SessionInfo;
  /** At most `perGroup` event hits, in index order. */
  hits: ResultHit[];
  /** Further event hits in this session beyond `hits`. */
  more: number;
  /** The session itself matched (title, directory or branch). */
  sessionHit: { snippet: string; highlights: [number, number][] } | null;
}

export interface SearchResult {
  groups: ResultGroup[];
  totalHits: number;
  /** The index returned `limit` hits; there may be more. */
  limited: boolean;
  tookMs: number;
  sort: Sort;
}

export interface SearchOptions {
  /** Default order when the query has no `sort:` operator. */
  sort?: Sort;
  limit?: number;
  perGroup?: number;
  now?: number;
}

/** Escape `%`, `_` and `\` for LIKE ... ESCAPE '\'. */
const likeAny = (value: string) => `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Session ids matching the session-level facets (project, model, branch, tags,
 * in:). Values of one facet OR together; different facets AND.
 */
export function resolveSessions(db: Db, p: ParsedQuery): string[] {
  const clauses: string[] = [];
  const params: string[] = [];
  const anyOf = (column: string, values: string[]) => {
    if (!values.length) return;
    clauses.push(`(${values.map(() => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    params.push(...values.map(likeAny));
  };
  anyOf("s.cwd", p.projects);
  anyOf("s.models", p.models);
  anyOf("s.git_branch", p.branches);
  if (p.tags.length) {
    clauses.push(
      `s.id IN (SELECT session_id FROM user.tags WHERE lower(tag) IN (SELECT value FROM json_each(?))
         UNION SELECT session_id FROM auto_tags WHERE tag IN (SELECT value FROM json_each(?)))`,
    );
    params.push(JSON.stringify(p.tags), JSON.stringify(p.tags));
  }
  if (p.sessionIds.length) {
    clauses.push(`(${p.sessionIds.map(() => "s.id = ? OR s.native_id LIKE ? ESCAPE '\\'").join(" OR ")})`);
    for (const id of p.sessionIds) params.push(id, `${id.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  const sql = `SELECT s.id FROM sessions s${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}`;
  return (db.prepare(sql).all(...params) as { id: string }[]).map((r) => r.id);
}

interface SessionRow {
  id: string;
  nativeId: string;
  title: string | null;
  source: string;
  cwd: string | null;
  gitBranch: string | null;
  startedAt: number;
  endedAt: number;
  parentId: string | null;
  parentTitle: string | null;
}

/** Session info with manual and automatic tags for the given ids, keyed by id. */
export function sessionInfo(db: Db, ids: string[]): Map<string, SessionInfo> {
  const out = new Map<string, SessionInfo>();
  if (!ids.length) return out;
  const json = JSON.stringify(ids);
  const rows = db
    .prepare(
      `SELECT s.id, s.native_id AS nativeId, s.title, s.source, s.cwd, s.git_branch AS gitBranch,
              s.started_at AS startedAt, s.ended_at AS endedAt, s.parent_id AS parentId, p.title AS parentTitle
       FROM sessions s LEFT JOIN sessions p ON p.id = s.parent_id
       WHERE s.id IN (SELECT value FROM json_each(?))`,
    )
    .all(json) as unknown as SessionRow[];
  for (const r of rows) out.set(r.id, { ...r, sourceLabel: sourceLabel(r.source), tags: [], autoTags: [] });
  const tags = db
    .prepare("SELECT session_id AS id, tag FROM user.tags WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY tag")
    .all(json) as { id: string; tag: string }[];
  for (const t of tags) out.get(t.id)?.tags.push(t.tag);
  const auto = db
    .prepare("SELECT session_id AS id, tag, reason FROM auto_tags WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY tag")
    .all(json) as { id: string; tag: string; reason: string }[];
  for (const { id, tag, reason } of auto) {
    const s = out.get(id);
    if (s && !s.tags.includes(tag)) s.autoTags.push({ tag, reason });
  }
  return out;
}

export function search(db: Db, index: SearchIndex, query: string, opts: SearchOptions = {}): SearchResult {
  const started = performance.now();
  const p = parseQuery(query, { now: opts.now });
  const sort = p.sort ?? opts.sort ?? "relevance";
  const limit = opts.limit ?? 400;
  const perGroup = opts.perGroup ?? 5;
  const done = (groups: ResultGroup[], totalHits: number, limited: boolean): SearchResult => ({
    groups,
    totalHits,
    limited,
    tookMs: Math.round((performance.now() - started) * 10) / 10,
    sort,
  });
  if (isEmptyQuery(p)) return done([], 0, false);

  let sessionIds: string[] | undefined;
  if (hasSessionFacets(p)) {
    sessionIds = resolveSessions(db, p);
    if (!sessionIds.length) return done([], 0, false);
  }

  const req: SearchRequest = {
    must: p.must,
    mustNot: p.mustNot,
    // Without text there is nothing for a session-level (title) document to match: list events only.
    kinds: p.kinds.length ? p.kinds : p.must.length ? undefined : [...EVENT_KINDS],
    sources: p.sources.length ? p.sources : undefined,
    tools: p.tools.length ? p.tools : undefined,
    sessionIds,
    from: p.from,
    to: p.to,
    sort,
    limit,
  };
  const hits = index.search(req);

  // Group by session in first-appearance order, so the index's order carries through.
  // Scoped by `in:` or matching a single session, every hit is listed: that is what "more in this session" asks for.
  const scoped = p.sessionIds.length > 0 || new Set(hits.map((h) => h.sessionId)).size === 1;
  const cap = scoped ? Infinity : perGroup;
  const bySession = new Map<string, { hits: typeof hits; more: number; sessionHit: ResultGroup["sessionHit"] }>();
  for (const h of hits) {
    let g = bySession.get(h.sessionId);
    if (!g) {
      g = { hits: [], more: 0, sessionHit: null };
      bySession.set(h.sessionId, g);
    }
    if (h.seq < 0) g.sessionHit ??= { snippet: h.snippet, highlights: h.highlights };
    else if (g.hits.length < cap) g.hits.push(h);
    else g.more++;
  }

  const sessions = sessionInfo(db, [...bySession.keys()]);
  const shown = [...bySession.entries()].flatMap(([id, g]) => g.hits.map((h) => [id, h.seq] as const));
  const events = new Map<string, { toolName: string | null; isError: number }>();
  if (shown.length) {
    const rows = db
      .prepare(
        `SELECT e.session_id AS id, e.seq, e.tool_name AS toolName, e.is_error AS isError
         FROM json_each(?) j JOIN events e ON e.session_id = j.value ->> 0 AND e.seq = j.value ->> 1`,
      )
      .all(JSON.stringify(shown)) as { id: string; seq: number; toolName: string | null; isError: number }[];
    for (const r of rows) events.set(`${r.id}\n${r.seq}`, r);
  }

  const groups: ResultGroup[] = [];
  for (const [id, g] of bySession) {
    const session = sessions.get(id);
    // The index can briefly lag a sync that removed a session; drop what SQLite no longer has.
    if (!session) continue;
    groups.push({
      session,
      more: g.more,
      sessionHit: g.sessionHit,
      hits: g.hits.map((h) => {
        const e = events.get(`${id}\n${h.seq}`);
        return {
          seq: h.seq,
          ts: h.ts,
          kind: h.kind,
          score: h.score,
          snippet: h.snippet,
          highlights: h.highlights,
          toolName: e?.toolName ?? null,
          isError: Boolean(e?.isError),
        };
      }),
    });
  }
  return done(groups, hits.length, hits.length >= limit);
}

export interface ContextEvent {
  seq: number;
  ts: number;
  kind: string;
  /** Clipped to ~1500 characters; around the first query term for the hit itself. */
  text: string;
  clipped: boolean;
  toolName: string | null;
  /** One-line preview of a tool call's arguments. */
  toolInput: string | null;
  isError: boolean;
}

export interface SearchContext {
  session: SessionInfo;
  /** The hit's seq (-1: a session-level match, context is the session's start). */
  seq: number;
  events: ContextEvent[];
}

const CLIP = 1500;

/** Up to `max` characters of `text`, windowed around the first occurrence of any term when that lies beyond the cut. */
function clip(text: string, terms: string[], max = CLIP): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = at > max - 200 ? Math.min(at - 200, text.length - max) : 0;
  return { text: `${start > 0 ? "…" : ""}${text.slice(start, start + max)}…`, clipped: true };
}

/** One-line preview of a tool call's JSON arguments. */
function inputPreview(input: string | null): string | null {
  if (!input) return null;
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === "object") {
      const values = Object.values(parsed as Record<string, unknown>).filter((v) => typeof v === "string" || typeof v === "number");
      return values.join(" · ").replace(/\s+/g, " ").slice(0, 240);
    }
  } catch {
    // Not JSON.
  }
  return input.replace(/\s+/g, " ").slice(0, 240);
}

interface EventRow {
  seq: number;
  ts: number;
  kind: string;
  text: string | null;
  toolName: string | null;
  toolInput: string | null;
  isError: number;
}

/**
 * The `n` events before and after `seq` in a session, for the palette's
 * preview. `terms` steer where a long hit text is clipped.
 */
export function context(db: Db, sessionId: string, seq: number, n = 4, terms: string[] = []): SearchContext | null {
  const session = sessionInfo(db, [sessionId]).get(sessionId);
  if (!session) return null;
  const cols = "seq, ts, kind, text, tool_name AS toolName, tool_input AS toolInput, is_error AS isError";
  const before = db
    .prepare(`SELECT ${cols} FROM events WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`)
    .all(sessionId, seq, n) as unknown as EventRow[];
  const after = db
    .prepare(`SELECT ${cols} FROM events WHERE session_id = ? AND seq >= ? ORDER BY seq LIMIT ?`)
    .all(sessionId, seq, n + 1) as unknown as EventRow[];
  const events = [...before.reverse(), ...after].map((e) => {
    const { text, clipped } = clip(e.text ?? "", e.seq === seq ? terms : []);
    return {
      seq: e.seq,
      ts: e.ts,
      kind: e.kind,
      text,
      clipped,
      toolName: e.toolName,
      toolInput: e.kind === "tool_call" ? inputPreview(e.toolInput) : null,
      isError: Boolean(e.isError),
    };
  });
  return { session, seq, events };
}

export interface Facets {
  sources: { id: string; label: string; sessions: number }[];
  tools: { name: string; count: number }[];
  tags: { name: string; count: number }[];
  /** Working directories, most recently active first. */
  projects: { cwd: string; count: number }[];
  models: { name: string; count: number }[];
  branches: { name: string; count: number }[];
}

/** Known values for the palette's operator autocomplete. */
export function facets(db: Db): Facets {
  const all = <T>(sql: string) => db.prepare(sql).all() as unknown as T[];
  return {
    sources: all<{ id: string; sessions: number }>(
      "SELECT source AS id, COUNT(*) AS sessions FROM sessions GROUP BY source ORDER BY sessions DESC",
    ).map((s) => ({ ...s, label: sourceLabel(s.id) })),
    // `tool:` matches case-insensitively, so Bash and bash are one value.
    tools: all(
      `SELECT MIN(tool_name) AS name, COUNT(*) AS count FROM events
       WHERE kind = 'tool_call' AND tool_name IS NOT NULL GROUP BY lower(tool_name) ORDER BY count DESC LIMIT 60`,
    ),
    tags: all(
      `SELECT tag AS name, COUNT(DISTINCT session_id) AS count FROM (SELECT tag, session_id FROM user.tags UNION ALL SELECT tag, session_id FROM auto_tags)
       GROUP BY tag ORDER BY count DESC, tag`,
    ),
    projects: all(
      `SELECT cwd, COUNT(*) AS count FROM sessions WHERE cwd IS NOT NULL AND cwd != ''
       GROUP BY cwd ORDER BY MAX(ended_at) DESC LIMIT 60`,
    ),
    models: all(
      `SELECT j.value AS name, COUNT(*) AS count FROM sessions s, json_each(s.models) j
       GROUP BY j.value ORDER BY count DESC LIMIT 40`,
    ),
    branches: all(
      `SELECT git_branch AS name, COUNT(*) AS count FROM sessions WHERE git_branch IS NOT NULL AND git_branch != ''
       GROUP BY git_branch ORDER BY MAX(ended_at) DESC LIMIT 40`,
    ),
  };
}
