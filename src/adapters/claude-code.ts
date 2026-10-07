import path from "node:path";
import { type Adapter, arr, homeDir, jsonParser, type LogParser, num, obj, shellCommand, str, stringifyInput, titleFrom, toMs } from "../core/adapter";
import { COMPACTION_TEXT } from "../core/compaction";
import type { AgentEvent, ParsedSession, UsageRecord } from "../core/types";

/**
 * Claude Code: <config>/projects/<cwd-slug>/<sessionId>.jsonl, with subagent
 * transcripts in <sessionId>/subagents/agent-<id>.jsonl.
 *
 * One API response is written as several lines (one per content block), each
 * repeating the same `message.id` and `usage`, so usage is deduplicated by
 * message id. Forked and resumed sessions copy earlier lines into a new file;
 * `requestId` (message id + request id) lets storage count those once. The log
 * has no cost field; cost is estimated from list prices.
 */
export const claudeCodeAdapter: Adapter = {
  id: "claude-code",
  label: "Claude Code",
  roots: (env) => [path.join(env.CLAUDE_CONFIG_DIR || path.join(homeDir(env), ".claude"), "projects")],
  match: (filePath) => filePath.endsWith(".jsonl"),
  parser: claudeCodeParser,
  resumeCommand: (s) => (s.parentNativeId ? undefined : shellCommand(s, "claude", "--resume", s.nativeId)),
};

const SUBAGENT_PATH = /[\\/]([^\\/]+)[\\/]subagents[\\/](agent-[^\\/]+)\.jsonl$/;

/** User-role text that the harness injected rather than a human typed. */
const INJECTED = /^\s*<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|user-memory-input|task-notification)\b/;

const blockText = (content: unknown): string => {
  if (typeof content === "string") return content;
  return arr(content)
    .map((b) => {
      const block = obj(b);
      if (block?.type === "text") return str(block.text) ?? "";
      if (block?.type === "image") return "[image]";
      if (block?.type === "tool_reference") return `[tool: ${str(block.tool_name) ?? "?"}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
};

export function claudeCodeParser(filePath: string): LogParser {
  const sub = SUBAGENT_PATH.exec(filePath);
  let dispatchIndex: number | undefined;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let agentVersion: string | undefined;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let summary: string | undefined;
  let firstTs: number | undefined;
  // A fork (/branch, --fork-session) starts with copies of the original's lines, marked `forkedFrom`; it started at its first own line.
  let firstOwnTs: number | undefined;
  let lastTs = 0;
  /** The first human prompt and the first injected text, kept here so a title needs no scan over the events. */
  let firstUser: string | undefined;
  let firstSystem: string | undefined;
  const events: AgentEvent[] = [];
  /** Usage by message id: a later line with the same id replaces its record (a new object, in the same place). */
  const usage: UsageRecord[] = [];
  const usageAt = new Map<string, number>();
  const toolNames = new Map<string, string | undefined>();
  const seenBlocks = new Set<string>();

  /** Add one event, keeping what the result needs: a tool result carries only the call id, so the name is copied across. */
  const add = (e: AgentEvent): void => {
    if (e.kind === "user") firstUser ??= e.text;
    else if (e.kind === "system") firstSystem ??= e.text;
    else if (e.kind === "tool_call" && e.toolCallId !== undefined) toolNames.set(e.toolCallId, e.toolName);
    else if (e.kind === "tool_result" && !e.toolName && e.toolCallId !== undefined) e.toolName = toolNames.get(e.toolCallId);
    events.push(e);
  };

  const read = (line: Record<string, unknown>): void => {
    const ts = toMs(line.timestamp);
    if (ts !== undefined) {
      if (firstTs === undefined || ts < firstTs) firstTs = ts;
      if (!obj(line.forkedFrom) && (firstOwnTs === undefined || ts < firstOwnTs)) firstOwnTs = ts;
      if (ts > lastTs) lastTs = ts;
    }
    const at = ts ?? lastTs;
    sessionId ??= str(line.sessionId);
    cwd ??= str(line.cwd);
    if (str(line.gitBranch) && line.gitBranch !== "HEAD") gitBranch = str(line.gitBranch);
    agentVersion = str(line.version) ?? agentVersion;

    switch (line.type) {
      case "custom-title":
        customTitle = str(line.customTitle) ?? customTitle;
        break;
      case "ai-title":
        aiTitle = str(line.aiTitle) ?? aiTitle;
        break;
      case "summary":
        summary = str(line.summary) ?? summary;
        break;
      case "system":
        if (line.level === "error" || line.subtype === "api_error") {
          add({ ts: at, kind: "error", text: str(line.content) ?? "API error", isError: true });
        } else if (line.subtype === "compact_boundary") {
          add({ ts: at, kind: "system", text: COMPACTION_TEXT });
        }
        break;
      case "user": {
        const message = obj(line.message);
        if (!message) break;
        // In subagent (sidechain) transcripts the "user" is the parent agent, not a human.
        const meta = line.isMeta === true || line.isCompactSummary === true || line.isSidechain === true || sub !== null;
        const pushText = (text: string) => {
          if (!text.trim()) return;
          const injected = INJECTED.test(text);
          // A subagent's first real "user" text is the task its parent sent.
          if (sub !== null && dispatchIndex === undefined && line.isMeta !== true && line.isCompactSummary !== true && !injected) dispatchIndex = events.length;
          add({ ts: at, kind: meta || injected ? "system" : "user", text });
        };
        if (typeof message.content === "string") {
          pushText(message.content);
          break;
        }
        for (const b of arr(message.content)) {
          const block = obj(b);
          if (!block) continue;
          if (block.type === "text") pushText(str(block.text) ?? "");
          else if (block.type === "tool_result") {
            add({
              ts: at,
              kind: "tool_result",
              text: blockText(block.content),
              toolCallId: str(block.tool_use_id),
              isError: block.is_error === true,
            });
          }
        }
        break;
      }
      case "assistant": {
        const message = obj(line.message);
        if (!message) break;
        const id = str(message.id) ?? str(line.uuid) ?? `${at}`;
        const model = str(message.model) ?? "unknown";
        if (model === "<synthetic>") {
          const text = blockText(message.content);
          if (text) add({ ts: at, kind: line.isApiErrorMessage ? "error" : "system", text, isError: line.isApiErrorMessage === true });
          break;
        }
        arr(message.content).forEach((b) => {
          const block = obj(b);
          if (!block) return;
          if ((block.type === "tool_use" || block.type === "server_tool_use") && str(block.id)) {
            const key = `tool:${str(block.id)}`;
            if (seenBlocks.has(key)) return;
            seenBlocks.add(key);
            add({ ts: at, kind: "tool_call", toolName: str(block.name), toolCallId: str(block.id), toolInput: stringifyInput(block.input), model });
          } else if (block.type === "text" || block.type === "thinking") {
            const text = str(block.type === "text" ? block.text : block.thinking);
            if (!text) return; // thinking is often omitted (empty) on newer models
            const key = `${id}:${block.type}:${text}`;
            if (seenBlocks.has(key)) return;
            seenBlocks.add(key);
            add({ ts: at, kind: block.type === "text" ? "assistant" : "thinking", text, model });
          } else if (typeof block.type === "string" && block.type.endsWith("_tool_result")) {
            add({ ts: at, kind: "tool_result", toolCallId: str(block.tool_use_id), text: stringifyInput(block.content) });
          }
        });
        const u = obj(message.usage);
        if (u) {
          const seen = usageAt.get(id);
          const previous = seen === undefined ? undefined : usage[seen];
          const record: UsageRecord = {
            ts: previous?.ts ?? at,
            model,
            usage: {
              input: num(u.input_tokens),
              output: num(u.output_tokens),
              cacheRead: num(u.cache_read_input_tokens),
              cacheWrite: num(u.cache_creation_input_tokens),
              reasoning: num(obj(u.output_tokens_details)?.thinking_tokens),
            },
            cacheWrite1h: num(obj(u.cache_creation)?.ephemeral_1h_input_tokens),
            reportedCostUsd: typeof line.costUSD === "number" ? line.costUSD : undefined,
            // Forks (/branch, --fork-session) and resumes copy these lines verbatim into the new transcript.
            requestId: str(message.id) ? `${str(message.id)}:${str(line.requestId) ?? ""}` : undefined,
          };
          if (seen === undefined) {
            usageAt.set(id, usage.length);
            usage.push(record);
          } else usage[seen] = record;
        }
        break;
      }
    }
  };

  const result = (): ParsedSession | null => {
    if (events.length === 0 && usage.length === 0) return null;
    // A subagent has no human prompt; its title is the task the parent gave it.
    const firstPrompt = firstUser ?? (sub ? firstSystem : undefined);
    return {
      source: "claude-code",
      nativeId: sub ? `${sub[1]}/${sub[2]}` : (sessionId ?? path.basename(filePath, ".jsonl")),
      parentNativeId: sub?.[1],
      dispatchIndex,
      title: customTitle || aiTitle || summary || titleFrom(firstPrompt),
      cwd,
      gitBranch,
      agentVersion,
      startedAt: firstOwnTs ?? firstTs ?? lastTs,
      endedAt: lastTs,
      events,
      usage,
    };
  };

  return jsonParser(read, result);
}
