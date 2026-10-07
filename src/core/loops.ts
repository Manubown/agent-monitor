import { fileOps } from "./activity";
import { slashPath } from "./paths";
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

/** Edits of one file; `mark` is the failure count right after its latest edit was issued. */
interface FileEdits {
  edits: Call[];
  cycles: number;
  mark: number;
}

/** A failure streak of one command or identical call. */
interface Streak {
  kind: LoopKind;
  subject: string;
  failed: Call[];
}

/**
 * Running loop detection for one session, so a growing log only pays for its new events: events are added in order
 * and never taken back, and `loops()` may be called after any number of them.
 *
 * A call is processed once its result arrived, because the result decides what the call means for the loops around
 * it. The calls still waiting are processed speculatively in `loops()` and rolled back again afterwards, which is
 * what reading the whole log at once does with the calls whose result never came.
 */
export class LoopScan {
  private readonly cwd?: string;
  private readonly files = new Map<string, FileEdits>();
  private readonly streaks = new Map<string, Streak>();
  /** Calls by id, and those still waiting for a result, for pairing results with their call. */
  private readonly byId = new Map<string, Call>();
  private readonly open: Call[] = [];
  /** Calls not processed yet: the first one still waiting for its result, and every call after it. */
  private queue: Call[] = [];
  /** Loops of streaks that ended. */
  private readonly done: Loop[] = [];
  private failures = 0;
  /** While `loops()` works through the queue, how to undo that again. */
  private undo: (() => void)[] | null = null;

  constructor(cwd?: string | null) {
    this.cwd = cwd ?? undefined;
  }

  /** Add the events from `from` on, in timeline order; an event's index is its sequence number unless it carries one. */
  add(events: readonly LoopEvent[], from = 0): this {
    for (let i = from; i < events.length; i++) {
      const e = events[i];
      if (e.kind === "tool_call") {
        const c: Call = { seq: e.seq ?? i, ts: e.ts, tool: e.toolName ?? "", input: e.toolInput ?? undefined };
        this.queue.push(c);
        this.open.push(c);
        if (e.toolCallId) this.byId.set(e.toolCallId, c);
      } else if (e.kind === "tool_result") {
        const c = (e.toolCallId ? this.byId.get(e.toolCallId) : undefined) ?? this.open.findLast((x) => !e.toolName || x.tool === e.toolName);
        if (!c || c.failed !== undefined) continue;
        c.failed = e.isError === true;
        const at = this.open.indexOf(c);
        if (at >= 0) this.open.splice(at, 1);
      }
    }
    let settled = 0;
    while (settled < this.queue.length && this.queue[settled].failed !== undefined) this.process(this.queue[settled++]);
    if (settled) this.queue = this.queue.slice(settled);
    return this;
  }

  /** Every loop the events so far make up, ordered by where it starts. */
  loops(): Loop[] {
    const undo: (() => void)[] = [];
    this.undo = undo;
    try {
      for (const c of this.queue) this.process(c);
      const loops = [...this.done];
      for (const s of this.streaks.values()) {
        const loop = this.spanOf(s);
        if (loop) loops.push(loop);
      }
      for (const [p, f] of this.files) {
        if (f.edits.length >= EDIT_LOOP_MIN_EDITS && f.cycles >= EDIT_LOOP_MIN_CYCLES) loops.push(span("edit", p, f.edits, f.cycles));
      }
      return loops.sort((a, b) => a.firstSeq - b.firstSeq || a.kind.localeCompare(b.kind) || a.subject.localeCompare(b.subject));
    } finally {
      for (let i = undo.length - 1; i >= 0; i--) undo[i]();
      this.undo = null;
    }
  }

  /** The loop a streak makes up, if it is long enough to be one. */
  private spanOf(s: Streak): Loop | undefined {
    const min = s.kind === "command" ? COMMAND_LOOP_MIN_FAILURES : CALL_LOOP_MIN_FAILURES;
    return s.failed.length >= min ? span(s.kind, s.subject, s.failed, s.failed.length) : undefined;
  }

  private flush(key: string): void {
    const s = this.streaks.get(key);
    if (!s) return;
    this.streaks.delete(key);
    this.undo?.push(() => this.streaks.set(key, s));
    const loop = this.spanOf(s);
    if (loop) {
      this.done.push(loop);
      this.undo?.push(() => void this.done.pop());
    }
  }

  private process(c: Call): void {
    const undo = this.undo;
    const ops = fileOps(c.tool, c.input, this.cwd);
    const changed = new Set(ops.filter((o) => o.op === "edit" || o.op === "write").map((o) => o.path));
    for (const p of changed) {
      const f = this.files.get(p);
      if (!f) {
        this.files.set(p, { edits: [c], cycles: 0, mark: this.failures });
        undo?.push(() => void this.files.delete(p));
        continue;
      }
      const { cycles, mark } = f;
      undo?.push(() => {
        f.edits.pop();
        f.cycles = cycles;
        f.mark = mark;
      });
      if (this.failures > f.mark) f.cycles++;
      f.edits.push(c);
      f.mark = this.failures;
    }

    const name = c.tool.toLowerCase();
    let key: string | undefined;
    if (isShellTool(name)) {
      // A shell call that patches files is an edit; its retries show up as an edit loop.
      const script = ops.length ? undefined : shellCommand(parseArgs(c.input));
      if (script?.trim()) {
        const command = normalizeCommand(script);
        key = `command\0${command}`;
        this.streak(key, { kind: "command", subject: command, failed: [] });
      }
    } else if (c.tool) {
      key = `call\0${c.tool}\0${c.input ?? ""}`;
      this.streak(key, { kind: "call", subject: callSubject(c.tool, c.input), failed: [] });
    }
    if (key) {
      if (c.failed) {
        const s = this.streaks.get(key) as Streak;
        s.failed.push(c);
        undo?.push(() => void s.failed.pop());
      } else if (c.failed === false) this.flush(key);
    }
    if (c.failed) {
      this.failures++;
      undo?.push(() => void this.failures--);
    }
  }

  /** Start a streak for `key` unless one is running. */
  private streak(key: string, fresh: Streak): void {
    if (this.streaks.has(key)) return;
    this.streaks.set(key, fresh);
    this.undo?.push(() => void this.streaks.delete(key));
  }
}

/** Retry loops of one session (one agent), ordered by where they start. `cwd` resolves relative file paths. */
export const detectLoops = (events: readonly LoopEvent[], cwd?: string | null): Loop[] => new LoopScan(cwd).add(events).loops();

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
  const dir = cwd && slashPath(cwd);
  const root = dir ? (dir.endsWith("/") ? dir : `${dir}/`) : undefined;
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
