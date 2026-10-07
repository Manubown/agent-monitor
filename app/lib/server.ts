import { dayEnd, dayStart } from "../../src/core/day";
import { syncAll, type SyncResult } from "../../src/ingest/sync";
import { openSearchIndex, type SearchIndex } from "../../src/search/native";
import { type Db, defaultDbPath, openDb, siblingPath } from "../../src/store/db";
import type { Filters } from "../../src/store/queries";
import { changeSummary, type SyncEvent, type SyncHealth } from "./live";
import { dayParam, first } from "./params";

export type { SyncEvent, SyncHealth } from "./live";

/**
 * Process-wide state lives on globalThis so the instrumentation hook, route
 * handlers and dev-mode hot reloads all share one database handle and never
 * run two syncs at once.
 */
interface State {
  db?: Db;
  index?: SearchIndex;
  /** Why the search addon could not be loaded; set and logged once, then the index stays unavailable for this process. */
  indexError?: string;
  running?: Promise<SyncResult>;
  last?: SyncResult & { at: number };
  /** The last sync threw; cleared by the next successful one. */
  failure?: { message: string; at: number };
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

/** The search index, or the reason it is unavailable; everything except search works without it. */
export type IndexState = { ok: true; index: SearchIndex } | { ok: false; error: string };

/**
 * Full-text index; sync keeps it at the database's generation. The native addon
 * may be missing (never built) or fail to load (other platform, missing system
 * library): that is reported once and then remembered, so the dashboard keeps
 * working and only search answers 503.
 */
export function getIndex(): IndexState {
  if (state.index) return { ok: true, index: state.index };
  if (state.indexError) return { ok: false, error: state.indexError };
  try {
    state.index = openSearchIndex(siblingPath(defaultDbPath(), "search-index"));
    return { ok: true, index: state.index };
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
    // The "not built" message already names the fix; a load failure (other platform, missing library) needs it too.
    const fix = reason.includes("pnpm build:native") ? "" : " Run `pnpm build:native`.";
    state.indexError = `Search is unavailable: ${reason}.${fix} Restart the server afterwards.`;
    console.error(`[agent-monitor] ${state.indexError}`);
    return { ok: false, error: state.indexError };
  }
}

/** Never throws synchronously: `startBackgroundSync` and `ready()` must always get a promise to attach to. */
export function runSync(full = false): Promise<SyncResult> {
  state.running ??= Promise.resolve()
    .then(() => {
      const index = getIndex();
      return syncAll(getDb(), { full, index: index.ok ? index.index : undefined });
    })
    .then(
      (result) => {
        const at = Date.now();
        state.last = { ...result, at };
        state.failure = undefined;
        emit({ at, generation: result.generation, ...changeSummary(result.changed, ancestorIds), health: syncHealth() });
        return result;
      },
      (error: unknown) => {
        const at = Date.now();
        state.failure = { message: error instanceof Error ? error.message : String(error), at };
        emit({ at, generation: state.last?.generation ?? null, changed: 0, sessions: [], cwds: [], health: syncHealth() });
        throw error;
      },
    )
    .finally(() => {
      state.running = undefined;
    });
  return state.running;
}

function emit(e: SyncEvent): void {
  for (const listener of listeners) {
    try {
      listener(e);
    } catch (error) {
      console.error("[agent-monitor] live listener failed", error);
    }
  }
}

/** Every ancestor of the given sessions (parent, grandparent, …), so a subagent's write refreshes the pages of its tree. */
function ancestorIds(ids: string[]): string[] {
  const rows = getDb()
    .prepare(
      `WITH RECURSIVE up(id, depth) AS (
         SELECT s.parent_id, 1 FROM sessions s WHERE s.id IN (SELECT value FROM json_each(?)) AND s.parent_id IS NOT NULL
         UNION ALL
         SELECT s.parent_id, up.depth + 1 FROM sessions s JOIN up ON s.id = up.id WHERE s.parent_id IS NOT NULL AND up.depth < 64)
       SELECT DISTINCT id FROM up`,
    )
    .all(JSON.stringify(ids)) as { id: string }[];
  return rows.map((r) => r.id);
}

export const lastSync = () => state.last;

/** Whether a sync is in progress right now. */
export const syncRunning = (): boolean => state.running !== undefined;

/**
 * What the top bar reports: a failed last sync, why search is unavailable or behind, and the file counts (computed
 * once per sync for the live event, so one aggregate query).
 */
export function syncHealth(): SyncHealth {
  const indexUpdate = state.last?.indexError;
  return {
    files: fileCounts(),
    syncError: state.failure ? { ...state.failure } : null,
    searchError: state.indexError
      ? { message: state.indexError, unavailable: true }
      : indexUpdate
        ? { message: `The search index could not be updated: ${indexUpdate.replace(/\.$/, "")}. A later sync rebuilds it.`, unavailable: false }
        : null,
  };
}

/** Stored, deleted (by their tool) and failed log files, as `syncStatus` counts them; null when the database is unavailable. */
function fileCounts(): SyncHealth["files"] {
  try {
    const r = getDb()
      .prepare("SELECT COUNT(*) AS files, COALESCE(SUM(missing), 0) AS missing, COUNT(error) AS errors FROM files")
      .get() as { files: number; missing: number; errors: number };
    return { files: r.files, missing: r.missing, errors: r.errors };
  } catch {
    return null;
  }
}

/** Log files stored so far: the import progress shown while the first sync runs. Null when the database is unavailable. */
export function storedFiles(): number | null {
  try {
    return (getDb().prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n;
  } catch {
    return null;
  }
}

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

/** A page's filters: the time scope is `range`, or the custom local days in `days` when the URL carries them. */
export interface PageFilters extends Filters {
  range: string;
  /** Custom `from`/`to` days as written in the URL, both inclusive; present when either one is valid. */
  days?: { from?: string; to?: string };
}

/**
 * The filters of a page from its query. `from`/`to` are local calendar days (inclusive, `to` ends at the next
 * midnight) and replace the range window entirely; `to` before `from` is ignored, as is any day that is not a real
 * date, so a hand-edited URL falls back to the range.
 */
export function filtersFrom(params: SearchParams): PageFilters {
  const range = RANGES.find((r) => r.id === first(params.range)) ?? RANGES.find((r) => r.id === DEFAULT_RANGE)!;
  const fromDay = dayParam(params.from);
  const toDay = dayParam(params.to);
  const ordered = fromDay === undefined || toDay === undefined || toDay >= fromDay;
  const days = ordered && (fromDay !== undefined || toDay !== undefined) ? { from: fromDay, to: toDay } : undefined;
  return {
    range: range.id,
    ...(days ? { days } : {}),
    from: days ? (days.from === undefined ? undefined : dayStart(days.from)) : range.ms ? Date.now() - range.ms : undefined,
    to: days?.to === undefined ? undefined : dayEnd(days.to),
    source: first(params.source),
    cwd: first(params.project),
    q: first(params.q),
    tag: first(params.tag),
  };
}

/**
 * The page's filters as URL parameters again, the inverse of `filtersFrom`: what every link below the filter bar has
 * to carry so the next page shows the same scope. Pages add their own keys (`sort`, `page`) to it.
 */
export function queryOf(f: PageFilters): Record<string, string | undefined> {
  return { range: f.range, source: f.source, project: f.cwd, q: f.q, tag: f.tag, from: f.days?.from, to: f.days?.to };
}
