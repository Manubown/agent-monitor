import os from "node:os";
import { fileOps, isWrite } from "../core/activity";
import type { AutoTag } from "../core/autotags";
import { dayEnd, dayStart } from "../core/day";
import { fileKey } from "../core/paths";
import { clip, displayPath } from "./activity";
import type { Db } from "./db";
import { type Filters, listSessions, TREE, where } from "./queries";

/**
 * "What was done on this day": the sessions that were active in one local day, each with that day's share of its
 * work. A session belongs to the day when any event or model request of its tree falls into
 * `[00:00, next 00:00)` local time — the same rule `listSessions` applies to a custom `from`/`to` window, so the
 * panel's count and the sessions list for that window always agree.
 */

/** Listed per session before the rest becomes "+ N more". */
const PROMPTS = 3;
const TOOLS = 4;
const FILES = 6;
/** Characters kept of a prompt. */
const PROMPT_MAX = 200;

export interface DayPrompt {
  /** Event sequence number, for a `?at=<seq>#e-<seq>` link into the timeline. */
  seq: number;
  text: string;
}

export interface DaySession {
  id: string;
  source: string;
  title: string;
  cwd: string | null;
  tags: string[];
  autoTags: AutoTag[];
  /** First and last activity of the tree inside the day. */
  start: number;
  end: number;
  /** Subagent runs of the tree that were active that day. */
  subagents: number;
  /** The session's own prompts that day, in order, at most `PROMPTS`. */
  prompts: DayPrompt[];
  promptCount: number;
  /** Busiest tools of the tree that day, at most `TOOLS`. */
  tools: { tool: string; calls: number }[];
  toolCalls: number;
  /** Files the tree changed that day (display form), at most `FILES`. */
  files: string[];
  fileCount: number;
  requests: number;
  tokens: number;
  cost: number | null;
  costSource: string;
}

export interface DayActivity {
  day: string;
  /** Local day bounds; `to` is exclusive. */
  from: number;
  to: number;
  /** Sessions of the day, most recently active first, at most `limit`. */
  sessions: DaySession[];
  /** Every session of the day under the same filters: what `/sessions` shows for the same window. */
  total: number;
  /** The day's own totals under the filters, not only of the listed sessions. */
  cost: number | null;
  costSource: string;
  tokens: number;
  requests: number;
  prompts: number;
}

interface CostParts {
  sources: number;
  unpriced: number;
  firstSource: string | null;
}

/** Same rule as a session's cost source (src/ingest/sync.ts): any unpriced request makes the sum partial. */
const costSourceOf = (c: CostParts): string => {
  if (c.sources === 0) return "none";
  if (c.unpriced > 0) return c.sources === 1 ? "unpriced" : "partial";
  return c.sources === 1 ? (c.firstSource ?? "none") : "mixed";
};

/** Cost columns of a usage aggregate: the sum plus what `costSourceOf` needs. */
const COST_PARTS = `
  SUM(u.cost_usd) AS cost,
  COUNT(*) AS requests,
  SUM(u.input + u.output + u.cache_read + u.cache_write) AS tokens,
  COUNT(DISTINCT u.cost_source) AS sources,
  SUM(u.cost_source = 'unpriced') AS unpriced,
  MIN(u.cost_source) AS firstSource`;

interface UsageShare extends CostParts {
  root: string;
  cost: number | null;
  requests: number;
  tokens: number;
  first: number;
  last: number;
}

interface DayEvent {
  root: string;
  sessionId: string;
  seq: number;
  ts: number;
  kind: string;
  toolName: string | null;
  toolInput: string | null;
  text: string | null;
}

/** The sessions active on `day` under `f`, with that day's prompts, tools, files, tokens and cost. */
export function dayActivity(db: Db, f: Filters, day: string, limit = 8, home: string = os.homedir()): DayActivity {
  const from = dayStart(day);
  const to = dayEnd(day);
  const scope: Filters = { ...f, from, to };
  const { rows, total } = listSessions(db, scope, { limit, offset: 0 });
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(", ");

  const usage = ids.length
    ? (db
        .prepare(
          `${TREE} SELECT tree.root AS root, ${COST_PARTS}, MIN(u.ts) AS first, MAX(u.ts) AS last
           FROM tree JOIN usage u ON u.session_id = tree.id
           WHERE tree.root IN (${marks}) AND u.ts >= ? AND u.ts < ? GROUP BY tree.root`,
        )
        .all(...ids, from, to) as unknown as UsageShare[])
    : [];
  const byRoot = new Map(usage.map((u) => [u.root, u]));

  const events = ids.length
    ? (db
        .prepare(
          `${TREE} SELECT tree.root AS root, e.session_id AS sessionId, e.seq, e.ts, e.kind, e.tool_name AS toolName,
                  CASE WHEN e.kind = 'tool_call' THEN e.tool_input END AS toolInput,
                  CASE WHEN e.kind = 'user' AND e.session_id = tree.root THEN substr(e.text, 1, ${PROMPT_MAX * 2}) END AS text
           FROM tree JOIN events e ON e.session_id = tree.id
           WHERE tree.root IN (${marks}) AND e.ts >= ? AND e.ts < ? ORDER BY e.ts, e.seq`,
        )
        .all(...ids, from, to) as unknown as DayEvent[])
    : [];
  const agents = ids.length
    ? (db
        .prepare(`${TREE} SELECT tree.id AS id, s.cwd FROM tree JOIN sessions s ON s.id = tree.id WHERE tree.root IN (${marks})`)
        .all(...ids) as unknown as { id: string; cwd: string | null }[])
    : [];
  const cwdOf = new Map(agents.map((r) => [r.id, r.cwd ?? undefined]));

  interface Bucket {
    prompts: DayPrompt[];
    tools: Map<string, number>;
    toolCalls: number;
    files: Set<string>;
    agents: Set<string>;
    first: number;
    last: number;
  }
  const buckets = new Map<string, Bucket>(
    ids.map((id) => [id, { prompts: [], tools: new Map(), toolCalls: 0, files: new Set<string>(), agents: new Set<string>(), first: Infinity, last: -Infinity }]),
  );
  for (const e of events) {
    const b = buckets.get(e.root);
    if (!b) continue;
    b.first = Math.min(b.first, e.ts);
    b.last = Math.max(b.last, e.ts);
    if (e.sessionId !== e.root) b.agents.add(e.sessionId);
    if (e.kind === "user" && e.text !== null) {
      b.prompts.push({ seq: e.seq, text: clip(e.text, PROMPT_MAX) });
    } else if (e.kind === "tool_call") {
      const tool = e.toolName ?? "(unknown)";
      b.tools.set(tool, (b.tools.get(tool) ?? 0) + 1);
      b.toolCalls++;
      for (const op of fileOps(tool, e.toolInput, cwdOf.get(e.sessionId))) {
        if (isWrite(op.op)) b.files.add(fileKey(op.to ?? op.path, home));
      }
    }
  }

  const sessions: DaySession[] = rows.map((s) => {
    const b = buckets.get(s.id);
    const u = byRoot.get(s.id);
    const first = Math.min(b?.first ?? Infinity, u?.first ?? Infinity);
    const last = Math.max(b?.last ?? -Infinity, u?.last ?? -Infinity);
    const tools = [...(b?.tools ?? [])].map(([tool, calls]) => ({ tool, calls })).sort((a, c) => c.calls - a.calls || a.tool.localeCompare(c.tool));
    const files = [...(b?.files ?? [])].map((p) => displayPath(p, s.cwd, home)).sort((a, c) => a.localeCompare(c));
    return {
      id: s.id,
      source: s.source,
      title: clip(s.title || s.nativeId, 80),
      cwd: s.cwd,
      tags: s.tags,
      autoTags: s.autoTags,
      start: Number.isFinite(first) ? first : from,
      end: Number.isFinite(last) ? last : from,
      subagents: b?.agents.size ?? 0,
      prompts: (b?.prompts ?? []).slice(0, PROMPTS),
      promptCount: b?.prompts.length ?? 0,
      tools: tools.slice(0, TOOLS),
      toolCalls: b?.toolCalls ?? 0,
      files: files.slice(0, FILES),
      fileCount: files.length,
      requests: u?.requests ?? 0,
      tokens: u?.tokens ?? 0,
      cost: u?.cost ?? null,
      costSource: u ? costSourceOf(u) : "none",
    };
  });

  const wu = where(scope, "u.ts");
  const totals = db
    .prepare(`SELECT ${COST_PARTS} FROM usage u JOIN sessions s ON s.id = u.session_id ${wu.sql}`)
    .get(...wu.params) as unknown as CostParts & { cost: number | null; requests: number; tokens: number | null };
  const we = where(scope, "e.ts");
  const { prompts } = db
    .prepare(
      `SELECT COUNT(*) AS prompts FROM events e JOIN sessions s ON s.id = e.session_id
       ${we.sql ? `${we.sql} AND` : "WHERE"} e.kind = 'user' AND s.parent_id IS NULL`,
    )
    .get(...we.params) as unknown as { prompts: number };

  return {
    day,
    from,
    to,
    sessions,
    total,
    cost: totals.cost,
    costSource: costSourceOf(totals),
    tokens: totals.tokens ?? 0,
    requests: totals.requests,
    prompts,
  };
}
