import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { adapters as defaultAdapters } from "../adapters";
import type { Adapter, Env } from "../core/adapter";
import { deriveAutoTags } from "../core/autotags";
import { type CostSource, costOf, loadPrices, type ModelPrice } from "../core/pricing";
import type { AgentEvent, ParsedSession, TokenUsage, UsageRecord } from "../core/types";
import type { IndexDoc, SearchIndex } from "../search/native";
import { bumpGeneration, type Db, defaultArchiveDir, generation, transaction } from "../store/db";
import { type ArchiveState, listArchive, readArchive, writeArchive } from "./archive";

/** Per-event text limits keep the database small; the full transcript stays in the log and its archived copy. */
const MAX_TEXT = 20_000;
const MAX_TOOL_TEXT = 6_000;

/** Documents per index commit when rebuilding the search index from the database. */
const REBUILD_BATCH = 5_000;

/** files.error prefix for a log that was stored but whose archive copy failed: only the copy is retried. */
const ARCHIVE_ERROR = "archive: ";
/** A pending archive copy is retried at most this often, since each retry re-reads the whole log. */
const ARCHIVE_RETRY_MS = 60_000;
/** files.error prefix for an archived-only log whose .gz could not be read: skipped until the .gz changes. */
const ARCHIVE_READ_ERROR = "unreadable archive copy: ";

/** Databases whose archive this process has listed already; later syncs only list it when asked to (see SyncOptions.archive). */
const archiveListed = new WeakMap<Db, true>();
/**
 * Databases whose committed writes may be missing from the search index because recording a new generation failed
 * (the database became unavailable mid-sync): the next sync that reaches the index rebuilds it.
 */
const indexBehind = new WeakSet<Db>();

export interface SyncOptions {
  env?: Env;
  adapters?: Adapter[];
  prices?: Record<string, ModelPrice>;
  /** Re-parse every file, live or archived, even if unchanged (e.g. after editing pricing.json). */
  full?: boolean;
  /** Raw-log archive directory; defaults to defaultArchiveDir(env). */
  archiveDir?: string;
  /** Search index to keep in step with the database. */
  index?: SearchIndex;
  /**
   * List the archive for logs the tools deleted. Defaults to the first sync of a database in this process, `full`
   * syncs and syncs that start with no known files (a fresh or rebuilt database); in between, its copies are known.
   */
  archive?: boolean;
}

export interface SyncResult {
  scanned: number;
  parsed: number;
  /** Sessions written (new, appended to or replaced). */
  sessions: number;
  /**
   * Every session this sync wrote, replaced or deleted (also those whose usage totals lost a request copy), with its
   * directory after the write, or the one it had when it was deleted; each (id, cwd) pair once. A session whose
   * directory changed is listed with its old directory too, and a subagent that was deleted or moved to another
   * parent lists its old parent (with that parent's directory), whose page showed it.
   */
  changed: { id: string; cwd: string | null }[];
  errors: { path: string; error: string }[];
  /** Database generation after this sync. */
  generation: number;
  /** Set when the search index could not be updated; it is rebuilt on a later sync. */
  indexError?: string;
  durationMs: number;
}

/** Environment variable overriding an adapter's roots, e.g. AGENT_MONITOR_CLAUDE_CODE_DIRS. */
export const rootsEnvVar = (adapterId: string): string => `AGENT_MONITOR_${adapterId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_DIRS`;

/** Roots for an adapter: its `rootsEnvVar` (path-delimiter separated) overrides the adapter's defaults. */
export function rootsFor(adapter: Adapter, env: Env): string[] {
  const override = env[rootsEnvVar(adapter.id)];
  return override ? override.split(path.delimiter).filter(Boolean) : adapter.roots(env);
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // Tool not installed or root not created yet.
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

const clip = (text: string | undefined, max: number): string | null => {
  if (text === undefined) return null;
  return text.length > max ? `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]` : text;
};

/**
 * Lines of a tool input that name the files it touches (see `fileOps` in src/core/activity.ts): apply_patch
 * headers, and omp edit's `[path#TAG]` headers with their REM / MV ops. Clipping keeps them past the cut.
 */
const FILE_LINE = /^(?:\*\*\* (?:Begin Patch|End Patch|(?:Add|Update|Delete) File: |Move to: )|\[[^\n]+#[0-9A-Fa-f]{4}\][ \t\r]*$|REM[ \t\r]*$|MV )[^\n]*/gm;

/** A string too long to store whole, with the offsets of its FILE_LINE lines. */
interface LongText {
  text: string;
  lines: { at: number; line: string }[];
}

const longText = (text: string): LongText => ({ text, lines: [...text.matchAll(FILE_LINE)].map((m) => ({ at: m.index, line: m[0] })) });

/**
 * The first `keep` characters of a long text, then the FILE_LINE lines after them (at most `max` characters of
 * them) and the usual truncation marker. A cut through such a line moves to its start, so no half path survives.
 */
function shorten(long: LongText, keep: number, max: number): string {
  const { text, lines } = long;
  const split = lines.find((l) => l.at < keep && keep < l.at + l.line.length);
  const cut = split ? split.at : keep;
  const kept: string[] = [];
  let budget = max;
  for (const l of lines) {
    if (l.at < cut || l.line.length + 1 > budget) continue;
    kept.push(l.line);
    budget -= l.line.length + 1;
  }
  const tail = kept.join("\n");
  return `${text.slice(0, cut)}\n${tail ? `${tail}\n` : ""}… [truncated ${text.length - cut - tail.length} chars]`;
}

/** Strings this short are never shortened inside JSON tool input: paths, commands, ids. */
const MIN_KEEP = 200;

/** The rendering for the largest `keep` in [lo, hi] that fits in `max` characters (for `lo` if none does); length grows with `keep`. */
function fit(render: (keep: number) => string, lo: number, hi: number, max: number): string {
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (render(mid).length <= max) lo = mid;
    else hi = mid - 1;
  }
  return render(lo);
}

/**
 * Tool input clipped to about `max` characters. JSON input (the usual case) stays valid JSON with every key: each
 * string value longer than a common threshold is shortened to it, keeping the lines that name files, and the
 * threshold is the largest that fits. Other input, or JSON that cannot be shrunk that way, is clipped as text.
 */
export function clipToolInput(input: string | undefined, max: number): string | null {
  if (input === undefined) return null;
  if (input.length <= max) return input;
  const asText = () => {
    const long = longText(input);
    return fit((keep) => shorten(long, keep, max), 0, max, max);
  };
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return asText();
  }
  const longs = new Map<string, LongText>();
  let longest = 0;
  const collect = (v: unknown): void => {
    if (typeof v === "string") {
      if (v.length > MIN_KEEP && !longs.has(v)) longs.set(v, longText(v));
      longest = Math.max(longest, v.length);
    } else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  };
  collect(value);
  const render = (keep: number): string => {
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return v.length > keep && longs.has(v) ? shorten(longs.get(v)!, keep, max) : v;
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    return JSON.stringify(walk(value));
  };
  const out = fit(render, MIN_KEEP, longest, max);
  // Many keys or numbers rather than a few long strings: bound the size, at the cost of valid JSON.
  return out.length <= 2 * max ? out : asText();
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A log's text. One too big for a JavaScript string (~512 MiB) fails like an unparseable log: skipped until it changes. */
function decode(raw: Buffer): string {
  try {
    return raw.toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_STRING_TOO_LONG") throw error;
    throw new Error(`log too large to parse (${Math.round(raw.length / 2 ** 20)} MiB)`);
  }
}

const sessionCostSource = (sources: CostSource[]): string => {
  if (sources.length === 0) return "none";
  const set = new Set(sources);
  if (set.has("unpriced")) return set.size === 1 ? "unpriced" : "partial";
  if (set.size === 1) return sources[0];
  return "mixed";
};

interface UsageLine extends TokenUsage {
  model: string;
  usd: number | null;
  source: CostSource;
}

/** A session's usage totals; models are ordered heaviest (most output) first. */
function summarizeUsage(rows: UsageLine[]) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const outputByModel = new Map<string, number>();
  let cost: number | null = null;
  for (const r of rows) {
    if (r.usd !== null) cost = (cost ?? 0) + r.usd;
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += r[key];
    outputByModel.set(r.model, (outputByModel.get(r.model) ?? 0) + r.output + 1);
  }
  const models = [...outputByModel.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  return { totals, cost, costSource: sessionCostSource(rows.map((r) => r.source)), models };
}

/** Recompute a session's stored usage totals from its usage rows. */
function recomputeUsage(db: Db, id: string): void {
  const rows = db
    .prepare(
      `SELECT model, input, output, cache_read AS cacheRead, cache_write AS cacheWrite, reasoning, cost_usd AS usd, cost_source AS source
       FROM usage WHERE session_id = ?`,
    )
    .all(id) as unknown as UsageLine[];
  const { totals, cost, costSource, models } = summarizeUsage(rows);
  db.prepare(
    `UPDATE sessions SET models = ?, requests = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
       cache_write_tokens = ?, reasoning_tokens = ?, cost_usd = ?, cost_source = ?
     WHERE id = ?`,
  ).run(JSON.stringify(models), rows.length, totals.input, totals.output, totals.cacheRead, totals.cacheWrite, totals.reasoning, cost, costSource, id);
}

type Rank = [ts: number, startedAt: number, sessionId: string];
const ranksBefore = (a: Rank, b: Rank): boolean => (a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2]);

/**
 * Forks and resumes copy earlier requests into a new log file, so one request id
 * can turn up in several sessions. It is counted once, in the session that made
 * it: earliest request, then earliest session start, then lowest id. Returns the
 * records this session keeps; copies it outranks are removed from the other
 * sessions (`losers`), whose totals are recomputed. Sessions stored from the
 * same file are about to be replaced and do not compete.
 */
function keepOwnRequests(db: Db, filePath: string, id: string, s: ParsedSession): { kept: UsageRecord[]; losers: string[] } {
  const findCopies = db.prepare(
    `SELECT u.session_id AS sessionId, u.seq, u.ts, s.started_at AS startedAt
     FROM usage u JOIN sessions s ON s.id = u.session_id
     WHERE u.request_id = ? AND u.session_id <> ? AND s.file_path <> ?`,
  );
  const removeCopy = db.prepare("DELETE FROM usage WHERE session_id = ? AND seq = ?");
  const startedAt = Math.round(s.startedAt);
  const losers = new Set<string>();
  const kept = s.usage.filter((record) => {
    if (!record.requestId) return true;
    const copies = findCopies.all(record.requestId, id, filePath) as unknown as { sessionId: string; seq: number; ts: number; startedAt: number }[];
    const mine: Rank = [Math.round(record.ts), startedAt, id];
    if (copies.some((c) => ranksBefore([c.ts, c.startedAt, c.sessionId], mine))) return false;
    for (const c of copies) {
      removeCopy.run(c.sessionId, c.seq);
      losers.add(c.sessionId);
    }
    return true;
  });
  for (const loser of losers) recomputeUsage(db, loser);
  return { kept, losers: [...losers] };
}

/**
 * Chained hash per event: hashes[i] covers events[0..i]. A stored session whose
 * hash equals hashes[storedCount - 1] of a fresh parse only gained events at
 * the end (the common case for a running agent), so only the tail is written.
 */
function chainHashes(events: AgentEvent[]): string[] {
  const hashes: string[] = [];
  let previous = "";
  for (const e of events) {
    previous = createHash("sha1")
      .update(previous)
      .update(JSON.stringify([e.ts, e.kind, e.text, e.toolName, e.toolCallId, e.toolInput, e.isError, e.model]))
      .digest("hex");
    hashes.push(previous);
  }
  return hashes;
}

/** What one file write changed, for the search index. */
export interface SessionChange {
  /** Sessions whose index documents must be dropped first. */
  deleteSessions: string[];
  add: IndexDoc[];
  /** Sessions written, deleted or whose usage totals changed, with their directory (as deleted, for those). */
  touched: { id: string; cwd: string | null }[];
}

const eventDoc = (sessionId: string, source: string, seq: number, e: { ts: number; kind: string; text: string | null; toolName: string | null; toolInput: string | null }): IndexDoc => ({
  sessionId,
  seq,
  ts: e.ts,
  kind: e.kind,
  source,
  tool: e.toolName ?? undefined,
  text: (e.kind === "tool_call" ? e.toolInput : e.text) ?? "",
});

/** One document per session holding its title, directory, branch and id, so sessions are findable by name. */
const sessionDoc = (sessionId: string, s: { source: string; startedAt: number; title: string | null; cwd: string | null; gitBranch: string | null; nativeId: string }): IndexDoc => ({
  sessionId,
  seq: -1,
  ts: s.startedAt,
  kind: "session",
  source: s.source,
  text: [s.title, s.cwd, s.gitBranch, s.nativeId].filter(Boolean).join("\n"),
});

interface StoredSession {
  id: string;
  event_count: number;
  events_hash: string;
  title: string | null;
  cwd: string | null;
  git_branch: string | null;
  parent_id: string | null;
}

const STORED_COLUMNS = "id, event_count, events_hash, title, cwd, git_branch, parent_id";

/** Whether `parentId`, or a session above it (at most 64 levels up, as stored), is `id`. */
function onParentChain(db: Db, parentId: string, id: string): boolean {
  const hit = db
    .prepare(
      `WITH RECURSIVE up(id, depth) AS (
         SELECT ?, 0
         UNION ALL SELECT s.parent_id, up.depth + 1 FROM sessions s JOIN up ON s.id = up.id
         WHERE up.depth < 64 AND up.id <> ? AND s.parent_id IS NOT NULL)
       SELECT 1 FROM up WHERE id = ? LIMIT 1`,
    )
    .get(parentId, id, id);
  return hit !== undefined;
}

/**
 * Pages a write or delete of `old` (a row as stored before it) may have left stale besides the session's own: its old
 * directory when it moved or went away, and its old parent's page (whose tree held it) when it was re-parented or
 * deleted. The server looks ancestors up after the write, so it only finds the new ones itself.
 */
function staleOf(db: Db, old: StoredSession, now: { cwd: string | null; parentId: string | null } | null): { id: string; cwd: string | null }[] {
  const out: { id: string; cwd: string | null }[] = [];
  if (!now || now.cwd !== old.cwd) out.push({ id: old.id, cwd: old.cwd });
  if (old.parent_id !== null && (!now || now.parentId !== old.parent_id)) {
    const parent = db.prepare("SELECT cwd FROM sessions WHERE id = ?").get(old.parent_id) as { cwd: string | null } | undefined;
    if (parent) out.push({ id: old.parent_id, cwd: parent.cwd });
  }
  return out;
}

/** Store one log file's fresh parse: append new events when only the tail changed, otherwise replace the session. */
export function writeSession(db: Db, filePath: string, s: ParsedSession | null, prices: Record<string, ModelPrice>): SessionChange {
  const stored = db.prepare(`SELECT ${STORED_COLUMNS} FROM sessions WHERE file_path = ?`).all(filePath) as unknown as StoredSession[];
  if (!s) {
    const stale = stored.flatMap((r) => staleOf(db, r, null));
    db.prepare("DELETE FROM sessions WHERE file_path = ?").run(filePath);
    return { deleteSessions: stored.map((r) => r.id), add: [], touched: stale };
  }
  const id = `${s.source}:${s.nativeId}`;
  // The same session as another file stored it (a tool rewrote or moved its log): replaced below.
  const elsewhere = stored.some((r) => r.id === id)
    ? undefined
    : (db.prepare(`SELECT ${STORED_COLUMNS} FROM sessions WHERE id = ?`).get(id) as unknown as StoredSession | undefined);
  let parentId = s.parentNativeId ? `${s.source}:${s.parentNativeId}` : null;
  // A malformed log can name a descendant (or the session itself) as parent: a -> b -> a. A cycle has no top-level
  // session, so the list queries (which start at the roots) would never show its members. Break it here: the session
  // written last whose parent chain leads back to it becomes a root. Its stored parent is re-checked on every write.
  if (parentId !== null && onParentChain(db, parentId, id)) parentId = null;

  const { kept, losers } = keepOwnRequests(db, filePath, id, s);
  const cwdOf = db.prepare("SELECT cwd FROM sessions WHERE id = ?");
  const touched = losers.map((loser) => ({ id: loser, cwd: (cwdOf.get(loser) as { cwd: string | null } | undefined)?.cwd ?? null }));
  const usageRows = kept.map((record) => ({ record, c: costOf(record, prices) }));
  const { totals, cost, costSource, models } = summarizeUsage(usageRows.map(({ record, c }) => ({ ...record.usage, model: record.model, usd: c.usd, source: c.source })));
  const count = (pred: (e: AgentEvent) => boolean) => s.events.filter(pred).length;
  const hashes = chainHashes(s.events);

  const previous = stored.length === 1 && stored[0].id === id ? stored[0] : undefined;
  const appendFrom =
    previous && previous.event_count <= s.events.length && (previous.event_count === 0 || hashes[previous.event_count - 1] === previous.events_hash)
      ? previous.event_count
      : null;
  if (appendFrom === null) {
    // Also drop a same-id session another file stored (a tool rewrote or moved its log).
    db.prepare("DELETE FROM sessions WHERE file_path = ? OR id = ?").run(filePath, id);
  } else {
    db.prepare("DELETE FROM usage WHERE session_id = ?").run(id);
  }

  const row = {
    title: s.title ?? null,
    cwd: s.cwd ?? null,
    gitBranch: s.gitBranch ?? null,
  };
  db.prepare(
    `INSERT INTO sessions (id, source, native_id, parent_id, dispatch_seq, file_path, title, cwd, git_branch, agent_version, models,
       started_at, ended_at, event_count, user_messages, tool_calls, tool_errors, errors, requests,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, cost_source, events_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       source = excluded.source, native_id = excluded.native_id, parent_id = excluded.parent_id, dispatch_seq = excluded.dispatch_seq,
       file_path = excluded.file_path,
       title = excluded.title, cwd = excluded.cwd, git_branch = excluded.git_branch, agent_version = excluded.agent_version,
       models = excluded.models, started_at = excluded.started_at, ended_at = excluded.ended_at, event_count = excluded.event_count,
       user_messages = excluded.user_messages, tool_calls = excluded.tool_calls, tool_errors = excluded.tool_errors,
       errors = excluded.errors, requests = excluded.requests, input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens, cache_read_tokens = excluded.cache_read_tokens,
       cache_write_tokens = excluded.cache_write_tokens, reasoning_tokens = excluded.reasoning_tokens,
       cost_usd = excluded.cost_usd, cost_source = excluded.cost_source, events_hash = excluded.events_hash`,
  ).run(
    id,
    s.source,
    s.nativeId,
    parentId,
    s.dispatchIndex ?? null,
    filePath,
    row.title,
    row.cwd,
    row.gitBranch,
    s.agentVersion ?? null,
    JSON.stringify(models),
    Math.round(s.startedAt),
    Math.round(Math.max(s.endedAt, s.startedAt)),
    s.events.length,
    count((e) => e.kind === "user"),
    count((e) => e.kind === "tool_call"),
    count((e) => e.kind === "tool_result" && e.isError === true),
    count((e) => e.kind === "error"),
    usageRows.length,
    totals.input,
    totals.output,
    totals.cacheRead,
    totals.cacheWrite,
    totals.reasoning,
    cost,
    costSource,
    hashes.at(-1) ?? "",
  );

  const insertEvent = db.prepare(
    `INSERT INTO events (session_id, seq, ts, kind, text, tool_name, tool_call_id, tool_input, is_error, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const docs: IndexDoc[] = [];
  const startedAt = Math.round(s.startedAt);
  // The session document only changes with title/directory/branch; otherwise appended events are enough.
  const metaChanged = !previous || previous.title !== row.title || previous.cwd !== row.cwd || previous.git_branch !== row.gitBranch;
  const reindexFrom = appendFrom === null || metaChanged ? 0 : appendFrom;
  if (reindexFrom === 0) docs.push(sessionDoc(id, { source: s.source, startedAt, nativeId: s.nativeId, ...row }));
  const insertFrom = appendFrom ?? 0;
  // Events neither inserted nor re-indexed are skipped before clipping (which parses and re-renders big tool input).
  for (let seq = Math.min(insertFrom, reindexFrom); seq < s.events.length; seq++) {
    const e = s.events[seq];
    const ts = Math.round(e.ts);
    const text = clip(e.text, e.kind === "tool_result" ? MAX_TOOL_TEXT : MAX_TEXT);
    const toolInput = clipToolInput(e.toolInput, MAX_TOOL_TEXT);
    if (seq >= insertFrom) {
      insertEvent.run(id, seq, ts, e.kind, text, e.toolName ?? null, e.toolCallId ?? null, toolInput, e.isError ? 1 : 0, e.model ?? null);
    }
    if (seq >= reindexFrom) docs.push(eventDoc(id, s.source, seq, { ts, kind: e.kind, text, toolName: e.toolName ?? null, toolInput }));
  }

  const insertUsage = db.prepare(
    `INSERT INTO usage (session_id, seq, ts, model, input, output, cache_read, cache_write, reasoning, cost_usd, cost_source, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  usageRows.forEach(({ record, c }, seq) => {
    const u = record.usage;
    insertUsage.run(id, seq, Math.round(record.ts), record.model, u.input, u.output, u.cacheRead, u.cacheWrite, u.reasoning, c.usd, c.source, record.requestId ?? null);
  });

  // Derived from every event, so recomputed on the append path too.
  db.prepare("DELETE FROM auto_tags WHERE session_id = ?").run(id);
  const insertTag = db.prepare("INSERT INTO auto_tags (session_id, tag, reason) VALUES (?, ?, ?)");
  for (const t of deriveAutoTags({ events: s.events, cwd: s.cwd, gitBranch: s.gitBranch })) insertTag.run(id, t.tag, t.reason);

  const deleteSessions = reindexFrom === 0 ? [...new Set([...stored.map((r) => r.id), id])] : [];
  // Other sessions this file held were dropped above (replace path only; appending means it held just this one).
  // Rows read before the write, so their old directory and parent are still known (the parent's own row is not
  // touched by this write, so looking up its directory now is fine).
  for (const r of elsewhere ? [...stored, elsewhere] : stored) touched.push(...staleOf(db, r, r.id === id ? { cwd: row.cwd, parentId } : null));
  touched.push({ id, cwd: row.cwd });
  return { deleteSessions, add: docs, touched };
}

/** Rebuild the whole search index from the database, committing in batches; the last commit carries `gen`. */
function rebuildIndex(db: Db, index: SearchIndex, gen: number): void {
  const sessions = db
    .prepare("SELECT id, source, native_id AS nativeId, title, cwd, git_branch AS gitBranch, started_at AS startedAt FROM sessions")
    .all() as unknown as { id: string; source: string; nativeId: string; title: string | null; cwd: string | null; gitBranch: string | null; startedAt: number }[];
  const sourceOf = new Map(sessions.map((s) => [s.id, s.source]));
  let batch: IndexDoc[] = sessions.map((s) => sessionDoc(s.id, s));
  let reset = true;
  const flush = (final: boolean) => {
    index.apply({ reset, deleteSessions: [], add: batch, generation: final ? gen : -1 });
    reset = false;
    batch = [];
  };
  const events = db.prepare("SELECT session_id AS sessionId, seq, ts, kind, text, tool_name AS toolName, tool_input AS toolInput FROM events");
  for (const e of events.iterate() as Iterable<{ sessionId: string; seq: number; ts: number; kind: string; text: string | null; toolName: string | null; toolInput: string | null }>) {
    batch.push(eventDoc(e.sessionId, sourceOf.get(e.sessionId) ?? "", e.seq, e));
    if (batch.length >= REBUILD_BATCH) flush(false);
  }
  flush(true);
}

interface FileRow {
  path: string;
  size: number;
  mtime_ms: number;
  synced_at: number;
  error: string | null;
  archived_size: number | null;
  archived_hash: string | null;
  archived_gz_size: number | null;
}

const FILE_COLUMNS = "path, size, mtime_ms, synced_at, error, archived_size, archived_hash, archived_gz_size";

/** What the file's archive copy held after our last write to it, if known. */
const archivedOf = (row: FileRow | undefined): ArchiveState | null =>
  row && row.archived_size !== null && row.archived_hash !== null && row.archived_gz_size !== null
    ? { size: row.archived_size, hash: row.archived_hash, gzSize: row.archived_gz_size }
    : null;

/** The log a session was stored from, and how much of the session it held. */
interface StoredCopy {
  path: string;
  events: number;
  endedAt: number;
}

/**
 * Of two archived-only logs of one session, whether the stored one stays over the one just read: more events
 * first, then the later end, then the path that sorts first. Either read order ends with the same copy.
 */
const keepsArchivedCopy = (stored: StoredCopy, candidate: StoredCopy): boolean =>
  stored.events !== candidate.events
    ? stored.events > candidate.events
    : stored.endedAt !== candidate.endedAt
      ? stored.endedAt > candidate.endedAt
      : stored.path < candidate.path;

/** Scan every adapter's roots (and the archive when it can hold something new), (re)ingest new or changed logs, and bring the search index along. */
export async function syncAll(db: Db, options: SyncOptions = {}): Promise<SyncResult> {
  const started = Date.now();
  const env = options.env ?? process.env;
  const prices = options.prices ?? loadPrices(env);
  const archiveDir = options.archiveDir ?? defaultArchiveDir(env);
  const adapters = options.adapters ?? defaultAdapters;
  const result: SyncResult = { scanned: 0, parsed: 0, sessions: 0, changed: [], errors: [], generation: 0, durationMs: 0 };
  const known = new Map((db.prepare(`SELECT ${FILE_COLUMNS} FROM files`).all() as unknown as FileRow[]).map((r) => [r.path, r]));
  const listArchived = options.archive ?? (options.full === true || known.size === 0 || !archiveListed.has(db));
  const seen = new Set<string>();
  /** Logs found in the adapters' roots during this sync, as opposed to copies read back from the archive. */
  const live = new Set<string>();
  const changes: SessionChange[] = [];
  const upsertFile = db.prepare(
    `INSERT INTO files (path, adapter, size, mtime_ms, synced_at, missing, error, archived_size, archived_hash, archived_gz_size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET adapter = excluded.adapter, size = excluded.size, mtime_ms = excluded.mtime_ms,
       synced_at = excluded.synced_at, missing = excluded.missing, error = excluded.error, archived_size = excluded.archived_size,
       archived_hash = excluded.archived_hash, archived_gz_size = excluded.archived_gz_size`,
  );
  const writeFile = (adapterId: string, filePath: string, size: number, mtimeMs: number, missing: boolean, error: string | null, archived: ArchiveState | null) =>
    upsertFile.run(filePath, adapterId, size, mtimeMs, Date.now(), missing ? 1 : 0, error, archived?.size ?? null, archived?.hash ?? null, archived?.gzSize ?? null);
  const sessionFile = db.prepare("SELECT file_path AS path, event_count AS events, ended_at AS endedAt FROM sessions WHERE id = ?");

  /** Report a failed file and remember it: its real size skips it until it changes, size -1 retries it next sync. */
  const recordFailure = (adapterId: string, filePath: string, size: number, mtimeMs: number, missing: boolean, message: string, archived: ArchiveState | null) => {
    result.errors.push({ path: filePath, error: message });
    try {
      writeFile(adapterId, filePath, size, mtimeMs, missing, message, archived);
    } catch {
      // The database is still unavailable; the file is unknown to it and gets picked up next time anyway.
    }
  };

  /**
   * Parse and store one log. `archiveError` stays on the file's row when the log itself was stored; `archived` is
   * what its archive copy holds now (null: unknown, so the next copy is a rewrite). Returns false when storing it
   * failed transiently (it is retried next sync), true otherwise.
   */
  const ingest = (
    adapter: Adapter,
    filePath: string,
    raw: Buffer,
    stat: { size: number; mtimeMs: number },
    missing: boolean,
    archiveError: string | null,
    archived: ArchiveState | null,
  ): boolean => {
    let parsed = false;
    try {
      const session = adapter.parse(filePath, decode(raw));
      parsed = true;
      const holder = missing && session ? (sessionFile.get(`${session.source}:${session.nativeId}`) as StoredCopy | undefined) : undefined;
      // A tool that moved its log (Codex: sessions/ to archived_sessions/) left the old path in the archive. After a
      // rebuild or with --full, that stale copy would replace the session the live file holds: the live file wins.
      // Between two archived-only copies the outcome must not depend on read order (see `keepsArchivedCopy`).
      const superseded =
        session !== null &&
        holder !== undefined &&
        holder.path !== filePath &&
        (live.has(holder.path) ||
          keepsArchivedCopy(holder, { path: filePath, events: session.events.length, endedAt: Math.round(Math.max(session.endedAt, session.startedAt)) }));
      const change = transaction(db, () => {
        const c = superseded ? undefined : writeSession(db, filePath, session, prices);
        writeFile(adapter.id, filePath, stat.size, stat.mtimeMs, missing, archiveError, archived);
        return c;
      });
      result.parsed++;
      if (change) {
        changes.push(change);
        if (session) result.sessions++;
      }
      return true;
    } catch (error) {
      // A parse error repeats until the file changes, so remember its size and skip it until then. A failed write
      // (e.g. "database is locked" while another process syncs) is transient: size -1 makes the next sync retry it.
      recordFailure(adapter.id, filePath, parsed ? -1 : stat.size, stat.mtimeMs, missing, errorMessage(error), archived);
      return !parsed;
    }
  };

  /** Copy a log into the archive (appending when only its end is new); `error` is kept on the file's row. */
  const archive = async (adapterId: string, filePath: string, raw: Buffer, previous: FileRow | undefined): Promise<{ error: string | null; archived: ArchiveState | null }> => {
    try {
      return { error: null, archived: await writeArchive(archiveDir, adapterId, filePath, raw, archivedOf(previous)) };
    } catch (error) {
      const message = `${ARCHIVE_ERROR}${errorMessage(error)}`;
      result.errors.push({ path: filePath, error: message });
      return { error: message, archived: null };
    }
  };
  const setArchived = db.prepare("UPDATE files SET error = ?, synced_at = ?, archived_size = ?, archived_hash = ?, archived_gz_size = ? WHERE path = ?");
  // The first failed retry of a pending archive copy ends the retries for this sync: the cause (a full disk, a
  // read-only archive) is usually shared. Its new attempt time lets the next sync try the next pending copy first.
  let retryArchive = true;

  for (const adapter of adapters) {
    for (const root of rootsFor(adapter, env)) {
      for await (const filePath of walk(root)) {
        if (!adapter.match(filePath) || seen.has(filePath)) continue;
        seen.add(filePath);
        live.add(filePath);
        result.scanned++;
        let stat;
        try {
          stat = await fs.stat(filePath);
        } catch {
          continue; // Deleted between readdir and stat.
        }
        const previous = known.get(filePath);
        const unchanged = !options.full && previous !== undefined && previous.size === stat.size && previous.mtime_ms === stat.mtimeMs;
        // Stored and unchanged: nothing to do, unless its archive copy failed; then only the copy is retried.
        const archivePending = retryArchive && previous?.error?.startsWith(ARCHIVE_ERROR) === true && Date.now() - previous.synced_at >= ARCHIVE_RETRY_MS;
        if (unchanged && !archivePending) continue;
        let raw: Buffer;
        try {
          raw = await fs.readFile(filePath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") continue; // Deleted between stat and read.
          // Over 2 GiB stays unreadable until the file changes; anything else (e.g. a lock) is retried next sync.
          recordFailure(adapter.id, filePath, code === "ERR_FS_FILE_TOO_LARGE" ? stat.size : -1, stat.mtimeMs, false, errorMessage(error), archivedOf(previous));
          continue;
        }
        const copy = await archive(adapter.id, filePath, raw, previous);
        if (unchanged) {
          try {
            setArchived.run(copy.error, Date.now(), copy.archived?.size ?? null, copy.archived?.hash ?? null, copy.archived?.gzSize ?? null, filePath);
            retryArchive = copy.error === null;
          } catch (error) {
            // The database is unavailable: the row still says the copy is pending, so it is retried later.
            result.errors.push({ path: filePath, error: errorMessage(error) });
            retryArchive = false;
          }
        } else ingest(adapter, filePath, raw, stat, false, copy.error, copy.archived);
      }
    }
  }

  // Logs the tools have deleted: history is kept. After a rebuild (or with --full) they are re-parsed from the archive.
  // Listing it walks every copy ever made, so only when that can find something new (see SyncOptions.archive).
  const byId = new Map(adapters.map((a) => [a.id, a]));
  /** An archived-only log could not be stored for a passing reason: the next sync lists the archive again. */
  let archivePending = false;
  for await (const entry of listArchived ? listArchive(archiveDir) : []) {
    const adapter = byId.get(entry.adapterId);
    if (!adapter || seen.has(entry.original) || !adapter.match(entry.original)) continue;
    const previous = known.get(entry.original);
    const unreadable = previous?.error?.startsWith(ARCHIVE_READ_ERROR) === true;
    // Size -1: storing it failed transiently (see `recordFailure`), so it is retried like an unreadable copy.
    const failed = previous?.size === -1;
    if (!options.full && previous && !unreadable && !failed) continue; // Already ingested; flagged missing below.
    seen.add(entry.original);
    let gz;
    try {
      gz = await fs.stat(entry.file);
    } catch (error) {
      result.errors.push({ path: entry.file, error: errorMessage(error) });
      archivePending = true;
      continue;
    }
    // A copy that could not be read is only tried again once it changed.
    if (unreadable && previous?.size === gz.size && previous.mtime_ms === gz.mtimeMs) continue;
    let raw: Buffer;
    try {
      raw = await readArchive(entry.file);
    } catch (error) {
      const message = `${ARCHIVE_READ_ERROR}${errorMessage(error)}`;
      result.errors.push({ path: entry.file, error: message });
      try {
        writeFile(adapter.id, entry.original, gz.size, gz.mtimeMs, true, message, null);
      } catch {
        // The database is unavailable; the copy is reported again next time.
      }
      continue;
    }
    if (!ingest(adapter, entry.original, raw, { size: raw.length, mtimeMs: gz.mtimeMs }, true, null, unreadable ? null : archivedOf(previous))) {
      archivePending = true;
    }
  }
  if (listArchived && !archivePending) archiveListed.set(db, true);
  try {
    const markMissing = db.prepare("UPDATE files SET missing = 1 WHERE path = ?");
    for (const filePath of known.keys()) if (!seen.has(filePath)) markMissing.run(filePath);
  } catch (error) {
    // Only the "missing" flags are behind; every sync sets them again.
    result.errors.push({ path: "", error: `could not flag deleted logs: ${errorMessage(error)}` });
  }

  const changed = new Map<string, { id: string; cwd: string | null }>();
  for (const c of changes) for (const t of c.touched) changed.set(JSON.stringify([t.id, t.cwd]), t);
  result.changed = [...changed.values()];

  const indexedBefore = options.index?.generation() ?? null;
  /** Throws on, after marking the index behind when the committed writes got no generation to show for them. */
  const bump = (): number => {
    try {
      return bumpGeneration(db);
    } catch (error) {
      indexBehind.add(db);
      throw error;
    }
  };
  let before: number;
  try {
    before = generation(db);
  } catch (error) {
    if (changes.length) indexBehind.add(db);
    throw error;
  }
  // Without an index (e.g. tests) the bump alone makes the next indexing sync rebuild.
  result.generation = changes.length ? bump() : before;

  if (options.index) {
    try {
      // Incremental only when the index was exactly at our starting point and no other process synced in between.
      if (indexBehind.has(db) || indexedBefore !== before || result.generation > before + 1) {
        rebuildIndex(db, options.index, result.generation);
        indexBehind.delete(db);
      } else if (changes.length) {
        options.index.apply({
          deleteSessions: [...new Set(changes.flatMap((c) => c.deleteSessions))],
          add: changes.flatMap((c) => c.add),
          generation: result.generation,
        });
      }
    } catch (error) {
      // Typically LOCKED: another process is writing the index. Moving the database past any generation that
      // process may commit forces a full rebuild on the next sync instead of silently missing these changes.
      result.indexError = errorMessage(error);
      result.generation = bump();
    }
  }

  result.durationMs = Date.now() - started;
  return result;
}
