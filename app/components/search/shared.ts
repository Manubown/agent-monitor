import type { Facets, ResultGroup, SearchContext, SearchResult, SessionInfo } from "../../../src/search/service";

/** JSON shapes of /api/search and /api/search/context: service results plus each source's CSS color. */
export type ApiSession = SessionInfo & { color: string };
export type ApiGroup = Omit<ResultGroup, "session"> & { session: ApiSession };
export type ApiSearch = Omit<SearchResult, "groups"> & { groups: ApiGroup[] };
export type ApiContext = Omit<SearchContext, "session"> & { session: ApiSession };
export type ApiFacets = Omit<Facets, "sources"> & { sources: (Facets["sources"][number] & { color: string })[] };

/** Window event the palette fires after navigating to an event anchor; detail is the href ("/sessions/<id>#e-12"). */
export const TARGET_EVENT = "agent-monitor:target";

export const KIND_LABEL: Record<string, string> = {
  user: "Prompt",
  assistant: "Reply",
  thinking: "Thinking",
  tool_call: "Tool call",
  tool_result: "Result",
  system: "System",
  error: "Error",
  session: "Session",
};

export const KIND_COLOR: Record<string, string> = {
  user: "var(--kind-user)",
  assistant: "var(--kind-assistant)",
  thinking: "var(--kind-thinking)",
  tool_call: "var(--kind-tool)",
  tool_result: "var(--kind-tool)",
  system: "var(--kind-system)",
  error: "var(--kind-error)",
};

/** Session link; with an event, the timeline opens on a page around it (`at`) and `#e-<seq>` scrolls to it. */
export const sessionHref = (id: string, seq?: number): string =>
  `/sessions/${encodeURIComponent(id)}${seq !== undefined && seq >= 0 ? `?at=${seq}#e-${seq}` : ""}`;
