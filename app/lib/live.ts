/**
 * Live updates, shared by the server (`server.ts`, `/api/live`) and the browser (`LiveRefresh`): the shape of a sync
 * event and the rule that decides whether it changes the page a tab shows. No server imports: this runs in the client.
 */

/** Sessions listed by id in one event; a larger sync sends `sessions: null` ("everything changed") instead. */
export const MAX_LISTED = 200;

/** Problems the top bar shows; null when all is well. */
export interface SyncHealth {
  /** The last sync threw (cleared by the next successful one). */
  syncError: { message: string; at: number } | null;
  /**
   * Why search is unavailable (the addon did not load: until the server restarts) or behind (the last sync could not
   * update the index; a later sync rebuilds it).
   */
  searchError: { message: string; unavailable: boolean } | null;
  /**
   * Stored log files, those deleted by their tool and those that failed to parse (the top bar's "N logs" line). A
   * sync that only adds a failure or a deletion touches no session, so without these no page would notice. Null when
   * the database cannot be read.
   */
  files: { files: number; missing: number; errors: number } | null;
}

export interface SyncEvent {
  at: number;
  /** Database generation after the sync; for a failed sync the generation of the last successful one. */
  generation: number | null;
  /** Sessions written, replaced or deleted by this sync. */
  changed: number;
  /**
   * Those sessions plus every ancestor of each (a subagent's write changes its parent's page, whose tree includes it).
   * Null when more than MAX_LISTED changed: treat every page as affected.
   */
  sessions: string[] | null;
  /** Working directories of the changed sessions; null together with `sessions`. */
  cwds: string[] | null;
  health: SyncHealth;
}

/** What the browser compares to decide whether the top bar's problem list or file counts changed (time stamps excluded). */
export const healthKey = (h: SyncHealth): string =>
  JSON.stringify([
    h.syncError?.message ?? null,
    h.searchError?.message ?? null,
    h.files ? [h.files.files, h.files.missing, h.files.errors] : null,
  ]);

/**
 * The changed-session part of a sync event. `ancestors` returns the ancestor ids of the given sessions (it is only
 * called when the list is short enough to send).
 */
export function changeSummary(
  changed: readonly { id: string; cwd: string | null }[],
  ancestors: (ids: string[]) => string[],
): Pick<SyncEvent, "changed" | "sessions" | "cwds"> {
  if (changed.length > MAX_LISTED) return { changed: changed.length, sessions: null, cwds: null };
  const ids = [...new Set(changed.map((c) => c.id))];
  let up: string[];
  try {
    up = ids.length ? ancestors(ids) : [];
  } catch {
    // Without the tree, a session page cannot tell whether a subagent of it changed.
    return { changed: changed.length, sessions: null, cwds: null };
  }
  return {
    changed: changed.length,
    sessions: [...new Set([...ids, ...up])],
    cwds: [...new Set(changed.flatMap((c) => (c.cwd === null ? [] : [c.cwd])))],
  };
}

/** `decodeURIComponent` that keeps malformed percent-encoding (a hand-edited `%E0%A4%A`) as written instead of throwing. */
export const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Whether a sync changed what the page at `pathname` + `search` shows:
 * - `/sessions/<id>` and its subroutes (graph): only when `<id>` is among the changed sessions or their ancestors,
 *   that is when the session or anything in its subagent tree was written.
 * - `/projects/map?project=<cwd>`: only when a changed session has exactly that working directory (the map reads
 *   the sessions whose `cwd` equals the project).
 * - Everything else (overview, sessions list, usage, errors, projects index, unknown routes) aggregates over all
 *   sessions: any change affects it.
 */
export function affectsPage(pathname: string, search: string, e: Pick<SyncEvent, "changed" | "sessions" | "cwds">): boolean {
  if (e.changed <= 0) return false;
  const session = /^\/sessions\/([^/]+)/.exec(pathname);
  if (session) {
    if (!e.sessions) return true;
    // `location.pathname` keeps the segment percent-encoded (`claude-code%3Aabc`); match either spelling.
    const raw = session[1];
    return e.sessions.includes(raw) || e.sessions.includes(safeDecode(raw));
  }
  if (pathname === "/projects/map" || pathname === "/projects/map/") {
    const project = new URLSearchParams(search).get("project");
    if (!project || !e.cwds) return true;
    return e.cwds.includes(project);
  }
  return true;
}

/** What a tab knows about the data it shows. `LiveRefresh` keeps one and feeds every live signal through `liveStep`. */
export interface LiveView {
  /** The latest generation the tab has accounted for: rendered, or judged irrelevant to the page. */
  generation: number | null;
  /** `healthKey` of the top bar the tab shows (or has already asked to refresh). */
  health: string;
  /**
   * A sync since the last `router.refresh()` changed data but not the page shown at the time. Other routes' payloads in
   * the client router cache (what Back and Forward restore) may then predate it, and a navigation in flight may have
   * been judged against the old URL: the next URL change refreshes once. `router.refresh()` drops that cache.
   */
  skipped: boolean;
}

export type LiveSignal =
  /** The stream (re)connected; syncs may have landed while the tab was hidden or disconnected. */
  | { kind: "hello"; generation: number | null; health?: SyncHealth }
  | { kind: "sync"; event: Partial<SyncEvent>; pathname: string; search: string }
  /** The URL changed: a link, a search-param change, Back or Forward. */
  | { kind: "navigated" };

/**
 * The next view and whether to refresh the page. The caller clears `skipped` once it actually calls
 * `router.refresh()` (which may be throttled or wait for the tab to become visible).
 */
export function liveStep(view: LiveView, signal: LiveSignal): { view: LiveView; refresh: boolean } {
  if (signal.kind === "navigated") return { view, refresh: view.skipped };
  const health = signal.kind === "hello" ? signal.health : signal.event.health;
  const key = health ? healthKey(health) : view.health;
  const healthChanged = key !== view.health;
  if (signal.kind === "hello") {
    // What the missed syncs changed is unknown: refresh whatever the page.
    const missed = signal.generation !== view.generation;
    return { view: { ...view, generation: signal.generation, health: key }, refresh: healthChanged || missed };
  }
  const e = signal.event;
  const generation = e.generation ?? view.generation;
  const change = { changed: e.changed ?? 0, sessions: e.sessions ?? null, cwds: e.cwds ?? null };
  const affected = affectsPage(signal.pathname, signal.search, change);
  const skipped = view.skipped || (change.changed > 0 && !affected);
  return { view: { generation, health: key, skipped }, refresh: healthChanged || affected };
}

/**
 * When a `sync` event's sync finished, if it succeeded; null for a failed one (its `at` is when it failed, and the
 * failure stays in `health` until a sync succeeds). A `hello` event's `at` is always the last successful sync.
 */
export function syncedAt(e: Partial<Pick<SyncEvent, "at" | "health">>): number | null {
  if (typeof e.at !== "number" || !e.health || e.health.syncError) return null;
  return e.at;
}
