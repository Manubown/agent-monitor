import { createHash, type Hash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import type { LogParser } from "../core/adapter";
import type { AutoTag, AutoTagScan } from "../core/autotags";
import type { CostSource } from "../core/pricing";
import type { TokenUsage, UsageRecord } from "../core/types";
import type { Db } from "../store/db";
import type { ArchiveState } from "./archive";

/**
 * Resumable reading of a log that keeps growing. An agent appends to its session log while the dashboard syncs it
 * every few seconds; reading, decoding and parsing the whole file each time costs time proportional to the session
 * so far instead of to what it just wrote.
 *
 * So the parser of a log stays in memory, together with the byte offset of the first line it has not read, what the
 * last write stored (`SessionCarry`) and the running sha1 its archive copy was left with. The next sync reads only
 * the bytes after the offset, feeds them to that parser, extends the stored session by the events they added and
 * appends the same bytes to the archive copy.
 *
 * This holds only while the log really is the one the state came from. Before using it, sync checks that its `files`
 * row is still the one that write left and verifies the bytes cheaply: the sha1 of the first HEAD_BYTES bytes and
 * the TAIL_BYTES just before the offset. omp rewrites its first line in place, so a rewrite of the same length is
 * caught by those bytes, not by size or mtime. Anything unexpected (a shrunk or rewritten log, `full`, an archive
 * copy that is not as we left it) falls back to reading the whole file, which rebuilds the state.
 */

/** The log bytes hashed at the start, to catch a rewritten prefix. */
const HEAD_BYTES = 64 * 1024;
/** The log bytes kept from just before the offset, to catch a rewrite the head check missed. */
const TAIL_BYTES = 4 * 1024;
/** Logs kept resumable per database, least recently synced first out. */
const MAX_LOGS = 16;
/** Total size of those logs; a parser holds every event of its session, so this bounds the memory the cache costs. */
const MAX_BYTES = 32 * 1024 * 1024;
/** A log nothing appended to for this long is dropped: agents move on, and its state is only memory by then. */
const IDLE_MS = 30 * 60_000;

/** A "\n" never appears inside a multi-byte UTF-8 character, so splitting bytes on it never splits a character. */
const NEWLINE = 0x0a;

/** One usage row as stored, so a session's totals can be added up again without reading them back. */
export interface UsageLine extends TokenUsage {
  model: string;
  usd: number | null;
  source: CostSource;
}

/**
 * The session row columns a carried write would otherwise take on trust. The write compares them with the row it
 * finds: another writer (a CLI `--full` sync with new prices, say) leaves a row this carry no longer describes.
 */
export interface CarriedRow {
  userMessages: number;
  toolCalls: number;
  toolErrors: number;
  errors: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  costSource: string;
  /** JSON array, as stored. */
  models: string;
}

/**
 * What the last write of a growing log stored, so the next one only pays for what was appended. It is only valid
 * while the session's row is still exactly what that write left: `writeSession` checks the event count, the chained
 * hash and every column in `row` before extending it, and rebuilds everything otherwise.
 */
export interface SessionCarry {
  /** Events written, and the chained hash over them (the row's `events_hash`). */
  events: number;
  hash: string;
  /** The row as this write left it. */
  row: CarriedRow;
  /** Directory and branch the tags were derived with; they resolve relative paths and decide the `refactor` tag. */
  cwd: string | null;
  gitBranch: string | null;
  /** The usage records as parsed when they were written; a record a later line changed is a new object. */
  usage: UsageRecord[];
  /** Per record, how many of the records up to it this session kept (a copy another session counts is dropped). */
  kept: number[];
  /** The usage rows written, in seq order. */
  rows: UsageLine[];
  /** The automatic tags written, and the state the next ones are derived from. */
  tags: AutoTag[];
  scan: AutoTagScan;
}

/** Everything needed to carry on reading one log where the last sync stopped. */
export interface LogState {
  adapterId: string;
  parser: LogParser;
  /** Offset of the first byte not read yet; just after a "\n" unless `pending`. */
  offset: number;
  /** The last line was taken without its newline (it was a complete record): the byte at `offset` must be it. */
  pending: boolean;
  /** Size, mtime and sync time of the log as its `files` row has them; the size is what the archive copy holds. */
  size: number;
  mtimeMs: number;
  syncedAt: number;
  /** sha1 of the first `headLen` bytes (the whole log while it is shorter than HEAD_BYTES). */
  head: Hash;
  headLen: number;
  /** The bytes just before `offset`. */
  tail: Buffer;
  /** Running sha1 of all `size` bytes: what the archive copy holds, extended when its new bytes are appended. */
  archive: Hash;
  carry: SessionCarry;
  /** When this state was last used, for eviction. */
  used: number;
}

/** Per database, its resumable logs in least-recently-used order. Dropped with the database itself. */
const caches = new WeakMap<Db, Map<string, LogState>>();

/** The resumable logs of one database: `get` one to resume it, `delete` it to have the next sync read it whole. */
export function logStates(db: Db): Map<string, LogState> {
  let logs = caches.get(db);
  if (!logs) caches.set(db, (logs = new Map()));
  return logs;
}

/**
 * Keep `state` for `filePath` as the most recently used one, and drop states that went idle or no longer fit. A log
 * larger than MAX_BYTES on its own is not kept at all: its parser would hold more memory than the cache may use.
 */
export function remember(db: Db, filePath: string, state: LogState): void {
  const logs = logStates(db);
  logs.delete(filePath);
  logs.set(filePath, state);
  let count = 0;
  let bytes = 0;
  for (const [p, s] of [...logs].reverse()) {
    // Only what is kept fills the cache: one log too big for it on its own must not push the others out.
    if (count + 1 > MAX_LOGS || bytes + s.size > MAX_BYTES || state.used - s.used > IDLE_MS) {
      logs.delete(p);
      continue;
    }
    count++;
    bytes += s.size;
  }
}

/** A log's text. One too big for a JavaScript string (~512 MiB) fails like an unparseable log: skipped until it changes. */
function decode(raw: Buffer): string {
  try {
    return raw.toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_STRING_TOO_LONG") throw error;
    throw new Error(`log too large to parse (${Math.round(raw.length / 2 ** 20)} MiB)`);
  }
}

/**
 * Feed the complete lines of `chunk` to `parser`, and return how many of its bytes that consumed. A last line
 * without its newline is only consumed when the parser takes it whole (a complete record, which a torn line is
 * not), so it is offered again with the bytes that follow it; those must then start with its newline, or the log
 * did not simply grow (see `appended`).
 */
export function feed(parser: LogParser, chunk: Buffer): number {
  const end = chunk.lastIndexOf(NEWLINE);
  if (end >= 0) for (const line of decode(chunk.subarray(0, end)).split("\n")) parser.push(line);
  const rest = chunk.subarray(end + 1);
  return rest.length > 0 && parser.push(decode(rest)) ? chunk.length : end + 1;
}

/** Read `length` bytes at `position`, as far as the file goes. */
async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return read === length ? buffer : buffer.subarray(0, read);
}

/**
 * The bytes of a log that `state` has not read yet, or null when the file is not the one that state came from: its
 * first bytes or those before the offset changed (omp rewrites its title line in place, to the same length or
 * another), the line taken without a newline grew instead of ending, or it no longer reaches `size`.
 */
export async function appended(state: LogState, filePath: string, size: number): Promise<Buffer | null> {
  const handle = await fs.open(filePath, "r");
  try {
    const head = await readAt(handle, 0, state.headLen);
    if (head.length !== state.headLen || createHash("sha1").update(head).digest("hex") !== state.head.copy().digest("hex")) return null;
    // The head covers the bytes before the offset while the log is short; only a longer one needs them read.
    if (state.offset > state.headLen && state.tail.length > 0) {
      const tail = await readAt(handle, state.offset - state.tail.length, state.tail.length);
      if (!tail.equals(state.tail)) return null;
    }
    const chunk = await readAt(handle, state.offset, size - state.offset);
    if (chunk.length !== size - state.offset) return null;
    return state.pending && chunk[0] !== NEWLINE ? null : chunk;
  } finally {
    await handle.close();
  }
}

/** The last TAIL_BYTES before the new offset, from the bytes just read and the ones kept last time. */
const extendTail = (old: Buffer, added: Buffer): Buffer =>
  added.length >= TAIL_BYTES
    ? Buffer.from(added.subarray(added.length - TAIL_BYTES))
    : Buffer.concat([old.subarray(Math.max(0, old.length - (TAIL_BYTES - added.length))), added]);

/** The state to resume from after reading a whole log; `consumed` is what `feed` took of it. */
export function logState(
  adapterId: string,
  parser: LogParser,
  raw: Buffer,
  consumed: number,
  stat: { size: number; mtimeMs: number },
  syncedAt: number,
  archive: Hash,
  carry: SessionCarry,
): LogState {
  const headLen = Math.min(raw.length, HEAD_BYTES);
  return {
    adapterId,
    parser,
    offset: consumed,
    pending: consumed > 0 && raw[consumed - 1] !== NEWLINE,
    size: raw.length,
    mtimeMs: stat.mtimeMs,
    syncedAt,
    head: createHash("sha1").update(raw.subarray(0, headLen)),
    headLen,
    tail: extendTail(Buffer.alloc(0), raw.subarray(0, consumed)),
    archive,
    carry,
    used: Date.now(),
  };
}

/**
 * Move `state` past the bytes `appended` returned, of which `feed` consumed `consumed`. The archive's running hash
 * is extended by `appendArchive`, which hashes the same bytes while compressing them.
 */
export function advance(state: LogState, chunk: Buffer, consumed: number, mtimeMs: number, syncedAt: number, carry: SessionCarry): void {
  const size = state.offset + chunk.length;
  const headLen = Math.min(size, HEAD_BYTES);
  if (headLen > state.headLen) {
    state.head.update(chunk.subarray(state.headLen - state.offset, headLen - state.offset));
    state.headLen = headLen;
  }
  if (consumed > 0) {
    state.tail = extendTail(state.tail, chunk.subarray(0, consumed));
    state.pending = chunk[consumed - 1] !== NEWLINE;
    state.offset += consumed;
  }
  state.size = size;
  state.mtimeMs = mtimeMs;
  state.syncedAt = syncedAt;
  state.carry = carry;
  state.used = Date.now();
}

/** Whether `state` may be resumed for a log of this size that `row` describes, and whose copy holds `archived`. */
export const resumes = (
  state: LogState,
  adapterId: string,
  row: { size: number; mtime_ms: number; synced_at: number; error: string | null },
  archived: ArchiveState | null,
  size: number,
): boolean =>
  state.adapterId === adapterId &&
  // Anyone else writing this log's row (another process syncing, a `--full` run) makes us read it whole again:
  // its session may hold other costs or tags than the state's, and only the row's own write time shows that.
  row.size === state.size &&
  row.mtime_ms === state.mtimeMs &&
  row.synced_at === state.syncedAt &&
  row.error === null &&
  archived !== null &&
  archived.size === state.size &&
  // A log that shrank or was rewritten to the same size is read whole.
  size > state.size;
