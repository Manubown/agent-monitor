import path from "node:path";
import { type Adapter, arr, homeDir, jsonLines, num, obj, shellCommand, str, stringifyInput, titleFrom, toMs } from "../core/adapter";
import type { AgentEvent, ParsedSession, UsageRecord } from "../core/types";

/**
 * Codex CLI: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl (and
 * archived_sessions/). Each line is {timestamp, type, payload}.
 *
 * Token usage arrives as cumulative `token_count` events, so each request's
 * usage is the delta between consecutive totals; that also makes repeated
 * token_count events harmless. OpenAI counts cached tokens inside
 * input_tokens, so they are subtracted to match the schema's `input`.
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
  output: number;
  reasoning: number;
}

export function parseCodex(filePath: string, content: string): ParsedSession | null {
  let nativeId: string | undefined;
  let parentNativeId: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let agentVersion: string | undefined;
  let startedAt: number | undefined;
  let lastTs = 0;
  let model = "unknown";
  let previous: Totals = { input: 0, cached: 0, output: 0, reasoning: 0 };
  const events: AgentEvent[] = [];
  const usage: UsageRecord[] = [];
  const toolNames = new Map<string, string>();

  for (const line of jsonLines(content)) {
    const ts = toMs(line.timestamp) ?? lastTs;
    if (ts > lastTs) lastTs = ts;
    const p = obj(line.payload);
    if (!p) continue;

    if (line.type === "session_meta") {
      nativeId = str(p.id) ?? nativeId;
      cwd = str(p.cwd) ?? cwd;
      agentVersion = str(p.cli_version) ?? agentVersion;
      gitBranch = str(obj(p.git)?.branch) ?? gitBranch;
      startedAt ??= toMs(p.timestamp) ?? ts;
      const spawn = obj(obj(obj(p.source)?.subagent)?.thread_spawn);
      parentNativeId = str(spawn?.parent_thread_id) ?? parentNativeId;
    } else if (line.type === "turn_context") {
      model = str(p.model) ?? model;
    } else if (line.type === "response_item") {
      switch (p.type) {
        case "message": {
          const text = contentText(p.content);
          if (!text) break;
          if (p.role === "assistant") events.push({ ts, kind: "assistant", text, model });
          else if (p.role === "user") events.push({ ts, kind: INJECTED.test(text) ? "system" : "user", text });
          else events.push({ ts, kind: "system", text });
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
    } else if (line.type === "event_msg") {
      if (p.type === "token_count") {
        const total = obj(obj(p.info)?.total_token_usage);
        if (!total) continue;
        const current: Totals = {
          input: num(total.input_tokens),
          cached: num(total.cached_input_tokens),
          output: num(total.output_tokens),
          reasoning: num(total.reasoning_output_tokens),
        };
        const dInput = current.input - previous.input;
        const dOutput = current.output - previous.output;
        if (dInput < 0 || dOutput < 0) {
          // Totals reset (e.g. history was rewritten); restart the baseline.
          previous = current;
          continue;
        }
        if (dInput === 0 && dOutput === 0) continue;
        const dCached = Math.max(0, current.cached - previous.cached);
        usage.push({
          ts,
          model,
          usage: {
            input: Math.max(0, dInput - dCached),
            output: dOutput,
            cacheRead: dCached,
            cacheWrite: 0,
            reasoning: Math.max(0, current.reasoning - previous.reasoning),
          },
        });
        previous = current;
      } else if (p.type === "error" || p.type === "stream_error") {
        events.push({ ts, kind: "error", text: str(p.message) ?? "Error", isError: true });
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
