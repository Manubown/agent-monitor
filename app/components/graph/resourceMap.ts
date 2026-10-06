/**
 * Pure parts of the resource map (`/sessions/[id]/graph`): the filter state
 * kept in the URL, which calls pass it, and the inverse of the compressed
 * time axis for the range brush. Shared by the page, the client component
 * and tests.
 */
import type { ActivityAction, ResourceKind } from "../../../src/store/activity";
import type { TimeScale } from "./timeScale";

export const MAP_KINDS = ["files", "shell", "web", "search", "agents", "tools"] as const;
export type MapKind = (typeof MAP_KINDS)[number];

export const MAP_KIND_LABEL: Record<MapKind, string> = {
  files: "Files",
  shell: "Shell",
  web: "Web",
  search: "Search",
  agents: "Subagents",
  tools: "Other tools",
};

export const KIND_OF_RESOURCE: Record<ResourceKind, MapKind> = {
  command: "shell",
  web: "web",
  search: "search",
  agent: "agents",
  tool: "tools",
};

export interface MapFilters {
  /** Kinds switched off. */
  hide: MapKind[];
  /** Files: only calls that changed them. */
  changed: boolean;
  errors: boolean;
  /** Focused agent's session id. */
  agent: string | null;
  /** Time range, inclusive; null = open end. */
  from: number | null;
  to: number | null;
}

type Params = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v) || undefined;

const time = (v: string | undefined): number | null => (v && /^\d+$/.test(v) ? Number(v) : null);

export function parseMapFilters(params: Params): MapFilters {
  const listed = (one(params.hide) ?? "").split(",");
  const hide = MAP_KINDS.filter((k) => listed.includes(k));
  let from = time(one(params.from));
  let to = time(one(params.to));
  if (from !== null && to !== null && from > to) [from, to] = [to, from];
  return { hide, changed: one(params.changed) === "1", errors: one(params.errors) === "1", agent: one(params.agent) ?? null, from, to };
}

/** Query string of `f` ("" when everything is default), the inverse of `parseMapFilters`. */
export function mapQuery(f: MapFilters): string {
  const qs = new URLSearchParams();
  const hide = MAP_KINDS.filter((k) => f.hide.includes(k));
  if (hide.length) qs.set("hide", hide.join(","));
  if (f.changed) qs.set("changed", "1");
  if (f.errors) qs.set("errors", "1");
  if (f.agent) qs.set("agent", f.agent);
  if (f.from !== null) qs.set("from", String(Math.round(f.from)));
  if (f.to !== null) qs.set("to", String(Math.round(f.to)));
  return qs.size ? `?${qs}` : "";
}

/** Whether one call passes the time, agent and errors filters (kinds apply per node). */
export function passes(a: ActivityAction, f: MapFilters, agent: number | null): boolean {
  if (f.from !== null && a.ts < f.from) return false;
  if (f.to !== null && a.ts > f.to) return false;
  if (agent !== null && a.agent !== agent) return false;
  return !f.errors || a.error === true;
}

/** Time at pixel `px` of `scale`: the inverse of `scale.x`, breaks spread linearly, clamped to the scale's span. */
export function invertTime(scale: TimeScale, px: number): number {
  const { segments, breaks } = scale;
  if (!segments.length) return 0;
  if (px <= segments[0].x0) return segments[0].start;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (px <= s.x1) return s.x1 === s.x0 ? s.start : s.start + ((px - s.x0) / (s.x1 - s.x0)) * (s.end - s.start);
    const b = breaks[i];
    if (b && px <= b.x1) return b.x1 === b.x0 ? b.to : b.from + ((px - b.x0) / (b.x1 - b.x0)) * (b.to - b.from);
  }
  return segments[segments.length - 1].end;
}
