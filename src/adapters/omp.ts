import path from "node:path";
import { type Adapter, arr, homeDir, jsonParser, type LogParser, num, obj, shellCommand, str, stringifyInput, titleFrom, toMs } from "../core/adapter";
import { COMPACTION_TEXT } from "../core/compaction";
import type { AgentEvent, ParsedSession, UsageRecord } from "../core/types";

/**
 * omp (oh-my-pi): ~/.omp/agent/sessions/<cwd-slug>/<iso>_<id>.jsonl
 * Subagent runs live next to it as <iso>_<id>/<TaskName>.jsonl and point back
 * via `parentSession` in their header. The first line (`title`) is rewritten in
 * place, so files are not strictly append-only.
 */
export const ompAdapter: Adapter = {
  id: "omp",
  label: "omp",
  roots: (env) => [path.join(homeDir(env), ".omp", "agent", "sessions")],
  match: (filePath) => filePath.endsWith(".jsonl"),
  parser: ompParser,
  // `--resume` takes an id prefix or a log path; the path is unambiguous.
  resumeCommand: (s) => (s.parentNativeId ? undefined : shellCommand(s, "omp", "--resume", s.filePath)),
};

/** Session id from an omp log path: "<iso>_<id>.jsonl" -> "<id>". */
const idFromPath = (p: string): string => {
  const base = path.basename(p, ".jsonl");
  const i = base.lastIndexOf("_");
  return i >= 0 ? base.slice(i + 1) : base;
};

/** Text of an omp content value: a string or a list of {type:"text"|"image"} blocks. */
const contentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  return arr(content)
    .map((b) => {
      const block = obj(b);
      if (block?.type === "text") return str(block.text) ?? "";
      if (block?.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
};

export function ompParser(filePath: string): LogParser {
  let nativeId: string | undefined;
  let parentNativeId: string | undefined;
  let agentPrompt: number | undefined;
  let cwd: string | undefined;
  let headerTitle: string | undefined;
  let topTitle: string | undefined;
  let changedTitle: string | undefined;
  let startedAt: number | undefined;
  let lastTs = 0;
  let model = "unknown";
  /** The first human prompt, kept here so a title needs no scan over the events. */
  let firstUser: string | undefined;
  const events: AgentEvent[] = [];
  const usage: UsageRecord[] = [];

  const read = (line: Record<string, unknown>): void => {
    const ts = toMs(line.timestamp) ?? lastTs;
    if (ts > lastTs) lastTs = ts;

    switch (line.type) {
      case "title":
        topTitle = str(line.title);
        break;
      case "title_change":
        changedTitle = str(line.title) ?? changedTitle;
        break;
      case "session": {
        nativeId = str(line.id);
        cwd = str(line.cwd);
        headerTitle = str(line.title);
        startedAt = toMs(line.timestamp);
        const parent = str(line.parentSession);
        if (parent) parentNativeId = idFromPath(parent);
        break;
      }
      case "model_change": {
        const m = str(line.model);
        if (m) model = m.slice(m.lastIndexOf("/") + 1);
        break;
      }
      case "compaction":
        // The agent summarized its history; the next request starts from the summary.
        events.push({ ts, kind: "system", text: COMPACTION_TEXT });
        break;
      case "custom_message": {
        const text = contentText(line.content);
        if (text) events.push({ ts, kind: "system", text });
        break;
      }
      case "message": {
        const message = obj(line.message);
        if (!message) break;
        const role = message.role;
        if (role === "user" || role === "developer") {
          const text = contentText(message.content);
          const human = role === "user" && (message.attribution === undefined || message.attribution === "user");
          // A subagent's first agent-attributed prompt is the assignment its parent sent.
          if (text && role === "user" && !human && agentPrompt === undefined) agentPrompt = events.length;
          if (text) {
            if (human) firstUser ??= text;
            events.push({ ts, kind: human ? "user" : "system", text });
          }
        } else if (role === "assistant") {
          const msgModel = str(message.model) ?? model;
          for (const b of arr(message.content)) {
            const block = obj(b);
            if (!block) continue;
            if (block.type === "text" && str(block.text)) {
              events.push({ ts, kind: "assistant", text: str(block.text), model: msgModel });
            } else if (block.type === "thinking" && str(block.thinking)) {
              events.push({ ts, kind: "thinking", text: str(block.thinking), model: msgModel });
            } else if (block.type === "toolCall") {
              events.push({
                ts,
                kind: "tool_call",
                toolName: str(block.name),
                toolCallId: str(block.id),
                toolInput: stringifyInput(block.arguments),
                model: msgModel,
              });
            }
          }
          const u = obj(message.usage);
          if (u) {
            const cost = obj(u.cost);
            usage.push({
              ts,
              model: msgModel,
              usage: {
                input: num(u.input),
                output: num(u.output),
                cacheRead: num(u.cacheRead),
                cacheWrite: num(u.cacheWrite),
                reasoning: 0,
              },
              cacheWrite1h: num(obj(u.cttl)?.ephemeral1h),
              reportedCostUsd: cost && typeof cost.total === "number" ? cost.total : undefined,
            });
          }
          const errorMessage = str(message.errorMessage);
          if (errorMessage || message.stopReason === "error") {
            events.push({ ts, kind: "error", text: errorMessage ?? "Model request failed", model: msgModel, isError: true });
          }
        } else if (role === "toolResult") {
          events.push({
            ts,
            kind: "tool_result",
            text: contentText(message.content),
            toolName: str(message.toolName),
            toolCallId: str(message.toolCallId),
            isError: message.isError === true,
          });
        }
        break;
      }
    }
  };

  const result = (): ParsedSession | null => {
    if (!nativeId && events.length === 0 && usage.length === 0) return null;
    const subagentName = parentNativeId ? path.basename(filePath, ".jsonl") : undefined;
    return {
      source: "omp",
      nativeId: nativeId ?? idFromPath(filePath),
      parentNativeId,
      dispatchIndex: parentNativeId ? agentPrompt : undefined,
      title: topTitle || changedTitle || headerTitle || subagentName || titleFrom(firstUser),
      cwd,
      startedAt: startedAt ?? events[0]?.ts ?? lastTs,
      endedAt: lastTs,
      events,
      usage,
    };
  };

  return jsonParser(read, result);
}
