import { fileOps } from "./activity";
import { isShellTool, shellCommand } from "./shell";
import type { AgentEvent } from "./types";

/**
 * Retry loops: one agent going round in circles on the same thing. Derived
 * from one session's ordered tool calls and their results; pure and
 * deterministic, shared by the `loop` auto-tag and the session page.
 *
 * - `edit`: a file was written or edited at least EDIT_LOOP_MIN_EDITS times and at least
 *   EDIT_LOOP_MIN_CYCLES of those edits came right after a failure (edit → failed command → edit):
 *   the edit before it failed itself, or a tool call between the two failed.
 * - `command`: the same shell command (normalized, see `normalizeCommand`) failed at least
 *   COMMAND_LOOP_MIN_FAILURES times in a row. A successful run of that command ends the streak
 *   (it got fixed; later failures are a new problem); other calls in between do not.
 * - `call`: the same non-shell tool call (tool and identical arguments) failed at least
 *   CALL_LOOP_MIN_FAILURES times in a row, with the same streak rule.
 *
 * Calls whose result never arrived count neither as failed nor as successful.
 */

export const EDIT_LOOP_MIN_EDITS = 5;
export const EDIT_LOOP_MIN_CYCLES = 2;
export const COMMAND_LOOP_MIN_FAILURES = 3;
export const CALL_LOOP_MIN_FAILURES = 3;

export type LoopKind = "edit" | "command" | "call";

export interface Loop {
  kind: LoopKind;
  /** File path (absolute when the working directory is known), normalized command, or `tool argument`. */
  subject: string;
  /** Edits of the file, or failed runs of the command or call. */
  count: number;
  /** `edit`: edits that followed a failure. `command`/`call`: equal to `count`. */
  failures: number;
  firstSeq: number;
  lastSeq: number;
  firstTs: number;
  lastTs: number;
  /** Sequence numbers of the calls making up the loop: every edit of the file, or every failed run. */
  seqs: number[];
}

/** One timeline event; `seq` defaults to the position in the list. */
export type LoopEvent = Pick<AgentEvent, "ts" | "kind" | "toolName" | "toolCallId" | "toolInput" | "isError"> & { seq?: number };

interface Call {
  seq: number;
  ts: number;
  tool: string;
  input: string | undefined;
  /** Undefined until the result arrives. */
  failed?: boolean;
}

/** Tool calls in order, each with the outcome of its result: paired by call id, else the latest open call (of the same tool, when the result names it). */
function pairCalls(events: readonly LoopEvent[]): Call[] {
  const calls: Call[] = [];
  const byId = new Map<string, Call>();
  const open: Call[] = [];
  events.forEach((e, i) => {
    if (e.kind === "tool_call") {
      const c: Call = { seq: e.seq ?? i, ts: e.ts, tool: e.toolName ?? "", input: e.toolInput ?? undefined };
      calls.push(c);
      open.push(c);
      if (e.toolCallId) byId.set(e.toolCallId, c);
    } else if (e.kind === "tool_result") {
      const c = (e.toolCallId ? byId.get(e.toolCallId) : undefined) ?? open.findLast((x) => !e.toolName || x.tool === e.toolName);
      if (!c || c.failed !== undefined) return;
      c.failed = e.isError === true;
      const at = open.indexOf(c);
      if (at >= 0) open.splice(at, 1);
    }
  });
  return calls;
}

const parseArgs = (input: string | undefined): Record<string, unknown> | undefined => {
  if (!input) return undefined;
  try {
    const v: unknown = JSON.parse(input);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** Commands that set up rather than do the work; left out of the normalized form. */
const SETUP: Record<string, true> = { cd: true, pushd: true, popd: true, export: true, source: true, ".": true, set: true, unset: true, echo: true, printf: true, sleep: true, true: true, clear: true };
/** Wrappers in front of the real command. */
const WRAPPERS: Record<string, true> = { sudo: true, env: true, time: true, nice: true, nohup: true, command: true, exec: true };
/** Here-document bodies, from `<<EOF` through the terminator line. */
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g;
/** Redirections: `2>&1`, `> out.log`, `&>/dev/null`, `< in.txt`. */
const REDIRECT = /(?:\d*|&)>>?\s*(?:&\d+|\S+)|\d*<(?!<)\s*\S+/g;

/**
 * Identity of a shell script for retry detection: each simple command as program basename plus its
 * arguments, quotes, redirections and wrappers (`sudo`, `env A=1`, `timeout 60`) removed; a pipeline is
 * named after its first stage and setup commands (`cd`, `export`, `echo`) are dropped.
 * `cd app && CI=1 pnpm test 2>&1 | tail -40` and `pnpm  test` both become `pnpm test`.
 */
export function normalizeCommand(script: string): string {
  const body = script.replace(HEREDOC, "");
  const out: string[] = [];
  for (const segment of body.split(/\r?\n|&&|\|\||;/)) {
    const w = segment
      .split("|")[0]
      .replace(REDIRECT, " ")
      .replace(/&\s*$/, "")
      .trim()
      .split(/\s+/)
      .map((x) => x.replace(/^['"]+|['"]+$/g, ""))
      .filter(Boolean);
    let i = 0;
    while (i < w.length) {
      if (/^[A-Za-z_]\w*=/.test(w[i]) || Object.hasOwn(WRAPPERS, w[i])) i++;
      else if (w[i] === "timeout") i += 2;
      else break;
    }
    if (i >= w.length) continue;
    const program = w[i].slice(w[i].lastIndexOf("/") + 1);
    if (Object.hasOwn(SETUP, program)) continue;
    out.push([program, ...w.slice(i + 1)].join(" "));
  }
  return out.length ? out.join(" && ") : body.replace(/\s+/g, " ").trim();
}

const ARG_MAX = 60;

/** `tool argument` naming a non-shell call: its path, pattern, query or URL, else its clipped arguments. */
function callSubject(tool: string, input: string | undefined): string {
  const args = parseArgs(input);
  const main = [args?.file_path, args?.path, args?.pattern, args?.query, args?.url, args?.notebook_path].find((v) => typeof v === "string" && v.trim());
  const arg = typeof main === "string" ? main : (input ?? "");
  const flat = arg.replace(/\s+/g, " ").trim();
  return [tool, flat.length > ARG_MAX ? `${flat.slice(0, ARG_MAX - 1)}…` : flat].filter(Boolean).join(" ");
}

const span = (kind: LoopKind, subject: string, calls: Call[], failures: number): Loop => ({
  kind,
  subject,
  count: calls.length,
  failures,
  firstSeq: calls[0].seq,
  lastSeq: calls[calls.length - 1].seq,
  firstTs: calls[0].ts,
  lastTs: calls[calls.length - 1].ts,
  seqs: calls.map((c) => c.seq),
});

/** Retry loops of one session (one agent), ordered by where they start. `cwd` resolves relative file paths. */
export function detectLoops(events: readonly LoopEvent[], cwd?: string | null): Loop[] {
  const calls = pairCalls(events);
  const loops: Loop[] = [];

  // Edits per file; `mark` is the failure count right after the file's latest edit was issued.
  const files = new Map<string, { edits: Call[]; cycles: number; mark: number }>();
  // Failure streaks per command or identical call.
  const streaks = new Map<string, { kind: LoopKind; subject: string; failed: Call[] }>();
  const flush = (key: string) => {
    const s = streaks.get(key);
    if (!s) return;
    streaks.delete(key);
    const min = s.kind === "command" ? COMMAND_LOOP_MIN_FAILURES : CALL_LOOP_MIN_FAILURES;
    if (s.failed.length >= min) loops.push(span(s.kind, s.subject, s.failed, s.failed.length));
  };
  let failures = 0;

  for (const c of calls) {
    const ops = fileOps(c.tool, c.input, cwd ?? undefined);
    const changed = new Set(ops.filter((o) => o.op === "edit" || o.op === "write").map((o) => o.path));
    for (const p of changed) {
      let f = files.get(p);
      if (!f) files.set(p, (f = { edits: [], cycles: 0, mark: failures }));
      else if (failures > f.mark) f.cycles++;
      f.edits.push(c);
      f.mark = failures;
    }

    const name = c.tool.toLowerCase();
    let key: string | undefined;
    if (isShellTool(name)) {
      // A shell call that patches files is an edit; its retries show up as an edit loop.
      const script = ops.length ? undefined : shellCommand(parseArgs(c.input));
      if (script?.trim()) {
        const command = normalizeCommand(script);
        key = `command\0${command}`;
        if (!streaks.has(key)) streaks.set(key, { kind: "command", subject: command, failed: [] });
      }
    } else if (c.tool) {
      key = `call\0${c.tool}\0${c.input ?? ""}`;
      if (!streaks.has(key)) streaks.set(key, { kind: "call", subject: callSubject(c.tool, c.input), failed: [] });
    }
    if (key) {
      if (c.failed) streaks.get(key)?.failed.push(c);
      else if (c.failed === false) flush(key);
    }
    if (c.failed) failures++;
  }

  for (const key of [...streaks.keys()]) flush(key);
  for (const [p, f] of files) {
    if (f.edits.length >= EDIT_LOOP_MIN_EDITS && f.cycles >= EDIT_LOOP_MIN_CYCLES) loops.push(span("edit", p, f.edits, f.cycles));
  }
  return loops.sort((a, b) => a.firstSeq - b.firstSeq || a.kind.localeCompare(b.kind) || a.subject.localeCompare(b.subject));
}

const REASON_SUBJECT_MAX = 60;
const REASON_MAX_LOOPS = 3;

/** "src/a.ts edited 9 times; `pnpm test` failed 4 times": the biggest loops, paths relative to `cwd`. */
export function loopReason(loops: readonly Loop[], cwd?: string | null): string {
  // Streaks of the same command or call add up; a file has one entry anyway.
  const merged = new Map<string, { kind: LoopKind; subject: string; count: number; first: number }>();
  for (const l of loops) {
    const key = `${l.kind}\0${l.subject}`;
    const m = merged.get(key);
    if (m) m.count += l.count;
    else merged.set(key, { kind: l.kind, subject: l.subject, count: l.count, first: l.firstSeq });
  }
  const root = cwd ? (cwd.endsWith("/") ? cwd : `${cwd}/`) : undefined;
  const clip = (s: string) => (s.length > REASON_SUBJECT_MAX ? `${s.slice(0, REASON_SUBJECT_MAX - 1)}…` : s);
  const list = [...merged.values()].sort((a, b) => b.count - a.count || a.first - b.first);
  const parts = list.slice(0, REASON_MAX_LOOPS).map((l) =>
    l.kind === "edit"
      ? `${clip(root && l.subject.startsWith(root) ? l.subject.slice(root.length) : l.subject)} edited ${l.count} times`
      : `\`${clip(l.subject)}\` failed ${l.count} times`,
  );
  if (list.length > REASON_MAX_LOOPS) parts.push(`${list.length - REASON_MAX_LOOPS} more`);
  return parts.join("; ");
}
