/**
 * Stable keys for what the graphs select, hover and focus. A live refresh
 * re-reads the session tree's activity and can insert agents, files and
 * resources anywhere in its arrays, so client state holds these keys and
 * derives indices at render time; a key that no longer resolves is no
 * selection. Keys end up in `data-key` attributes, so they stay printable
 * (newline as the separator: labels and groups are single lines).
 */
import type { ActivityAction, ActivityAgent, ActivityFile, ActivityResource, OpCounts } from "../../../src/store/activity";

type Agents = readonly Pick<ActivityAgent, "id">[];

/** Index of the agent with session id `id`; null when there is none. */
export function agentIndex(agents: Agents, id: string | null | undefined): number | null {
  if (id == null) return null;
  const i = agents.findIndex((a) => a.id === id);
  return i === -1 ? null : i;
}

/** Key of an agent node. */
export const agentKey = (agents: Agents, agent: number): string => `a:${agents[agent].id}`;

/** Key of one tool call: its agent's session id and the call's sequence number. */
export const actionKey = (agents: Agents, a: Pick<ActivityAction, "agent" | "seq">): string => `${agents[a.agent].id}\n${a.seq}`;

/**
 * `raw` made unique: later repeats get an ordinal suffix (`x`, `x\n#2`, ...), so a collision never merges two
 * nodes. A suffixed key that is itself taken (by a raw key or an earlier suffix) moves on to the next ordinal.
 */
export function uniqueKeys(raw: readonly string[]): string[] {
  const used = new Set(raw);
  const next = new Map<string, number>();
  const seen = new Set<string>();
  return raw.map((k) => {
    if (!seen.has(k)) {
      seen.add(k);
      return k;
    }
    let n = next.get(k) ?? 2;
    while (used.has(`${k}\n#${n}`)) n++;
    next.set(k, n + 1);
    const key = `${k}\n#${n}`;
    used.add(key);
    return key;
  });
}

/** Key of a file in the resource map's catalog. */
export const fileNodeKey = (f: Pick<ActivityFile, "path">): string => `file\n${f.path}`;

/**
 * Keys of the resource map's catalog nodes, files first then resources (the catalog's order): a spawned agent by its
 * session id, anything else by kind and its resource key (what `sessionActivity` tells resources apart by; labels are
 * clipped and can repeat).
 */
export function catalogKeys(files: readonly Pick<ActivityFile, "path">[], resources: readonly Pick<ActivityResource, "kind" | "key" | "agent">[], agents: Agents): string[] {
  return uniqueKeys([
    ...files.map(fileNodeKey),
    ...resources.map((r) => (r.kind === "agent" && r.agent !== undefined && agents[r.agent] ? `agent\n#${agents[r.agent].id}` : `${r.kind}\n${r.key}`)),
  ]);
}

/** Index of every key. */
export const indexOf = (keys: readonly string[]): Map<string, number> => new Map(keys.map((k, i) => [k, i]));

/**
 * Keys of the flame graph's model requests, in `requests` order: agent id plus the event a request is anchored to
 * (its time when it has none), with an ordinal for requests sharing one (several requests before the same event).
 * Requests come per agent in time order and new ones are appended, so a request keeps its key across refreshes.
 */
export const requestKeys = (agents: Agents, requests: readonly { agent: number; seq: number | null; ts: number }[]): string[] =>
  uniqueKeys(requests.map((r) => `${agentKey(agents, r.agent)}\nr${r.seq ?? `t${r.ts}`}`));

/** Write, edit, delete and move operations: what makes a file "changed" in every graph. */
export const changes = (c: OpCounts): number => c.writes + c.edits + c.deletes + c.moves;

/** A file (or an agent's use of it) that was changed rather than only read. */
export const isChanged = (c: OpCounts): boolean => changes(c) > 0;

/**
 * Node graph keys: `a:<agent id>`, `f:<path>` (one file), `d:<dir>` (a
 * collapsed directory) and `r:<dir>` (a directory's read-only files, those not
 * `isChanged`; the node graph groups by the same rule).
 */
export const nodeKey = {
  file: (path: string) => `f:${path}`,
  dir: (dir: string) => `d:${dir}`,
  reads: (dir: string) => `r:${dir}`,
};

export type ResolvedSelection = { label: string; actions: number[] } & ({ kind: "agent"; agent: number } | { kind: "files"; files: number[] });

/** What a node graph key stands for in the current data; null when it no longer matches anything. */
export function resolveSelection(
  key: string,
  data: { agents: readonly Pick<ActivityAgent, "id" | "title">[]; actions: readonly Pick<ActivityAction, "agent">[]; files: readonly ActivityFile[] },
): ResolvedSelection | null {
  const kind = key.slice(0, 2);
  const rest = key.slice(2);
  if (kind === "a:") {
    const agent = agentIndex(data.agents, rest);
    if (agent === null) return null;
    const actions = data.actions.flatMap((a, i) => (a.agent === agent ? [i] : []));
    return { kind: "agent", agent, label: data.agents[agent].title, actions };
  }
  const match =
    kind === "f:" ? (f: ActivityFile) => f.path === rest : kind === "d:" ? (f: ActivityFile) => f.dir === rest : kind === "r:" ? (f: ActivityFile) => f.dir === rest && !isChanged(f) : null;
  if (!match) return null;
  const files = data.files.flatMap((f, i) => (match(f) ? [i] : []));
  if (!files.length) return null;
  const label = kind === "f:" ? rest : kind === "d:" ? rest || "./" : `read-only files in ${rest || "./"}`;
  return { kind: "files", files, label, actions: [...new Set(files.flatMap((f) => data.files[f].actions))] };
}
