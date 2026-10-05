import { syncAll, type SyncResult } from "../../src/ingest/sync";
import { openSearchIndex, type SearchIndex } from "../../src/search/native";
import { type Db, defaultDbPath, openDb, siblingPath } from "../../src/store/db";
import type { Filters } from "../../src/store/queries";

export interface SyncEvent {
  at: number;
  generation: number;
  /** Sessions written by this sync. */
  changed: number;
}

/**
 * Process-wide state lives on globalThis so the instrumentation hook, route
 * handlers and dev-mode hot reloads all share one database handle and never
 * run two syncs at once.
 */
interface State {
  db?: Db;
  index?: SearchIndex;
  running?: Promise<SyncResult>;
  last?: SyncResult & { at: number };
  timer?: NodeJS.Timeout;
  listeners?: Set<(e: SyncEvent) => void>;
}
declare global {
  var __agentMonitor: State | undefined;
}
const state: State = (globalThis.__agentMonitor ??= {});
const listeners = (state.listeners ??= new Set());

export function getDb(): Db {
  state.db ??= openDb();
  return state.db;
}

/** Full-text index; sync keeps it at the database's generation. */
export function getIndex(): SearchIndex {
  state.index ??= openSearchIndex(siblingPath(defaultDbPath(), "search-index"));
  return state.index;
}

export function runSync(full = false): Promise<SyncResult> {
  state.running ??= syncAll(getDb(), { full, index: getIndex() })
    .then((result) => {
      const at = Date.now();
      state.last = { ...result, at };
      for (const listener of listeners) listener({ at, generation: result.generation, changed: result.sessions });
      return result;
    })
    .finally(() => {
      state.running = undefined;
    });
  return state.running;
}

export const lastSync = () => state.last;

/** Subscribe to sync completions (live updates). Returns the unsubscribe function. */
export function onSync(listener: (e: SyncEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Sync on an interval for as long as the server runs. */
export function startBackgroundSync(): void {
  if (state.timer) return;
  const seconds = Number(process.env.AGENT_MONITOR_SYNC_SECONDS) || 5;
  void runSync().catch((error) => console.error("[agent-monitor] sync failed", error));
  state.timer = setInterval(() => {
    void runSync().catch((error) => console.error("[agent-monitor] sync failed", error));
  }, seconds * 1000);
  state.timer.unref();
}

/** Before the first sync finishes the database is empty; wait for it rather than render nothing. */
export async function ready(): Promise<Db> {
  if (!state.last) await runSync();
  return getDb();
}

export type SearchParams = Record<string, string | string[] | undefined>;

export const RANGES = [
  { id: "24h", label: "24 hours", ms: 24 * 3600_000 },
  { id: "7d", label: "7 days", ms: 7 * 86400_000 },
  { id: "30d", label: "30 days", ms: 30 * 86400_000 },
  { id: "90d", label: "90 days", ms: 90 * 86400_000 },
  { id: "all", label: "All time", ms: 0 },
] as const;

export const DEFAULT_RANGE = "30d";

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v) || undefined;

export function filtersFrom(params: SearchParams): Filters & { range: string } {
  const range = RANGES.find((r) => r.id === one(params.range)) ?? RANGES.find((r) => r.id === DEFAULT_RANGE)!;
  return {
    range: range.id,
    from: range.ms ? Date.now() - range.ms : undefined,
    source: one(params.source),
    cwd: one(params.project),
    q: one(params.q),
    tag: one(params.tag),
  };
}
