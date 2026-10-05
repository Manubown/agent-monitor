/**
 * The normalized schema every adapter produces. This is the stable interface of
 * the whole tool: storage, CLI and UI only ever see these shapes, never a
 * tool-specific log format.
 */

/** Token counts for one model request. `input` excludes cached tokens. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Subset of `output` spent on reasoning/thinking, when the tool reports it. Never added to totals. */
  reasoning: number;
}

export type EventKind =
  | "user" // a prompt typed by a human
  | "assistant" // visible model text
  | "thinking" // model reasoning text (when the tool records it)
  | "tool_call"
  | "tool_result"
  | "system" // injected context, reminders, compaction summaries, slash-command output
  | "error";

/** One entry on a session's timeline. */
export interface AgentEvent {
  /** Epoch milliseconds. */
  ts: number;
  kind: EventKind;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  /** Tool arguments, JSON-encoded. */
  toolInput?: string;
  isError?: boolean;
  model?: string;
}

/** One billed model request. */
export interface UsageRecord {
  ts: number;
  model: string;
  usage: TokenUsage;
  /** Of `usage.cacheWrite`, how many tokens were written with a 1h TTL (priced higher than 5m). */
  cacheWrite1h?: number;
  /** Cost as recorded by the tool itself, if it records one. Takes precedence over estimates. */
  reportedCostUsd?: number;
}

export interface ParsedSession {
  /** Adapter id, e.g. "omp", "claude-code", "codex". */
  source: string;
  /** The tool's own session id; unique within `source`. */
  nativeId: string;
  /** Native id of the session that spawned this one (subagents). */
  parentNativeId?: string;
  title?: string;
  cwd?: string;
  gitBranch?: string;
  /** Version of the agent CLI that wrote the log. */
  agentVersion?: string;
  startedAt: number;
  endedAt: number;
  events: AgentEvent[];
  usage: UsageRecord[];
}

export const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });

export const totalTokens = (u: TokenUsage): number => u.input + u.output + u.cacheRead + u.cacheWrite;
