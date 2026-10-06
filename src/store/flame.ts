import type { SessionActivity } from "./activity";
import type { Db } from "./db";

/**
 * What the flame view needs on top of `sessionActivity`: each agent's own cost
 * and tokens, when each tool call's result came back, and every model request
 * of the tree with its cost. Arrays are aligned with the activity's `agents`
 * and `actions`; requests reference agents by index.
 */

export interface FlameAgentCost {
  /** The agent's own cost (subagents excluded); null when nothing could be priced. */
  cost: number | null;
  costSource: string;
  tokens: number;
  requests: number;
}

export interface FlameRequest {
  /** Index in the activity's `agents`. */
  agent: number;
  ts: number;
  model: string;
  /** Null when the request could not be priced. */
  cost: number | null;
  costSource: string;
  tokens: number;
  /** First event of the agent at or after the request, for a deep link; null when there is none. */
  seq: number | null;
}

export interface SessionFlame {
  costs: FlameAgentCost[];
  /** Per action: time of its tool result, null when no result was recorded. */
  results: (number | null)[];
  /** Grouped by agent, each agent's in time order. */
  requests: FlameRequest[];
}

interface CostRow {
  id: string;
  cost: number | null;
  costSource: string;
  tokens: number;
  requests: number;
}

interface EventRow {
  sessionId: string;
  seq: number;
  ts: number;
  kind: string;
  toolName: string | null;
  toolCallId: string | null;
}

interface UsageRow {
  sessionId: string;
  ts: number;
  model: string;
  tokens: number;
  cost: number | null;
  costSource: string;
}

export function sessionFlame(db: Db, activity: SessionActivity): SessionFlame {
  const ids = JSON.stringify(activity.agents.map((a) => a.id));
  const agentIndex = new Map(activity.agents.map((a, i) => [a.id, i]));

  const costs: FlameAgentCost[] = activity.agents.map(() => ({ cost: null, costSource: "none", tokens: 0, requests: 0 }));
  const costRows = db
    .prepare(
      `SELECT s.id, s.cost_usd AS cost, s.cost_source AS costSource, s.requests,
              s.input_tokens + s.output_tokens + s.cache_read_tokens + s.cache_write_tokens AS tokens
       FROM json_each(?) j JOIN sessions s ON s.id = j.value`,
    )
    .all(ids) as unknown as CostRow[];
  for (const r of costRows) {
    const i = agentIndex.get(r.id);
    if (i !== undefined) costs[i] = { cost: r.cost, costSource: r.costSource, tokens: r.tokens, requests: r.requests };
  }

  // Action index by (agent, seq), to put each result's time on its call.
  const actionAt = new Map<string, number>();
  activity.actions.forEach((a, i) => actionAt.set(`${a.agent}:${a.seq}`, i));
  const results: (number | null)[] = activity.actions.map(() => null);

  /** Per agent: (seq, ts) of every event, to anchor requests to the timeline. */
  const eventsOf: { seq: number; ts: number }[][] = activity.agents.map(() => []);
  const events = db
    .prepare(
      `SELECT e.session_id AS sessionId, e.seq, e.ts, e.kind, e.tool_name AS toolName, e.tool_call_id AS toolCallId
       FROM json_each(?) j JOIN events e ON e.session_id = j.value
       ORDER BY e.session_id, e.seq`,
    )
    .all(ids) as unknown as EventRow[];
  let current = "";
  let agent = 0;
  let pending = new Map<string, number>();
  let lastCall = new Map<string, number>();
  for (const e of events) {
    if (e.sessionId !== current) {
      current = e.sessionId;
      agent = agentIndex.get(current) ?? 0;
      pending = new Map();
      lastCall = new Map();
    }
    eventsOf[agent].push({ seq: e.seq, ts: e.ts });
    if (e.kind === "tool_call") {
      const index = actionAt.get(`${agent}:${e.seq}`);
      if (index === undefined) continue;
      if (e.toolCallId) pending.set(e.toolCallId, index);
      lastCall.set(e.toolName ?? "tool", index);
    } else if (e.kind === "tool_result") {
      // Same pairing as sessionActivity: by call id, else the latest call of the same tool.
      const index = e.toolCallId ? pending.get(e.toolCallId) : e.toolName ? lastCall.get(e.toolName) : undefined;
      if (index !== undefined && results[index] === null) results[index] = e.ts;
      if (e.toolCallId) pending.delete(e.toolCallId);
    }
  }

  const usage = db
    .prepare(
      `SELECT u.session_id AS sessionId, u.ts, u.model, u.input + u.output + u.cache_read + u.cache_write AS tokens,
              u.cost_usd AS cost, u.cost_source AS costSource
       FROM json_each(?) j JOIN usage u ON u.session_id = j.value
       ORDER BY u.session_id, u.ts, u.seq`,
    )
    .all(ids) as unknown as UsageRow[];
  const requests: FlameRequest[] = [];
  let cursor = 0;
  current = "";
  for (const u of usage) {
    const index = agentIndex.get(u.sessionId);
    if (index === undefined) continue;
    if (u.sessionId !== current) {
      current = u.sessionId;
      cursor = 0;
    }
    // Requests come in time order, so the anchor only moves forward.
    const evs = eventsOf[index];
    while (cursor < evs.length && evs[cursor].ts < u.ts) cursor++;
    requests.push({
      agent: index,
      ts: u.ts,
      model: u.model,
      cost: u.cost,
      costSource: u.costSource,
      tokens: u.tokens,
      seq: evs[cursor]?.seq ?? null,
    });
  }

  return { costs, results, requests };
}
