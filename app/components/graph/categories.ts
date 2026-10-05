import type { ActionCategory, ActivityAgent } from "../../../src/store/activity";

/** Draw order in stacked columns and the legend. Failed calls stack as their own "error" band. */
export const CATEGORIES: { key: ActionCategory | "error"; label: string; color: string }[] = [
  { key: "read", label: "read", color: "var(--series-1)" },
  { key: "write", label: "write/edit", color: "var(--series-2)" },
  { key: "search", label: "search", color: "var(--series-7)" },
  { key: "shell", label: "shell", color: "var(--series-3)" },
  { key: "web", label: "web", color: "var(--series-5)" },
  { key: "agent", label: "agent/task", color: "var(--series-4)" },
  { key: "other", label: "other", color: "var(--kind-thinking)" },
  { key: "error", label: "failed", color: "var(--kind-error)" },
];

export const CATEGORY_COLOR = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.color])) as Record<ActionCategory | "error", string>;
export const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label])) as Record<ActionCategory | "error", string>;

export const agentColor = (a: ActivityAgent): string => `var(--series-${a.slot})`;

/** Deep link to one event on its agent's session page. */
export const eventHref = (agent: ActivityAgent, seq: number): string => `/sessions/${encodeURIComponent(agent.id)}?at=${seq}#e-${seq}`;
