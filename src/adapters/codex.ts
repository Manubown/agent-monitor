import { createHash } from "node:crypto";
import path from "node:path";
import { type Adapter, arr, homeDir, jsonLines, num, obj, shellCommand, str, stringifyInput, titleFrom, toMs } from "../core/adapter";
import { COMPACTION_TEXT, isCompactionMarker } from "../core/compaction";
import type { AgentEvent, ParsedSession, TokenUsage, UsageRecord } from "../core/types";

/**
 * Codex CLI: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl (and
 * archived_sessions/). Each line is {timestamp, type, payload}.
 *
 * Token usage arrives as cumulative `token_count` events, so each request's
 * usage is the delta between consecutive totals; that also makes repeated
 * token_count events harmless. OpenAI counts cached tokens (reads and writes)
 * inside input_tokens, so they are subtracted to match the schema's `input`.
 *
 * Codex 0.160+ also writes a `token_usage_record` per model response, keyed by
 * `response_id`, just before the token_count with the new total. Records take
 * precedence: a token_count only adds usage when no record arrived since the
 * previous total, and still advances the baseline either way, so a rollout
 * that switches CLI versions midway counts every request once.
 *
 * A forked rollout (or a subagent spawned with its parent's history) starts
 * with a verbatim copy of the parent's lines, its session_meta and
 * token_count events included, and its running total carries on from there.
 * The copied session_meta is ignored and each usage record carries a
 * `requestId` so storage counts the copied requests once.
 */
export const codexAdapter: Adapter = {
  id: "codex",
  label: "Codex",
  roots: (env) => {
    const home = env.CODEX_HOME || path.join(homeDir(env), ".codex");
    return [path.join(home, "sessions"), path.join(home, "archived_sessions")];
  },
  match: (filePath) => path.basename(filePath).startsWith("rollout-") && filePath.endsWith(".jsonl"),
  parse: parseCodex,
  resumeCommand: (s) => {
    if (s.parentNativeId) return undefined;
    // nativeId is the session_meta id; logs without one fall back to the file name, whose suffix is the id.
    const id = s.nativeId.startsWith("rollout-") ? UUID_SUFFIX.exec(s.nativeId)?.[1] : s.nativeId;
    return id ? shellCommand(s.cwd, "codex", "resume", id) : undefined;
  },
};

const UUID_SUFFIX = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const INJECTED = /^\s*(<environment_context>|<user_instructions>|<permissions instructions>|<user_shell_command>|# AGENTS\.md)/;

/** Whether `e` is a compaction marker, so the second record of the same compaction is not logged twice. */
const isCompactionAt = (e: AgentEvent | undefined): boolean => e !== undefined && isCompactionMarker(e.kind, e.text);

const contentText = (content: unknown): string =>
  arr(content)
    .map((b) => {
      const block = obj(b);
      return str(block?.text) ?? (block?.type === "input_image" ? "[image]" : "");
    })
    .filter(Boolean)
    .join("\n");

/** Normalize a function_call_output payload to text plus an error flag. */
const toolOutput = (output: unknown): { text?: string; isError: boolean } => {
  const asObject = obj(output);
  if (asObject) {
    const text = str(asObject.content) ?? stringifyInput(asObject);
    return { text, isError: asObject.success === false };
  }
  const text = str(output);
  if (!text) return { isError: false };
  try {
    const parsed = obj(JSON.parse(text));
    const exitCode = obj(parsed?.metadata)?.exit_code;
    if (parsed && typeof parsed.output === "string") {
      return { text: parsed.output, isError: typeof exitCode === "number" && exitCode !== 0 };
    }
  } catch {
    // Plain-text output.
  }
  return { text, isError: false };
};

interface Totals {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

const NO_TOKENS: Totals = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };

/** A Codex token-usage object (`total_token_usage`, `last_token_usage`, a usage record's `usage`). */
const totalsOf = (u: Record<string, unknown>): Totals => ({
  input: num(u.input_tokens),
  cached: num(u.cached_input_tokens),
  cacheWrite: num(u.cache_write_input_tokens),
  output: num(u.output_tokens),
  reasoning: num(u.reasoning_output_tokens),
});

/** Usage between two snapshots. OpenAI counts cache reads and writes inside input_tokens; the schema's `input` excludes both. */
function usageBetween(from: Totals, to: Totals): TokenUsage {
  const cacheRead = Math.max(0, to.cached - from.cached);
  const cacheWrite = Math.max(0, to.cacheWrite - from.cacheWrite);
  return {
    input: Math.max(0, to.input - from.input - cacheRead - cacheWrite),
    output: Math.max(0, to.output - from.output),
    cacheRead,
    cacheWrite,
    reasoning: Math.max(0, to.reasoning - from.reasoning),
  };
}

const payloadId = (p: Record<string, unknown>): string => createHash("sha1").update(JSON.stringify(p)).digest("hex");

export function parseCodex(filePath: string, content: string): ParsedSession | null {
  let nativeId: string | undefined;
  let parentNativeId: string | undefined;
  let firstPrompt: number | undefined;
  let lastPrompt: number | undefined;
  /** The rollout replays a parent's history (fork, or a subagent spawned with context). */
  let replayed = false;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let agentVersion: string | undefined;
  let startedAt: number | undefined;
  let lastTs = 0;
  let model = "unknown";
  let previous: Totals = NO_TOKENS;
  /** A token_usage_record arrived since the last running total; that total adds nothing new. */
  let coveredByRecord = false;
  /** Usage the last token_count added, in case its token_usage_record follows it. */
  let lastCounted: UsageRecord | undefined;
  const events: AgentEvent[] = [];
  const usage: UsageRecord[] = [];
  const toolNames = new Map<string, string>();

  for (const line of jsonLines(content)) {
    const ts = toMs(line.timestamp) ?? lastTs;
    if (ts > lastTs) lastTs = ts;
    const p = obj(line.payload);
    if (!p) continue;

    if (line.type === "session_meta") {
      // A fork's rollout replays its parent's lines, the parent's session_meta included.
      if (nativeId && str(p.id) && str(p.id) !== nativeId) {
        replayed = true;
        continue;
      }
      nativeId = str(p.id) ?? nativeId;
      cwd = str(p.cwd) ?? cwd;
      agentVersion = str(p.cli_version) ?? agentVersion;
      gitBranch = str(obj(p.git)?.branch) ?? gitBranch;
      startedAt ??= toMs(p.timestamp) ?? ts;
      const spawn = obj(obj(obj(p.source)?.subagent)?.thread_spawn);
      parentNativeId = str(spawn?.parent_thread_id) ?? parentNativeId;
    } else if (line.type === "compacted") {
      // History replaced by a summary; newer CLIs also log a `context_compacted` event for the same compaction.
      if (!isCompactionAt(events.at(-1))) events.push({ ts, kind: "system", text: COMPACTION_TEXT });
    } else if (line.type === "turn_context") {
      model = str(p.model) ?? model;
    } else if (line.type === "response_item") {
      switch (p.type) {
        case "message": {
          const text = contentText(p.content);
          if (!text) break;
          if (p.role === "assistant") {
            events.push({ ts, kind: "assistant", text, model });
          } else if (p.role === "user") {
            const injected = INJECTED.test(text);
            // A subagent's dispatch prompt: its first prompt, or the last one when the parent's history was replayed first.
            if (!injected) {
              firstPrompt ??= events.length;
              lastPrompt = events.length;
            }
            events.push({ ts, kind: injected ? "system" : "user", text });
          } else {
            events.push({ ts, kind: "system", text });
          }
          break;
        }
        case "reasoning": {
          const text = arr(p.summary)
            .map((s) => str(obj(s)?.text) ?? "")
            .filter(Boolean)
            .join("\n");
          if (text) events.push({ ts, kind: "thinking", text, model });
          break;
        }
        case "function_call":
        case "custom_tool_call":
        case "local_shell_call":
        case "web_search_call": {
          const name =
            str(p.name) ?? (p.type === "local_shell_call" ? "shell" : p.type === "web_search_call" ? "web_search" : "tool");
          const id = str(p.call_id) ?? str(p.id);
          if (id) toolNames.set(id, name);
          events.push({ ts, kind: "tool_call", toolName: name, toolCallId: id, toolInput: stringifyInput(p.arguments ?? p.input ?? p.action), model });
          break;
        }
        case "function_call_output":
        case "custom_tool_call_output": {
          const id = str(p.call_id);
          const out = toolOutput(p.output);
          events.push({ ts, kind: "tool_result", toolCallId: id, toolName: id ? toolNames.get(id) : undefined, text: out.text, isError: out.isError });
          break;
        }
      }
    } else if (line.type === "token_usage_record") {
      // Codex >= 0.160: one line per model response, before the token_count carrying the running total.
      const u = obj(p.usage);
      if (!u) continue;
      coveredByRecord = true;
      const record: UsageRecord = { ts, model, usage: usageBetween(NO_TOKENS, totalsOf(u)), requestId: `codex:${str(p.response_id) ?? payloadId(p)}` };
      // Should a token_count come first after all, the record replaces the request it already counted.
      if (lastCounted && lastCounted.usage.input === record.usage.input && lastCounted.usage.output === record.usage.output && lastCounted.usage.cacheRead === record.usage.cacheRead) {
        usage.splice(usage.indexOf(lastCounted), 1);
      }
      lastCounted = undefined;
      usage.push(record);
    } else if (line.type === "event_msg") {
      if (p.type === "token_count") {
        const total = obj(obj(p.info)?.total_token_usage);
        if (!total) continue;
        const current = totalsOf(total);
        const dInput = current.input - previous.input;
        const dOutput = current.output - previous.output;
        if (dInput < 0 || dOutput < 0) {
          // Totals reset (e.g. history was rewritten); restart the baseline.
          previous = current;
          continue;
        }
        if (dInput === 0 && dOutput === 0) continue;
        const between = usageBetween(previous, current);
        previous = current;
        // token_usage_record lines already counted the requests since the last total.
        if (coveredByRecord) {
          coveredByRecord = false;
          continue;
        }
        lastCounted = {
          ts,
          model,
          usage: between,
          // Forks and history-sharing subagents replay the parent's token_count lines verbatim
          // (running totals and rate-limit snapshot included), so the payload identifies the request.
          requestId: `codex:${payloadId(p)}`,
        };
        usage.push(lastCounted);
      } else if (p.type === "error" || p.type === "stream_error") {
        events.push({ ts, kind: "error", text: str(p.message) ?? "Error", isError: true });
      } else if (p.type === "context_compacted") {
        if (!isCompactionAt(events.at(-1))) events.push({ ts, kind: "system", text: COMPACTION_TEXT });
      } else if (p.type === "turn_aborted") {
        events.push({ ts, kind: "system", text: `Turn aborted${str(p.reason) ? `: ${str(p.reason)}` : ""}` });
      }
    }
  }

  if (!nativeId && events.length === 0 && usage.length === 0) return null;
  const firstUser = events.find((e) => e.kind === "user")?.text;
  return {
    source: "codex",
    nativeId: nativeId ?? path.basename(filePath, ".jsonl"),
    parentNativeId,
    dispatchIndex: parentNativeId ? (replayed ? lastPrompt : firstPrompt) : undefined,
    title: titleFrom(firstUser),
    cwd,
    gitBranch,
    agentVersion,
    startedAt: startedAt ?? events[0]?.ts ?? lastTs,
    endedAt: lastTs,
    events,
    usage,
  };
}
