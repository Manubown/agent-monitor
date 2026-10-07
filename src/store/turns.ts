import { fileOps, isWrite } from "../core/activity";
import { IDLE_GAP_MS } from "../core/autotags";
import { COMPACTION_TEXT, type Compaction, detectCompactions } from "../core/compaction";
import { type ActionCategory, categorize, clip } from "./activity";
import type { Db } from "./db";
import { SUBTREE } from "./tree";

/**
 * Per-prompt and per-request views of a session tree (the session plus every
 * subagent, recursively). A turn runs from one prompt of the session to the
 * next; everything in the tree is attributed to turns by timestamp, so a
 * subagent's work lands in the turn that was running when it happened.
 */

interface AgentRow {
  id: string;
  parentId: string | null;
  title: string | null;
  nativeId: string;
  cwd: string | null;
  startedAt: number;
  depth: number;
}

/** Agents of the tree, depth-first: the session first, every agent right after its spawner, siblings by start time. */
function treeAgents(db: Db, sessionId: string): AgentRow[] {
  const rows = db
    .prepare(
      `${SUBTREE} SELECT s.id, s.parent_id AS parentId, s.title, s.native_id AS nativeId, s.cwd, s.started_at AS startedAt, tree.depth
       FROM tree JOIN sessions s ON s.id = tree.id`,
    )
    .all(sessionId) as unknown as AgentRow[];
  const root = rows.find((r) => r.id === sessionId);
  if (!root) return [];
  const byParent = new Map<string, AgentRow[]>();
  for (const r of rows) {
    if (r.id === sessionId || !r.parentId) continue;
    byParent.set(r.parentId, [...(byParent.get(r.parentId) ?? []), r]);
  }
  const out: AgentRow[] = [];
  const visit = (r: AgentRow) => {
    out.push(r);
    for (const k of (byParent.get(r.id) ?? []).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))) visit(k);
  };
  visit(root);
  return out;
}

/** Same rule as a session's cost source (src/ingest/sync.ts): any unpriced request makes the sum partial. */
function costSourceOf(sources: Set<string>): string {
  if (sources.size === 0) return "none";
  if (sources.has("unpriced")) return sources.size === 1 ? "unpriced" : "partial";
  if (sources.size === 1) return [...sources][0];
  return "mixed";
}

// ---------- turns ----------

/** Characters of the prompt text kept for the preview. */
const PROMPT_MAX = 240;

export interface Turn {
  /** 1-based prompt number; 0 for work without a prompt (before the first one, or a session that has none). */
  n: number;
  /** The prompt that started the turn; null for work without a prompt. */
  prompt: { seq: number; text: string } | null;
  start: number;
  /** Last activity in the turn. */
  end: number;
  /** Time spent working: pauses longer than IDLE_GAP_MS count only while a tool or subagent was running. */
  activeMs: number;
  requests: number;
  tokens: number;
  output: number;
  cost: number | null;
  costSource: string;
  toolCalls: number;
  tools: Record<ActionCategory, number>;
  /** Tool calls whose result failed. */
  failedTools: number;
  /** Error events (failed model requests). */
  errors: number;
  /** Distinct files written, edited, deleted or moved. */
  filesChanged: number;
  /** Subagent runs (any depth) that started in the turn. */
  subagents: number;
}

interface PromptRow {
  seq: number;
  ts: number;
  text: string | null;
}

interface TreeEvent {
  sessionId: string;
  ts: number;
  kind: string;
  toolName: string | null;
  toolInput: string | null;
  isError: number;
}

interface UsageRow {
  ts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number | null;
  costSource: string;
}

/** Whether a call reads a URL rather than a file; such reads count as web. */
function readsUrl(input: string | null): boolean {
  if (!input) return false;
  try {
    const args = JSON.parse(input) as Record<string, unknown> | null;
    const target = [args?.path, args?.file_path, args?.url].find((v) => typeof v === "string" && v.trim());
    return typeof target === "string" && /^https?:\/\//.test(target);
  } catch {
    return false;
  }
}

/** The session's turns in order. Empty when the session does not exist or nothing happened in its tree. */
export function sessionTurns(db: Db, sessionId: string): Turn[] {
  const agents = treeAgents(db, sessionId);
  if (!agents.length) return [];
  const cwdOf = new Map(agents.map((a) => [a.id, a.cwd ?? undefined]));

  const prompts = db
    .prepare(`SELECT seq, ts, substr(text, 1, ${PROMPT_MAX * 2}) AS text FROM events WHERE session_id = ? AND kind = 'user' ORDER BY seq`)
    .all(sessionId) as unknown as PromptRow[];
  const events = db
    .prepare(
      `${SUBTREE} SELECT e.session_id AS sessionId, e.ts, e.kind, e.tool_name AS toolName,
              CASE WHEN e.kind = 'tool_call' THEN e.tool_input END AS toolInput, e.is_error AS isError
       FROM tree JOIN events e ON e.session_id = tree.id ORDER BY e.ts, e.session_id, e.seq`,
    )
    .all(sessionId) as unknown as TreeEvent[];
  const usage = db
    .prepare(
      `${SUBTREE} SELECT u.ts, u.input, u.output, u.cache_read AS cacheRead, u.cache_write AS cacheWrite, u.cost_usd AS cost, u.cost_source AS costSource
       FROM tree JOIN usage u ON u.session_id = tree.id ORDER BY u.ts`,
    )
    .all(sessionId) as unknown as UsageRow[];

  // Slot 0 holds work before the first prompt (or all work when there is none); slot i the turn of prompt i.
  const starts: number[] = [];
  for (const p of prompts) starts.push(Math.max(p.ts, starts.at(-1) ?? p.ts));
  const slotOf = (ts: number): number => {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const firstTs = Math.min(events[0]?.ts ?? Infinity, usage[0]?.ts ?? Infinity);
  const turns: Turn[] = [null, ...prompts].map((p, i) => ({
    n: i,
    prompt: p ? { seq: p.seq, text: clip(p.text ?? "", PROMPT_MAX) } : null,
    start: p ? starts[i - 1] : Number.isFinite(firstTs) ? firstTs : 0,
    end: p ? starts[i - 1] : Number.isFinite(firstTs) ? firstTs : 0,
    activeMs: 0,
    requests: 0,
    tokens: 0,
    output: 0,
    cost: null,
    costSource: "none",
    toolCalls: 0,
    tools: { read: 0, write: 0, search: 0, shell: 0, web: 0, agent: 0, other: 0 },
    failedTools: 0,
    errors: 0,
    filesChanged: 0,
    subagents: 0,
  }));
  const changed = turns.map(() => new Set<string>());
  const costSources = turns.map(() => new Set<string>());
  /** Whether slot 0 holds anything worth a row besides injected context. */
  let before = false;

  for (const e of events) {
    const slot = slotOf(e.ts);
    const t = turns[slot];
    // Active time, as in the `long` auto tag: long pauses are idle unless they end with a tool result.
    const gap = e.ts - t.end;
    if (gap > 0 && (gap <= IDLE_GAP_MS || e.kind === "tool_result")) t.activeMs += gap;
    t.end = Math.max(t.end, e.ts);
    if (slot === 0 && e.kind !== "system") before = true;
    if (e.kind === "tool_call") {
      const tool = e.toolName ?? "tool";
      const ops = fileOps(tool, e.toolInput, cwdOf.get(e.sessionId));
      t.tools[categorize(tool, ops, readsUrl(e.toolInput))]++;
      t.toolCalls++;
      for (const op of ops) if (isWrite(op.op)) changed[slot].add((op.to ?? op.path).normalize("NFC"));
    } else if (e.kind === "tool_result" && e.isError) {
      t.failedTools++;
    } else if (e.kind === "error") {
      t.errors++;
    }
  }
  for (const u of usage) {
    const slot = slotOf(u.ts);
    const t = turns[slot];
    t.requests++;
    t.tokens += u.input + u.output + u.cacheRead + u.cacheWrite;
    t.output += u.output;
    if (u.cost !== null) t.cost = (t.cost ?? 0) + u.cost;
    costSources[slot].add(u.costSource);
    t.end = Math.max(t.end, u.ts);
    if (slot === 0) before = true;
  }
  for (const a of agents) {
    if (a.depth === 0) continue;
    const slot = slotOf(a.startedAt);
    turns[slot].subagents++;
    if (slot === 0) before = true;
  }
  turns.forEach((t, i) => {
    t.filesChanged = changed[i].size;
    t.costSource = costSourceOf(costSources[i]);
  });
  // Without prompts the whole run is one implicit turn; otherwise slot 0 only shows when work preceded the first prompt.
  if (!prompts.length) return before || events.length ? turns : [];
  return before ? turns : turns.slice(1);
}

// ---------- context per request ----------

/** Characters of the prompt shown with a request in the context chart's tooltip. */
const CONTEXT_PROMPT_MAX = 120;

export interface ContextPoint {
  ts: number;
  /**
   * Sequence number of the agent's event closest to the request (the last one at or before it), so a request links
   * into the timeline with `?at=<seq>#e-<seq>`. Null for an agent that has usage rows but no events.
   */
  seq: number | null;
  /** The prompt the agent was working on: its last user message before the request, clipped. Null before the first. */
  prompt: string | null;
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cost: number | null;
  costSource: string;
}

export interface ContextAgent {
  id: string;
  title: string;
  /** Nesting level below the session (0 = the session). */
  depth: number;
  requests: ContextPoint[];
  compactions: Compaction[];
}

interface ContextUsageRow extends Omit<ContextPoint, "seq" | "prompt"> {
  sessionId: string;
}

/** An agent's events in time order; `prompt` is set on its user messages only. */
interface ContextEventRow {
  sessionId: string;
  seq: number;
  ts: number;
  prompt: string | null;
}

/**
 * Walks an agent's requests and its events together (both in time order) and marks each request with the event it
 * followed and the prompt that was running. A request before the first event keeps that event's seq, so its link
 * still lands at the top of the timeline.
 */
function attachEvents(requests: ContextPoint[], events: ContextEventRow[]): void {
  let i = 0;
  let seq: number | null = null;
  let prompt: string | null = null;
  for (const r of requests) {
    while (i < events.length && events[i].ts <= r.ts) {
      seq = events[i].seq;
      if (events[i].prompt !== null) prompt = clip(events[i].prompt ?? "", CONTEXT_PROMPT_MAX);
      i++;
    }
    r.seq = seq ?? events[0]?.seq ?? null;
    r.prompt = prompt;
  }
}

/** Model requests and compaction boundaries of every agent in the tree with at least one request, the session first. */
export function sessionContext(db: Db, sessionId: string): ContextAgent[] {
  const agents = treeAgents(db, sessionId);
  if (!agents.length) return [];
  const requests = new Map<string, ContextPoint[]>();
  const rows = db
    .prepare(
      `${SUBTREE} SELECT u.session_id AS sessionId, u.ts, u.model, u.input, u.cache_read AS cacheRead, u.cache_write AS cacheWrite,
              u.output, u.cost_usd AS cost, u.cost_source AS costSource
       FROM tree JOIN usage u ON u.session_id = tree.id ORDER BY u.session_id, u.ts, u.seq`,
    )
    .all(sessionId) as unknown as ContextUsageRow[];
  for (const { sessionId: id, ts, model, input, cacheRead, cacheWrite, output, cost, costSource } of rows) {
    const list = requests.get(id);
    const point: ContextPoint = { ts, seq: null, prompt: null, model, input, cacheRead, cacheWrite, output, cost, costSource };
    if (list) list.push(point);
    else requests.set(id, [point]);
  }
  const timeline = new Map<string, ContextEventRow[]>();
  const events = db
    .prepare(
      `${SUBTREE} SELECT e.session_id AS sessionId, e.seq, e.ts,
              CASE WHEN e.kind = 'user' THEN substr(e.text, 1, ${CONTEXT_PROMPT_MAX * 2}) END AS prompt
       FROM tree JOIN events e ON e.session_id = tree.id ORDER BY e.session_id, e.ts, e.seq`,
    )
    .all(sessionId) as unknown as ContextEventRow[];
  for (const e of events) {
    const list = timeline.get(e.sessionId);
    if (list) list.push(e);
    else timeline.set(e.sessionId, [e]);
  }
  for (const [id, list] of requests) attachEvents(list, timeline.get(id) ?? []);

  const markers = new Map<string, number[]>();
  const marks = db
    .prepare(
      `${SUBTREE} SELECT e.session_id AS sessionId, e.ts FROM tree JOIN events e ON e.session_id = tree.id
       WHERE e.kind = 'system' AND substr(e.text, 1, ${COMPACTION_TEXT.length}) = ?`,
    )
    .all(sessionId, COMPACTION_TEXT) as unknown as { sessionId: string; ts: number }[];
  for (const m of marks) markers.set(m.sessionId, [...(markers.get(m.sessionId) ?? []), m.ts]);

  return agents
    .filter((a) => requests.has(a.id))
    .map((a) => {
      const list = requests.get(a.id) ?? [];
      const ctx = list.map((r) => ({ ts: r.ts, model: r.model, context: r.input + r.cacheRead + r.cacheWrite }));
      return { id: a.id, title: clip(a.title || a.nativeId), depth: a.depth, requests: list, compactions: detectCompactions(ctx, markers.get(a.id) ?? []) };
    });
}
