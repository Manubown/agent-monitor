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
import { listArchive, readArchive, writeArchive } from "./archive";

/** Per-event text limits keep the database small; the full transcript stays in the log and its archived copy. */
const MAX_TEXT = 20_000;
const MAX_TOOL_TEXT = 6_000;

/** Documents per index commit when rebuilding the search index from the database. */
const REBUILD_BATCH = 5_000;

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
}

export interface SyncResult {
  scanned: number;
  parsed: number;
  /** Sessions written (new, appended to or replaced). */
  sessions: number;
  errors: { path: string; error: string }[];
  /** Database generation after this sync. */
  generation: number;
  /** Set when the search index could not be updated; it is rebuilt on a later sync. */
  indexError?: string;
  durationMs: number;
}

/**
 * Roots for an adapter. AGENT_MONITOR_<ID>_DIRS (path-delimiter separated)
 * overrides the adapter's defaults, e.g. AGENT_MONITOR_CLAUDE_CODE_DIRS.
 */
export function rootsFor(adapter: Adapter, env: Env): string[] {
  const override = env[`AGENT_MONITOR_${adapter.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_DIRS`];
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
 * sessions, whose totals are recomputed. Sessions stored from the same file are
 * about to be replaced and do not compete.
 */
function keepOwnRequests(db: Db, filePath: string, id: string, s: ParsedSession): UsageRecord[] {
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
  return kept;
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
}

/** Store one log file's fresh parse: append new events when only the tail changed, otherwise replace the session. */
export function writeSession(db: Db, filePath: string, s: ParsedSession | null, prices: Record<string, ModelPrice>): SessionChange {
  const stored = db
    .prepare("SELECT id, event_count, events_hash, title, cwd, git_branch FROM sessions WHERE file_path = ?")
    .all(filePath) as unknown as StoredSession[];
  if (!s) {
    db.prepare("DELETE FROM sessions WHERE file_path = ?").run(filePath);
    return { deleteSessions: stored.map((r) => r.id), add: [] };
  }
  const id = `${s.source}:${s.nativeId}`;

  const kept = keepOwnRequests(db, filePath, id, s);
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
    s.parentNativeId ? `${s.source}:${s.parentNativeId}` : null,
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
  s.events.forEach((e, seq) => {
    const ts = Math.round(e.ts);
    const text = clip(e.text, e.kind === "tool_result" ? MAX_TOOL_TEXT : MAX_TEXT);
    const toolInput = clip(e.toolInput, MAX_TOOL_TEXT);
    if (appendFrom === null || seq >= appendFrom) {
      insertEvent.run(id, seq, ts, e.kind, text, e.toolName ?? null, e.toolCallId ?? null, toolInput, e.isError ? 1 : 0, e.model ?? null);
    }
    if (seq >= reindexFrom) docs.push(eventDoc(id, s.source, seq, { ts, kind: e.kind, text, toolName: e.toolName ?? null, toolInput }));
  });

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
  return { deleteSessions, add: docs };
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

/** Scan every adapter's roots and the archive, (re)ingest new or changed logs, and bring the search index along. */
export async function syncAll(db: Db, options: SyncOptions = {}): Promise<SyncResult> {
  const started = Date.now();
  const env = options.env ?? process.env;
  const prices = options.prices ?? loadPrices(env);
  const archiveDir = options.archiveDir ?? defaultArchiveDir(env);
  const adapters = options.adapters ?? defaultAdapters;
  const result: SyncResult = { scanned: 0, parsed: 0, sessions: 0, errors: [], generation: 0, durationMs: 0 };
  const known = new Map(
    (db.prepare("SELECT path, size, mtime_ms FROM files").all() as { path: string; size: number; mtime_ms: number }[]).map(
      (r) => [r.path, r],
    ),
  );
  const seen = new Set<string>();
  const changes: SessionChange[] = [];
  const upsertFile = db.prepare(
    `INSERT INTO files (path, adapter, size, mtime_ms, synced_at, missing, error) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET adapter = excluded.adapter, size = excluded.size, mtime_ms = excluded.mtime_ms,
       synced_at = excluded.synced_at, missing = excluded.missing, error = excluded.error`,
  );

  const ingest = (adapter: Adapter, filePath: string, content: string, stat: { size: number; mtimeMs: number }, missing: boolean) => {
    let parsed = false;
    try {
      const session = adapter.parse(filePath, content);
      parsed = true;
      const change = transaction(db, () => {
        const c = writeSession(db, filePath, session, prices);
        upsertFile.run(filePath, adapter.id, stat.size, stat.mtimeMs, Date.now(), missing ? 1 : 0, null);
        return c;
      });
      changes.push(change);
      result.parsed++;
      if (session) result.sessions++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push({ path: filePath, error: message });
      // A parse error repeats until the file changes, so remember its size and skip it until then. A failed write
      // (e.g. "database is locked" while another process syncs) is transient: size -1 makes the next sync retry it.
      try {
        upsertFile.run(filePath, adapter.id, parsed ? -1 : stat.size, stat.mtimeMs, Date.now(), missing ? 1 : 0, message);
      } catch {
        // The database is still unavailable; the file is unknown to it and gets picked up next time anyway.
      }
    }
  };

  for (const adapter of adapters) {
    for (const root of rootsFor(adapter, env)) {
      for await (const filePath of walk(root)) {
        if (!adapter.match(filePath) || seen.has(filePath)) continue;
        seen.add(filePath);
        result.scanned++;
        let stat;
        try {
          stat = await fs.stat(filePath);
        } catch {
          continue; // Deleted between readdir and stat.
        }
        const previous = known.get(filePath);
        if (!options.full && previous && previous.size === stat.size && previous.mtime_ms === stat.mtimeMs) continue;
        let raw: Buffer;
        try {
          raw = await fs.readFile(filePath);
        } catch {
          continue; // Deleted between stat and read.
        }
        try {
          await writeArchive(archiveDir, adapter.id, filePath, raw);
        } catch (error) {
          // Ingest anyway; the archive catches up on the file's next change.
          result.errors.push({ path: filePath, error: `archive: ${error instanceof Error ? error.message : String(error)}` });
        }
        ingest(adapter, filePath, raw.toString("utf8"), stat, false);
      }
    }
  }

  // Logs the tools have deleted: history is kept. After a rebuild (or with --full) they are re-parsed from the archive.
  const byId = new Map(adapters.map((a) => [a.id, a]));
  for await (const entry of listArchive(archiveDir)) {
    const adapter = byId.get(entry.adapterId);
    if (!adapter || seen.has(entry.original) || !adapter.match(entry.original)) continue;
    if (!options.full && known.has(entry.original)) continue; // Already ingested; flagged missing below.
    seen.add(entry.original);
    try {
      const stat = await fs.stat(entry.file);
      const content = await readArchive(entry.file);
      ingest(adapter, entry.original, content, { size: Buffer.byteLength(content), mtimeMs: stat.mtimeMs }, true);
    } catch (error) {
      result.errors.push({ path: entry.file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const markMissing = db.prepare("UPDATE files SET missing = 1 WHERE path = ?");
  for (const filePath of known.keys()) if (!seen.has(filePath)) markMissing.run(filePath);

  const indexedBefore = options.index?.generation() ?? null;
  const before = generation(db);
  // Without an index (e.g. tests) the bump alone makes the next indexing sync rebuild.
  result.generation = changes.length ? bumpGeneration(db) : before;

  if (options.index) {
    try {
      // Incremental only when the index was exactly at our starting point and no other process synced in between.
      if (indexedBefore !== before || result.generation > before + 1) rebuildIndex(db, options.index, result.generation);
      else if (changes.length) {
        options.index.apply({
          deleteSessions: [...new Set(changes.flatMap((c) => c.deleteSessions))],
          add: changes.flatMap((c) => c.add),
          generation: result.generation,
        });
      }
    } catch (error) {
      // Typically LOCKED: another process is writing the index. Moving the database past any generation that
      // process may commit forces a full rebuild on the next sync instead of silently missing these changes.
      result.indexError = error instanceof Error ? error.message : String(error);
      result.generation = bumpGeneration(db);
    }
  }

  result.durationMs = Date.now() - started;
  return result;
}
