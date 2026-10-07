import os from "node:os";
import path from "node:path";
import type { ParsedSession } from "./types";

/** Environment variables; a plain record so callers and tests need not fake a full process.env. */
export type Env = Record<string, string | undefined>;

/**
 * Reads one session log line by line. A log that only grew costs its new lines: sync keeps the parser of an active
 * log and feeds it the bytes that were appended (see src/ingest/incremental.ts), so nothing before them is read,
 * decoded or parsed again.
 *
 * Parsers are append-only: an event `result()` has already returned is never changed or removed by a later line.
 * Everything a later line may still change (title, cwd, endedAt, dispatchIndex, and usage, which Claude Code
 * deduplicates by message id and Codex replaces with its token_usage_record) lives outside `events`. A usage record
 * is immutable once pushed, so a changed one is a new object in `usage`.
 */
export interface LogParser {
  /**
   * Feed one line, as written (without its "\n"; a trailing "\r" is fine). Returns whether it was a complete record
   * the parser took. A line it did not take (blank, half-written, not an object) leaves the parser as it was, so a
   * caller reading a log as it grows must offer that last line again once more bytes arrived.
   */
  push(line: string): boolean;
  /**
   * The session the lines so far hold, or null when they hold none. May be called after any line with more lines to
   * follow, and stays cheap when called repeatedly. Throws when the lines are in a shape the adapter cannot read at
   * all; sync reports that like a parse error.
   */
  result(): ParsedSession | null;
}

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
   * A parser for one session log. Must be tolerant: skip lines it does not
   * understand (formats change between tool versions, and the last line may be
   * half-written). Its result is null when the file holds no session.
   */
  parser(filePath: string): LogParser;
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
  /** Shell the command is pasted into. Defaults to POSIX so adapters stay platform-independent. */
  shell?: ResumeShell;
}

/** The syntax a resume command is rendered in: `cd … && …`, or PowerShell's `Set-Location …; …` for cmd-less Windows. */
export type ResumeShell = "posix" | "powershell";

/** The shell of the machine the dashboard runs on; it is the user's own, so its platform decides. */
export const shellFor = (platform: string): ResumeShell => (platform === "win32" ? "powershell" : "posix");

/** Quote one argument for a POSIX shell; plain words stay unquoted. */
export const shellQuote = (arg: string): string => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

/** Every character PowerShell reads as a single quote: it closes a quoted string, and doubling it escapes it. */
const PS_QUOTES = /['\u2018\u2019\u201a\u201b]/g;

/**
 * Quote one argument for PowerShell: a single-quoted string expands nothing and a doubled quote is a literal
 * one, so a backslash path survives as written. The curly quotes `‘ ’ ‚ ‛` are quotes to PowerShell as well,
 * so they are doubled too: a directory named `Bob’s Projects` would otherwise end the string and have the
 * rest of its name parsed as code. Plain ASCII words stay unquoted; `@`, `,`, `$`, `#`, `{` and `%` are
 * argument-mode syntax and are left out of the safe set, as is everything non-ASCII.
 */
export const powershellQuote = (arg: string): string =>
  /^[\w+=:./\\-]+$/.test(arg) ? arg : `'${arg.replace(PS_QUOTES, (q) => q + q)}'`;

/**
 * `cd <cwd> && <command…>`, or `Set-Location -LiteralPath <cwd> -ErrorAction Stop; <command…>` for PowerShell,
 * with every argument quoted for that shell; no directory change when the directory is unknown. A missing
 * directory must not start the agent somewhere else, so both forms stop at the failed directory change:
 * `&&` for POSIX, and `-ErrorAction Stop` for PowerShell, whose default is to carry on after the error.
 */
export const shellCommand = (target: Pick<ResumeTarget, "cwd" | "shell">, ...argv: string[]): string => {
  const posix = target.shell !== "powershell";
  const quote = posix ? shellQuote : powershellQuote;
  const command = argv.map(quote).join(" ");
  if (!target.cwd) return command;
  return posix
    ? `cd ${quote(target.cwd)} && ${command}`
    : `Set-Location -LiteralPath ${quote(target.cwd)} -ErrorAction Stop; ${command}`;
};

export const homeDir = (env: Env): string => env.HOME || os.homedir();

export const expandHome = (p: string, env: Env): string =>
  p.startsWith("~/") ? path.join(homeDir(env), p.slice(2)) : p;

/**
 * A LogParser over JSON object lines: `line` sees every line that is one, in order. Blank lines, lines that are not
 * a JSON object and half-written ones are skipped and reported as not taken, so a log being read as it grows offers
 * its last line again once the rest of it arrived. An array line is never taken either: more elements may follow.
 */
export const jsonParser = (line: (record: Record<string, unknown>) => void, result: () => ParsedSession | null): LogParser => ({
  push(text) {
    if (!text.trim()) return false;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return false; // Partially written or corrupt line.
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    line(value as Record<string, unknown>);
    return true;
  },
  result,
});

/** Parse a whole log with the adapter's parser: every line, a last one without its newline included. */
export function parseLog(adapter: Adapter, filePath: string, content: string): ParsedSession | null {
  const parser = adapter.parser(filePath);
  for (const line of content.split("\n")) parser.push(line);
  return parser.result();
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
