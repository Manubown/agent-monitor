import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { adapters as defaultAdapters } from "../adapters";
import type { Adapter, Env } from "../core/adapter";
import { AutoTagScan } from "../core/autotags";
import { type CostSource, costOf, loadPrices, type ModelPrice } from "../core/pricing";
import type { AgentEvent, ParsedSession, UsageRecord } from "../core/types";
import type { IndexDoc, SearchIndex } from "../search/native";
import { bumpGeneration, type Db, defaultArchiveDir, generation, transaction } from "../store/db";
import { type ArchiveState, type ArchiveWrite, appendArchive, listArchive, readArchive, writeArchive } from "./archive";
import { advance, appended, type CarriedRow, feed, logState, type LogState, logStates, remember, resumes, type SessionCarry, type UsageLine } from "./incremental";

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
  /** Logs read from the bytes appended to them alone, carrying on from this process's last sync of them. */
  appended: number;
  /** Bytes of live logs read from disk, so a sync that only reads what was appended is visible as one. */
  bytesRead: number;
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

const sessionCostSource = (sources: CostSource[]): string => {
  if (sources.length === 0) return "none";
  const set = new Set(sources);
  if (set.has("unpriced")) return set.size === 1 ? "unpriced" : "partial";
  if (set.size === 1) return sources[0];
  return "mixed";
};

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
 * same file are about to be replaced and do not compete. An append only passes the records it added: the ones
 * before them were ranked when they were written, and another session's write re-ranks them if it has to.
 */
function keepOwnRequests(db: Db, filePath: string, id: string, records: readonly UsageRecord[], startedAt: number): { kept: UsageRecord[]; losers: string[] } {
  const findCopies = db.prepare(
    `SELECT u.session_id AS sessionId, u.seq, u.ts, s.started_at AS startedAt
     FROM usage u JOIN sessions s ON s.id = u.session_id
     WHERE u.request_id = ? AND u.session_id <> ? AND s.file_path <> ?`,
  );
  const removeCopy = db.prepare("DELETE FROM usage WHERE session_id = ? AND seq = ?");
  const losers = new Set<string>();
  const kept = records.filter((record) => {
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
 * Chained hash per event: the hash over `events[0, to)`, starting from `hash`, which covers `events[0, from)`. A
 * stored session whose hash equals the one over its stored event count only gained events at the end (the common
 * case for a running agent), so only the tail is written, and the next write carries on from the stored hash.
 */
function chainFrom(hash: string, events: readonly AgentEvent[], from: number, to = events.length): string {
  let previous = hash;
  for (let i = from; i < to; i++) {
    const e = events[i];
    previous = createHash("sha1")
      .update(previous)
      .update(JSON.stringify([e.ts, e.kind, e.text, e.toolName, e.toolCallId, e.toolInput, e.isError, e.model]))
      .digest("hex");
  }
  return previous;
}

/** What one file write changed, for the search index. */
export interface SessionChange {
  /** Sessions whose index documents must be dropped first. */
  deleteSessions: string[];
  add: IndexDoc[];
  /** Sessions written, deleted or whose usage totals changed, with their directory (as deleted, for those). */
  touched: { id: string; cwd: string | null }[];
  /** What this write left behind, so the next one only pays for what a growing log appends (null: nothing stored). */
  carry: SessionCarry | null;
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
  user_messages: number;
  tool_calls: number;
  tool_errors: number;
  errors: number;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
  cost_source: string;
  models: string;
}

const STORED_COLUMNS = `id, event_count, events_hash, title, cwd, git_branch, parent_id, user_messages, tool_calls,
  tool_errors, errors, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
  cost_usd, cost_source, models`;

/** Whether the row is still the one a carry's write left: its events were checked, these are its other columns. */
const carriedRow = (row: CarriedRow, stored: StoredSession): boolean =>
  row.userMessages === stored.user_messages &&
  row.toolCalls === stored.tool_calls &&
  row.toolErrors === stored.tool_errors &&
  row.errors === stored.errors &&
  row.requests === stored.requests &&
  row.inputTokens === stored.input_tokens &&
  row.outputTokens === stored.output_tokens &&
  row.cacheReadTokens === stored.cache_read_tokens &&
  row.cacheWriteTokens === stored.cache_write_tokens &&
  row.reasoningTokens === stored.reasoning_tokens &&
  row.costUsd === stored.cost_usd &&
  row.costSource === stored.cost_source &&
  row.models === stored.models;

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

/**
 * The first usage record a write has to store: the ones before it are in the database already, with the sequence
 * numbers `carry` says. Everything is written without a carry, and when another session's write removed rows of
 * this one, which a fresh parse would number differently.
 */
function usageFrom(db: Db, id: string, carry: SessionCarry | null, usage: readonly UsageRecord[]): number {
  if (!carry) return 0;
  // One row per kept record; node:sqlite hands aggregates back untyped.
  const count = db.prepare("SELECT COUNT(*) AS n FROM usage WHERE session_id = ?").get(id) as unknown as { n: number };
  if (count.n !== carry.rows.length) return 0;
  // A record a later line changed (Claude Code's latest message id, a Codex request its token_usage_record
  // replaced) is a new object, so identity finds the first one to write again.
  let i = 0;
  while (i < carry.usage.length && i < usage.length && carry.usage[i] === usage[i]) i++;
  return i;
}

/** Dropped records are ranked again in batches of this many request ids, to stay well inside SQLite's variable limit. */
const RERANK_BATCH = 400;

/**
 * The first record before `from` that this session dropped as a copy another session counts and would keep now: a
 * fork whose own first line moved its start outranks the copies it lost, and a copy whose session is gone is free
 * again. Only writes of this log notice that, exactly as a parse of the whole log did. Returns `from` when every
 * dropped record stays dropped, so the usual append ranks nothing twice.
 */
function reclaimed(db: Db, filePath: string, id: string, startedAt: number, carry: SessionCarry, from: number): number {
  const dropped: { index: number; requestId: string; ts: number }[] = [];
  for (let i = 0; i < from; i++) {
    const record = carry.usage[i];
    if (record.requestId && carry.kept[i] === (i === 0 ? 0 : carry.kept[i - 1])) {
      dropped.push({ index: i, requestId: record.requestId, ts: Math.round(record.ts) });
    }
  }
  if (dropped.length === 0) return from;
  const copies = new Map<string, Rank[]>();
  for (let at = 0; at < dropped.length; at += RERANK_BATCH) {
    const batch = dropped.slice(at, at + RERANK_BATCH);
    const found = db
      .prepare(
        `SELECT u.request_id AS requestId, u.ts AS ts, s.started_at AS startedAt, u.session_id AS sessionId
         FROM usage u JOIN sessions s ON s.id = u.session_id
         WHERE u.session_id <> ? AND s.file_path <> ? AND u.request_id IN (${batch.map(() => "?").join(", ")})`,
      )
      .all(id, filePath, ...batch.map((d) => d.requestId)) as unknown as { requestId: string; ts: number; startedAt: number; sessionId: string }[];
    for (const c of found) {
      const rank: Rank = [c.ts, c.startedAt, c.sessionId];
      const held = copies.get(c.requestId);
      if (held) held.push(rank);
      else copies.set(c.requestId, [rank]);
    }
  }
  for (const d of dropped) {
    if (!(copies.get(d.requestId) ?? []).some((c) => ranksBefore(c, [d.ts, startedAt, id]))) return d.index;
  }
  return from;
}

/**
 * Store one log file's parse: append new events when only the tail changed, otherwise replace the session. With
 * `carry`, what the last write of this file left behind, only the events, usage records and tags the parse added
 * cost anything; it is used only while the stored row is still exactly what that write left. The returned carry
 * describes this write and is only valid once it is committed.
 */
export function writeSession(db: Db, filePath: string, s: ParsedSession | null, prices: Record<string, ModelPrice>, carry: SessionCarry | null = null): SessionChange {
  const stored = db.prepare(`SELECT ${STORED_COLUMNS} FROM sessions WHERE file_path = ?`).all(filePath) as unknown as StoredSession[];
  if (!s) {
    const stale = stored.flatMap((r) => staleOf(db, r, null));
    db.prepare("DELETE FROM sessions WHERE file_path = ?").run(filePath);
    return { deleteSessions: stored.map((r) => r.id), add: [], touched: stale, carry: null };
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

  const previous = stored.length === 1 && stored[0].id === id ? stored[0] : undefined;
  // Only a carry describing exactly the row that is there can be carried on from; anything else is written anew.
  const carried = carry && previous && previous.event_count === carry.events && previous.events_hash === carry.hash && s.events.length >= carry.events && carriedRow(carry.row, previous) ? carry : null;
  let appendFrom: number | null = null;
  let eventsHash: string;
  if (carried) {
    appendFrom = carried.events;
    eventsHash = chainFrom(carried.hash, s.events, appendFrom);
  } else if (previous && previous.event_count <= s.events.length) {
    const prefix = chainFrom("", s.events, 0, previous.event_count);
    if (previous.event_count === 0 || prefix === previous.events_hash) appendFrom = previous.event_count;
    eventsHash = chainFrom(prefix, s.events, previous.event_count);
  } else eventsHash = chainFrom("", s.events, 0);

  const startedAt = Math.round(s.startedAt);
  const changed = usageFrom(db, id, carried, s.usage);
  // A record this session dropped as another's copy can be its own again (a fork's first own line moved its start,
  // or the session that holds the copy went away), and the write of this log is what notices: rank them again.
  const from = carried ? reclaimed(db, filePath, id, startedAt, carried, changed) : changed;
  const seqFrom = carried && from > 0 ? carried.kept[from - 1] : 0;
  const { kept, losers } = keepOwnRequests(db, filePath, id, s.usage.slice(from), startedAt);
  const cwdOf = db.prepare("SELECT cwd FROM sessions WHERE id = ?");
  const touched = losers.map((loser) => ({ id: loser, cwd: (cwdOf.get(loser) as { cwd: string | null } | undefined)?.cwd ?? null }));
  const added: UsageLine[] = kept.map((record) => {
    const c = costOf(record, prices);
    return { ...record.usage, model: record.model, usd: c.usd, source: c.source };
  });
  const rows = carried ? carried.rows : [];
  rows.length = seqFrom;
  for (const line of added) rows.push(line);
  const { totals, cost, costSource, models } = summarizeUsage(rows);
  // How many records up to each one this session keeps, so the next write knows where its rows start.
  const keptCount = carried ? carried.kept : [];
  keptCount.length = from;
  let keeps = seqFrom;
  let k = 0;
  for (let i = from; i < s.usage.length; i++) {
    if (kept[k] === s.usage[i]) {
      k++;
      keeps++;
    }
    keptCount.push(keeps);
  }

  const counts = carried
    ? { userMessages: carried.row.userMessages, toolCalls: carried.row.toolCalls, toolErrors: carried.row.toolErrors, errors: carried.row.errors }
    : { userMessages: 0, toolCalls: 0, toolErrors: 0, errors: 0 };
  for (let i = carried ? carried.events : 0; i < s.events.length; i++) {
    const e = s.events[i];
    if (e.kind === "user") counts.userMessages++;
    else if (e.kind === "tool_call") counts.toolCalls++;
    else if (e.kind === "tool_result") {
      if (e.isError === true) counts.toolErrors++;
    } else if (e.kind === "error") counts.errors++;
  }

  if (appendFrom === null) {
    // Also drop a same-id session another file stored (a tool rewrote or moved its log).
    db.prepare("DELETE FROM sessions WHERE file_path = ? OR id = ?").run(filePath, id);
  } else if (seqFrom === 0) {
    db.prepare("DELETE FROM usage WHERE session_id = ?").run(id);
  } else {
    db.prepare("DELETE FROM usage WHERE session_id = ? AND seq >= ?").run(id, seqFrom);
  }

  const row = {
    title: s.title ?? null,
    cwd: s.cwd ?? null,
    gitBranch: s.gitBranch ?? null,
  };
  // Exactly what this write leaves in the row, so the next one can tell whether anyone else has written it since.
  const written: CarriedRow = {
    ...counts,
    requests: rows.length,
    inputTokens: totals.input,
    outputTokens: totals.output,
    cacheReadTokens: totals.cacheRead,
    cacheWriteTokens: totals.cacheWrite,
    reasoningTokens: totals.reasoning,
    costUsd: cost,
    costSource,
    models: JSON.stringify(models),
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
    written.models,
    startedAt,
    Math.round(Math.max(s.endedAt, s.startedAt)),
    s.events.length,
    written.userMessages,
    written.toolCalls,
    written.toolErrors,
    written.errors,
    written.requests,
    written.inputTokens,
    written.outputTokens,
    written.cacheReadTokens,
    written.cacheWriteTokens,
    written.reasoningTokens,
    written.costUsd,
    written.costSource,
    eventsHash,
  );

  const insertEvent = db.prepare(
    `INSERT INTO events (session_id, seq, ts, kind, text, tool_name, tool_call_id, tool_input, is_error, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const docs: IndexDoc[] = [];
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
  added.forEach((u, i) => {
    const record = kept[i];
    insertUsage.run(id, seqFrom + i, Math.round(record.ts), u.model, u.input, u.output, u.cacheRead, u.cacheWrite, u.reasoning, u.usd, u.source, record.requestId ?? null);
  });

  // Derived from every event, so carried on from the last write while the directory and branch it resolves
  // relative paths with still match; tags that come out the same are left alone.
  const same = carried && carried.cwd === row.cwd && carried.gitBranch === row.gitBranch ? carried : null;
  const scan = same ? same.scan : new AutoTagScan({ cwd: s.cwd, gitBranch: s.gitBranch });
  scan.add(s.events, same ? same.events : 0);
  const tags = scan.tags();
  if (!same || same.tags.length !== tags.length || tags.some((t, i) => t.tag !== same.tags[i].tag || t.reason !== same.tags[i].reason)) {
    db.prepare("DELETE FROM auto_tags WHERE session_id = ?").run(id);
    const insertTag = db.prepare("INSERT INTO auto_tags (session_id, tag, reason) VALUES (?, ?, ?)");
    for (const t of tags) insertTag.run(id, t.tag, t.reason);
  }

  const usage = carried ? carried.usage : [];
  usage.length = from;
  for (let i = from; i < s.usage.length; i++) usage.push(s.usage[i]);

  const deleteSessions = reindexFrom === 0 ? [...new Set([...stored.map((r) => r.id), id])] : [];
  // Other sessions this file held were dropped above (replace path only; appending means it held just this one).
  // Rows read before the write, so their old directory and parent are still known (the parent's own row is not
  // touched by this write, so looking up its directory now is fine).
  for (const r of elsewhere ? [...stored, elsewhere] : stored) touched.push(...staleOf(db, r, r.id === id ? { cwd: row.cwd, parentId } : null));
  touched.push({ id, cwd: row.cwd });
  return {
    deleteSessions,
    add: docs,
    touched,
    carry: { events: s.events.length, hash: eventsHash, row: written, cwd: row.cwd, gitBranch: row.gitBranch, usage, kept: keptCount, rows, tags, scan },
  };
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
  const result: SyncResult = { scanned: 0, parsed: 0, sessions: 0, appended: 0, bytesRead: 0, changed: [], errors: [], generation: 0, durationMs: 0 };
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
  /** Upsert a log's row and return the `synced_at` it got: the next sync resumes only a row still carrying this one. */
  const writeFile = (adapterId: string, filePath: string, size: number, mtimeMs: number, missing: boolean, error: string | null, archived: ArchiveState | null): number => {
    const syncedAt = Date.now();
    upsertFile.run(filePath, adapterId, size, mtimeMs, syncedAt, missing ? 1 : 0, error, archived?.size ?? null, archived?.hash ?? null, archived?.gzSize ?? null);
    return syncedAt;
  };
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

  /** Logs this process can carry on reading where the last sync stopped; dropped as soon as anything is unexpected. */
  const states = logStates(db);

  /**
   * Store one log. `parse` reads it (whole, or only the bytes appended to it) and carries on from `carry`, what the
   * last write of this file left behind. `archiveError` stays on the file's row when the log itself was stored;
   * `archived` is what its archive copy holds now (null: unknown, so the next copy is a rewrite). Returns the state
   * the next write can carry on from with the `synced_at` of its row, and whether storing it failed transiently
   * (it is retried next sync).
   */
  const ingest = (
    adapter: Adapter,
    filePath: string,
    parse: () => ParsedSession | null,
    stat: { size: number; mtimeMs: number },
    missing: boolean,
    archiveError: string | null,
    archived: ArchiveState | null,
    carry: SessionCarry | null = null,
  ): { carry: SessionCarry | null; syncedAt: number; retry: boolean } => {
    let parsed = false;
    try {
      const session = parse();
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
      const stamped = transaction(db, () => {
        const c = superseded ? undefined : writeSession(db, filePath, session, prices, carry);
        return { change: c, syncedAt: writeFile(adapter.id, filePath, stat.size, stat.mtimeMs, missing, archiveError, archived) };
      });
      const change = stamped.change;
      result.parsed++;
      if (change) {
        changes.push(change);
        if (session) result.sessions++;
      }
      return { carry: change?.carry ?? null, syncedAt: stamped.syncedAt, retry: false };
    } catch (error) {
      // A parse error repeats until the file changes, so remember its size and skip it until then. A failed write
      // (e.g. "database is locked" while another process syncs) is transient: size -1 makes the next sync retry it.
      states.delete(filePath);
      recordFailure(adapter.id, filePath, parsed ? -1 : stat.size, stat.mtimeMs, missing, errorMessage(error), archived);
      return { carry: null, syncedAt: 0, retry: parsed };
    }
  };

  /** Copy a log into the archive (appending when only its end is new); `error` is kept on the file's row. */
  const archive = async (adapterId: string, filePath: string, raw: Buffer, previous: FileRow | undefined): Promise<{ error: string | null; archived: ArchiveWrite | null }> => {
    try {
      return { error: null, archived: await writeArchive(archiveDir, adapterId, filePath, raw, archivedOf(previous)) };
    } catch (error) {
      const message = `${ARCHIVE_ERROR}${errorMessage(error)}`;
      result.errors.push({ path: filePath, error: message });
      return { error: message, archived: null };
    }
  };

  /**
   * Read, archive and store only the bytes appended to a log since this process last synced it, carrying on from
   * `state`. Returns false when the log is not the one that state came from after all, or when its copy cannot be
   * appended to: the caller then reads the whole file, which rebuilds both.
   */
  const append = async (adapter: Adapter, filePath: string, state: LogState, stat: { size: number; mtimeMs: number }, archived: ArchiveState): Promise<boolean> => {
    let bytes: Buffer | null;
    try {
      bytes = await appended(state, filePath, stat.size);
    } catch {
      return false; // Unreadable just now; reading it whole reports why.
    }
    if (!bytes) return false;
    const chunk = bytes;
    result.bytesRead += chunk.length + state.headLen + state.tail.length;
    let copy: ArchiveWrite | null = null;
    let archiveError: string | null = null;
    try {
      copy = await appendArchive(archiveDir, adapter.id, filePath, chunk.subarray(state.size - state.offset), archived, state.archive);
      if (!copy) return false; // The copy is not as we left it; it is rewritten from the whole log.
    } catch (error) {
      // The copy failed, the log itself is still stored: the next sync rewrites the copy from the whole file.
      archiveError = `${ARCHIVE_ERROR}${errorMessage(error)}`;
      result.errors.push({ path: filePath, error: archiveError });
    }
    let consumed = 0;
    const parse = () => {
      consumed = feed(state.parser, chunk);
      return state.parser.result();
    };
    const { carry, syncedAt } = ingest(adapter, filePath, parse, stat, false, archiveError, copy, state.carry);
    result.appended++;
    if (carry && copy) {
      advance(state, chunk, consumed, stat.mtimeMs, syncedAt, carry);
      remember(db, filePath, state); // Most recently used, and idle logs make way for it.
    } else states.delete(filePath);
    return true;
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
        // A log that only grew: read, archive and store its new bytes, carrying on from this process's last sync.
        const state = options.full || unchanged ? undefined : states.get(filePath);
        const archived = archivedOf(previous);
        if (state && previous && resumes(state, adapter.id, previous, archived, stat.size) && archived && (await append(adapter, filePath, state, stat, archived))) continue;
        states.delete(filePath);
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
        result.bytesRead += raw.length;
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
        } else {
          const parser = adapter.parser(filePath);
          let consumed = 0;
          const parse = () => {
            consumed = feed(parser, raw);
            return parser.result();
          };
          const { carry, syncedAt } = ingest(adapter, filePath, parse, stat, false, copy.error, copy.archived);
          // Only a log read whole, archived as it is, can be carried on from next time.
          if (carry && copy.archived && raw.length === stat.size) {
            remember(db, filePath, logState(adapter.id, parser, raw, consumed, stat, syncedAt, copy.archived.running, carry));
          }
        }
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
    const parse = () => {
      const parser = adapter.parser(entry.original);
      feed(parser, raw);
      return parser.result();
    };
    if (ingest(adapter, entry.original, parse, { size: raw.length, mtimeMs: gz.mtimeMs }, true, null, unreadable ? null : archivedOf(previous)).retry) {
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
