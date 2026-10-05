import os from "node:os";
import path from "node:path";
import type { ParsedSession } from "./types";

/** Environment variables; a plain record so callers and tests need not fake a full process.env. */
export type Env = Record<string, string | undefined>;

/**
 * An adapter teaches agent-monitor one tool's on-disk log format.
 *
 * To support a new agent CLI, implement this interface in `src/adapters/` and
 * register it in `src/adapters/index.ts`. Nothing else needs to change.
 */
export interface Adapter {
  /** Stable id stored with every session, e.g. "claude-code". */
  id: string;
  /** Human-readable name for the UI. */
  label: string;
  /** Directories to scan recursively. Honor the tool's own env vars (e.g. CODEX_HOME). */
  roots(env: Env): string[];
  /** Whether a file found under a root is a session log this adapter parses. */
  match(filePath: string): boolean;
  /**
   * Parse one session log. Must be pure and tolerant: skip lines it does not
   * understand (formats change between tool versions, and the last line may be
   * half-written). Return null when the file holds no session.
   */
  parse(filePath: string, content: string): ParsedSession | null;
  /**
   * Shell command that reopens a top-level session in its tool, if the tool can
   * resume sessions. Undefined for subagents (`parentNativeId` set): the UI
   * offers the parent's command instead.
   */
  resumeCommand?(s: ResumeTarget): string | undefined;
}

export interface ResumeTarget {
  nativeId: string;
  cwd?: string;
  /** The session's log file. */
  filePath: string;
  parentNativeId?: string;
}

/** Quote one argument for a POSIX shell; plain words stay unquoted. */
export const shellQuote = (arg: string): string => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

/** `cd <cwd> && <command…>` with every argument quoted; no `cd` when the directory is unknown. */
export const shellCommand = (cwd: string | undefined, ...argv: string[]): string => {
  const command = argv.map(shellQuote).join(" ");
  return cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
};

export const homeDir = (env: Env): string => env.HOME || os.homedir();

export const expandHome = (p: string, env: Env): string =>
  p.startsWith("~/") ? path.join(homeDir(env), p.slice(2)) : p;

/** Parse a JSONL document, skipping blank and malformed lines. */
export function* jsonLines(content: string): Generator<Record<string, unknown>> {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) yield value as Record<string, unknown>;
    } catch {
      // Partially written or corrupt line; a later sync will pick it up once complete.
    }
  }
}

/** Accept ISO strings, epoch ms, or epoch seconds. */
export function toMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value) {
    const n = Date.parse(value);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

export const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

export const obj = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Serialize tool arguments for storage. */
export const stringifyInput = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/** Short single-line title from a prompt. */
export const titleFrom = (text: string | undefined, max = 90): string | undefined => {
  const line = text
    ?.split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
