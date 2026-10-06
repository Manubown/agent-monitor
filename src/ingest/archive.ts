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
 */

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export function archivePath(archiveDir: string, adapterId: string, filePath: string): string {
  return path.join(archiveDir, adapterId, `${path.resolve(filePath).replace(/^[/\\]+/, "").replace(/:/g, "")}.gz`);
}

/** Replace the archived copy atomically (write + rename), so a crash never leaves a truncated archive. */
export async function writeArchive(archiveDir: string, adapterId: string, filePath: string, content: Buffer): Promise<void> {
  const target = archivePath(archiveDir, adapterId, filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, await gzip(content));
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/** The archived log's raw bytes, decoded like a live log by the caller. */
export async function readArchive(file: string): Promise<Buffer> {
  return gunzip(await fs.readFile(file));
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
