import { createHash, type Hash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

/**
 * The archive keeps a gzip copy of every ingested log so history survives the
 * tools pruning their own logs, and so the database (a cache) can always be
 * rebuilt. Layout mirrors the original absolute path under the adapter id:
 *
 *   <archive>/<adapter>/home/me/.claude/projects/-proj/sess.jsonl.gz
 *
 * so the original path, and with it everything adapters derive from the path
 * (subagent links, ids), is recoverable without a manifest.
 *
 * A copy is one gzip member per write: a log that only grew gets its new bytes
 * appended as another member (gunzip returns the members' data concatenated).
 */

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export function archivePath(archiveDir: string, adapterId: string, filePath: string): string {
  return path.join(archiveDir, adapterId, `${path.resolve(filePath).replace(/^[/\\]+/, "").replace(/:/g, "")}.gz`);
}

/** What an archive copy holds after our last write to it; kept on the log's `files` row. */
export interface ArchiveState {
  /** Bytes of the log the copy holds. */
  size: number;
  /** sha1 (hex) of those bytes. */
  hash: string;
  /** Size of the .gz file as we left it. */
  gzSize: number;
}

/** What a write left behind, with the running hash over those bytes so an append need not hash the prefix again. */
export interface ArchiveWrite extends ArchiveState {
  running: Hash;
}

const gzSizeOf = async (file: string): Promise<number | null> => {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
};

/**
 * Suffix of the copy a rewrite replaced when the log no longer started with what the copy held: `<copy>.gz.<epoch
 * ms>.prev` for each time the log shrank, `<copy>.gz.prev` for the latest in-place rewrite of a log that kept growing.
 * listArchive only takes names ending in ".gz", so these are kept for the user, never read back as logs.
 */
export const PREVIOUS_SUFFIX = ".prev";

/**
 * Bring the archived copy up to `content`. With the state of our last write (`previous`), a log whose archived
 * prefix is unchanged and whose .gz is exactly as we left it only gets its new bytes appended, as one more gzip
 * member; a failed append is cut back off. Anything else (a rewritten log, a torn or foreign .gz, no state) replaces
 * the copy atomically (write + rename), so a crash never leaves a truncated archive. An append whose .gz does not
 * end up the size it should (another process appended the same tail at the same time) is redone as a rewrite. When
 * `previous` shows the log no longer starts with what the copy holds, the replaced copy is kept next to the new one
 * (see PREVIOUS_SUFFIX), so history the tool dropped stays archived. Returns the new state, including the running
 * hash of the bytes the copy now holds (see `appendArchive`).
 */
export async function writeArchive(
  archiveDir: string,
  adapterId: string,
  filePath: string,
  content: Buffer,
  previous: ArchiveState | null = null,
): Promise<ArchiveWrite> {
  const target = archivePath(archiveDir, adapterId, filePath);
  const hash = createHash("sha1");
  let prefixMatches = false;
  if (previous && content.length >= previous.size) {
    // One pass over the bytes: the prefix's digest from a copy of the running hash, then the rest.
    hash.update(content.subarray(0, previous.size));
    prefixMatches = hash.copy().digest("hex") === previous.hash;
    hash.update(content.subarray(previous.size));
  } else hash.update(content);
  const state = { size: content.length, hash: hash.copy().digest("hex"), gzSize: 0 };

  if (previous && prefixMatches && (await gzSizeOf(target)) === previous.gzSize) {
    if (content.length === previous.size) return { ...previous, running: hash };
    const member = await gzip(content.subarray(previous.size));
    try {
      await fs.appendFile(target, member);
    } catch (error) {
      await fs.truncate(target, previous.gzSize).catch(() => {});
      throw error;
    }
    const gzSize = previous.gzSize + member.length;
    // Two processes (the server and `pnpm watch`) can both pass the size check and append the same tail. Each then
    // sees the other's bytes and rewrites the copy whole from its own content.
    if ((await gzSizeOf(target)) === gzSize) return { ...state, gzSize, running: hash };
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  if (previous && !prefixMatches) {
    // The copy holds bytes the log no longer has. A log that shrank lost them: every such copy is kept. One rewritten
    // in place that kept growing (omp rewrites its title line on every rename) most likely lost little: only the latest
    // replaced copy is kept, so frequent rewrites cannot multiply the archive.
    const keep = content.length < previous.size ? `${target}.${Date.now()}${PREVIOUS_SUFFIX}` : `${target}${PREVIOUS_SUFFIX}`;
    await fs.copyFile(target, keep).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    const gz = await gzip(content);
    await fs.writeFile(tmp, gz);
    await fs.rename(tmp, target);
    return { ...state, gzSize: gz.length, running: hash };
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/**
 * Append `added` to the archived copy as one more gzip member, for a log whose first `previous.size` bytes are
 * known to be unchanged (sync checks that before reading only the new bytes, see src/ingest/incremental.ts).
 * `running` is the sha1 of those bytes, extended by `added` instead of hashing the log again. Returns null when
 * the copy is not exactly as our last write left it, or when another process appended at the same time: the caller
 * then reads the whole log and rewrites the copy with `writeArchive`. A failed append is cut back off.
 */
export async function appendArchive(
  archiveDir: string,
  adapterId: string,
  filePath: string,
  added: Buffer,
  previous: ArchiveState,
  running: Hash,
): Promise<ArchiveWrite | null> {
  if (running.copy().digest("hex") !== previous.hash) return null; // Another process rewrote the copy.
  const target = archivePath(archiveDir, adapterId, filePath);
  if ((await gzSizeOf(target)) !== previous.gzSize) return null;
  if (added.length === 0) return { ...previous, running };
  const member = await gzip(added);
  try {
    await fs.appendFile(target, member);
  } catch (error) {
    await fs.truncate(target, previous.gzSize).catch(() => {});
    throw error;
  }
  const gzSize = previous.gzSize + member.length;
  // Two processes can both pass the size check and append the same tail; the copy is rewritten whole instead.
  if ((await gzSizeOf(target)) !== gzSize) return null;
  running.update(added);
  return { size: previous.size + added.length, hash: running.copy().digest("hex"), gzSize, running };
}

const inflateRaw = (data: Buffer): Promise<{ buffer: Buffer; consumed: number }> =>
  new Promise((resolve, reject) => {
    // `info` makes the callback receive the engine too, whose bytesWritten is the input the deflate stream used.
    zlib.inflateRaw(data, { info: true, finishFlush: zlib.constants.Z_SYNC_FLUSH } as zlib.ZlibOptions, (error, result) => {
      if (error) return reject(error);
      const { buffer, engine } = result as unknown as { buffer: Buffer; engine: zlib.Zlib };
      resolve({ buffer, consumed: engine.bytesWritten });
    });
  });

/** Length of the gzip member header at `at` (RFC 1952), or null when there is none or it is cut off. */
function gzipHeaderLength(gz: Buffer, at: number): number | null {
  if (gz.length < at + 10 || gz[at] !== 0x1f || gz[at + 1] !== 0x8b || gz[at + 2] !== 8) return null;
  const flags = gz[at + 3];
  let end = at + 10;
  if (flags & 4) end = gz.length < end + 2 ? Infinity : end + 2 + gz.readUInt16LE(end); // FEXTRA
  for (const flag of [8, 16]) {
    // FNAME, FCOMMENT: zero-terminated.
    if (!(flags & flag) || end >= gz.length) continue;
    const zero = gz.indexOf(0, end);
    end = zero < 0 ? Infinity : zero + 1;
  }
  if (flags & 2) end += 2; // FHCRC
  return end < gz.length ? end - at : null;
}

/**
 * The data of every gzip member that decodes, in order, up to the first that does not: the last one decoded as far
 * as its bytes go. Checksums are not verified; this only salvages a damaged copy.
 */
async function salvageMembers(gz: Buffer): Promise<Buffer> {
  const out: Buffer[] = [];
  let at = 0;
  while (at < gz.length) {
    const header = gzipHeaderLength(gz, at);
    if (header === null) break;
    let member;
    try {
      member = await inflateRaw(gz.subarray(at + header));
    } catch {
      break;
    }
    out.push(member.buffer);
    // The deflate stream, then the member's 8-byte trailer (CRC32, size).
    at += header + member.consumed + 8;
  }
  return Buffer.concat(out);
}

/**
 * The archived log's raw bytes (every member), decoded like a live log by the caller. A crash during an append can
 * leave the last member truncated or leave bytes that are no gzip member at all; the members before it are still
 * read, and as much of a truncated one as its bytes hold (adapters tolerate a half-written last line), so a copy
 * whose log the tool has since deleted keeps its history. A copy from which nothing decodes is an error.
 */
export async function readArchive(file: string): Promise<Buffer> {
  const gz = await fs.readFile(file);
  try {
    return await gunzip(gz);
  } catch (error) {
    const salvaged = await salvageMembers(gz);
    if (salvaged.length > 0) return salvaged;
    throw error;
  }
}

export interface ArchivedLog {
  adapterId: string;
  /** Path of the original log. */
  original: string;
  /** Path of the gzip copy. */
  file: string;
}

/**
 * Inverse of archivePath for a path relative to the adapter's directory (without ".gz"): restores the root it
 * stripped. On Windows "C\Users\..." was "C:\Users\..."; anything else was a UNC path "\\server\share\...".
 */
function originalPath(rel: string): string {
  if (process.platform !== "win32") return `/${rel}`;
  return /^[A-Za-z]\\/.test(rel) ? `${rel[0]}:${rel.slice(1)}` : `\\\\${rel}`;
}

/** Every archived log; empty when the archive does not exist yet. */
export async function* listArchive(archiveDir: string): AsyncGenerator<ArchivedLog> {
  let adapters;
  try {
    adapters = await fs.readdir(archiveDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dir of adapters) {
    if (!dir.isDirectory()) continue;
    const base = path.join(archiveDir, dir.name);
    for (const rel of await fs.readdir(base, { recursive: true })) {
      if (!rel.endsWith(".gz")) continue;
      yield { adapterId: dir.name, original: originalPath(rel.slice(0, -".gz".length)), file: path.join(base, rel) };
    }
  }
}
