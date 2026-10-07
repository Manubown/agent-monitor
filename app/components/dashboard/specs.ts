/**
 * What the dashboard is made of: one entry per widget, in the order the default layout shows them (which is the
 * order the overview had before it became a dashboard). No JSX here, so the server action and the layout model can
 * import the registry without pulling a page's worth of components with them; `widgets.tsx` adds the renderers.
 *
 * Sizes: `widths` are column spans on the 12-column grid, `heights` the body-height presets of `HEIGHT_PX`. A widget
 * that cannot do anything with a height (the tiles, the cards, the heatmap draw themselves) allows one preset, and
 * its controls then show no height group.
 */

import type { WidgetSpec } from "../../../src/core/dashboard";

export const WIDGET_SPECS = [
  {
    id: "sessions",
    title: "Recent sessions",
    note: "The latest session trees as cards",
    widths: [4, 6, 8, 12],
    heights: ["M"],
    defaultSize: { w: 12, h: "M" },
  },
  {
    id: "summary",
    title: "Summary",
    note: "Cost, sessions, tokens, requests, tool calls, cache hit rate",
    widths: [4, 6, 8, 12],
    heights: ["M"],
    defaultSize: { w: 12, h: "M" },
  },
  {
    id: "cost-per-day",
    title: "Cost per day",
    note: "Daily spend by tool; a column opens that day",
    widths: [4, 6, 8, 12],
    heights: ["S", "M", "L"],
    defaultSize: { w: 6, h: "S" },
  },
  {
    id: "tokens-per-day",
    title: "Tokens per day",
    note: "Daily tokens by tool; a column opens that day",
    widths: [4, 6, 8, 12],
    heights: ["S", "M", "L"],
    defaultSize: { w: 6, h: "S" },
  },
  {
    id: "heatmap",
    title: "Activity",
    note: "Calendar and hour-of-day heatmap",
    widths: [6, 8, 12],
    heights: ["M"],
    defaultSize: { w: 12, h: "M" },
  },
  {
    id: "token-mix",
    title: "Token mix",
    note: "Cache reads and writes, input and output",
    widths: [3, 4, 6, 8, 12],
    heights: ["S", "M", "L"],
    defaultSize: { w: 6, h: "S" },
  },
  {
    id: "tools",
    title: "Tools used",
    note: "Calls and failures per tool",
    widths: [3, 4, 6, 8, 12],
    heights: ["S", "M", "L"],
    defaultSize: { w: 6, h: "L" },
  },
  {
    id: "models",
    title: "Models",
    note: "Requests, tokens and cost per model",
    widths: [6, 8, 12],
    heights: ["S", "M", "L"],
    defaultSize: { w: 12, h: "L" },
  },
  {
    id: "projects",
    title: "Projects",
    note: "Sessions, tokens and cost per working directory",
    widths: [4, 6, 8, 12],
    heights: ["S", "M", "L"],
    defaultSize: { w: 12, h: "L" },
  },
] as const satisfies readonly WidgetSpec[];

export type WidgetId = (typeof WIDGET_SPECS)[number]["id"];

/** The per-day charts; the `?day=` panel follows the last one the layout shows. */
export const DAY_CHART_IDS: readonly WidgetId[] = ["cost-per-day", "tokens-per-day"];
