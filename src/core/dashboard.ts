/**
 * Layout model of the modular dashboard: an ordered list of widget slots on a 12-column grid. Pure (no database, no
 * React, no DOM) so normalization and every edit are testable on their own. What a widget renders is none of this
 * module's business: the catalog (`app/components/dashboard/specs.ts`) names the ids, titles and allowed sizes.
 */

/** Column spans a slot may take on the 12-column grid. */
export const WIDTHS = [3, 4, 6, 8, 12] as const;
export type Width = (typeof WIDTHS)[number];

/** Row-height presets, never free pixel sizes. */
export const HEIGHTS = ["S", "M", "L"] as const;
export type Height = (typeof HEIGHTS)[number];

/**
 * The body height a preset buys, in pixels. A chart draws exactly that tall; a table gets it as a maximum and
 * scrolls inside the card, so a long list is never cut off without a way to see the rest. Widgets that cannot use a
 * height (the tiles, the session cards, the heatmap) allow a single preset, and their controls show no height group.
 */
export const HEIGHT_PX: Record<Height, number> = { S: 220, M: 340, L: 500 };

/** Spoken form of a preset, for the control's accessible name. */
export const HEIGHT_LABEL: Record<Height, string> = { S: "small", M: "medium", L: "large" };

/** One widget on the dashboard: which widget, how wide, how tall. */
export interface Slot {
  id: string;
  w: Width;
  h: Height;
}

/** What the layout model knows about a widget; the registry adds the renderer. */
export interface WidgetSpec {
  id: string;
  /** Card title, also the name of every control ("Move Models earlier"). */
  title: string;
  /** One line in the "Add widget" list. */
  note: string;
  widths: readonly Width[];
  heights: readonly Height[];
  /** Size in the default layout, and what a size the widget does not allow snaps to. */
  defaultSize: { w: Width; h: Height };
}

export type Catalog = readonly WidgetSpec[];

export const specOf = (catalog: Catalog, id: string): WidgetSpec | undefined => catalog.find((w) => w.id === id);

/** Every widget, in registry order, at its own default size: the page as it looked before it became a dashboard. */
export function defaultLayout(catalog: Catalog): Slot[] {
  return catalog.map((w) => ({ id: w.id, w: w.defaultSize.w, h: w.defaultSize.h }));
}

/**
 * A stored layout made safe to render: unknown ids (a widget that was removed) and repeats are dropped, and a size
 * the widget does not allow snaps to its default. Anything that is not an array — a corrupt row, an older format —
 * falls back to the default layout. An array that normalizes to nothing stays empty: that is a user who hid
 * everything, not a broken row.
 */
export function normalizeLayout(raw: unknown, catalog: Catalog): Slot[] {
  if (!Array.isArray(raw)) return defaultLayout(catalog);
  const seen = new Set<string>();
  const slots: Slot[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, w, h } = entry as { id?: unknown; w?: unknown; h?: unknown };
    if (typeof id !== "string" || seen.has(id)) continue;
    const spec = specOf(catalog, id);
    if (!spec) continue;
    seen.add(id);
    slots.push({
      id,
      w: spec.widths.includes(w as Width) ? (w as Width) : spec.defaultSize.w,
      h: spec.heights.includes(h as Height) ? (h as Height) : spec.defaultSize.h,
    });
  }
  return slots;
}

/** Widgets the layout does not show, in registry order: what "Add widget" offers. */
export function hiddenWidgets(layout: readonly Slot[], catalog: Catalog): WidgetSpec[] {
  const shown = new Set(layout.map((s) => s.id));
  return catalog.filter((w) => !shown.has(w.id));
}

/** One change to the layout, as the controls send it. Never a whole layout: the server owns that. */
export type LayoutEdit =
  | { kind: "move"; id: string; by: -1 | 1 }
  | { kind: "width"; id: string; w: Width }
  | { kind: "height"; id: string; h: Height }
  | { kind: "hide"; id: string }
  | { kind: "add"; id: string }
  | { kind: "reset" };

/**
 * The edit applied to a normalized layout. An edit that cannot happen — the first widget moved earlier, the last one
 * later, an unknown or already shown id, a size the widget does not allow — leaves the layout as it was, so a stale
 * page cannot push the dashboard into a state its own controls would not offer.
 */
export function applyEdit(layout: readonly Slot[], edit: LayoutEdit, catalog: Catalog): Slot[] {
  if (edit.kind === "reset") return defaultLayout(catalog);
  const slots = layout.map((s) => ({ ...s }));
  if (edit.kind === "add") {
    const spec = specOf(catalog, edit.id);
    if (!spec || slots.some((s) => s.id === edit.id)) return slots;
    slots.push({ id: spec.id, w: spec.defaultSize.w, h: spec.defaultSize.h });
    return slots;
  }
  const spec = specOf(catalog, edit.id);
  const i = slots.findIndex((s) => s.id === edit.id);
  if (!spec || i < 0) return slots;
  switch (edit.kind) {
    case "move": {
      const j = i + edit.by;
      if (j < 0 || j >= slots.length) return slots;
      [slots[i], slots[j]] = [slots[j], slots[i]];
      return slots;
    }
    case "hide":
      slots.splice(i, 1);
      return slots;
    case "width":
      if (spec.widths.includes(edit.w)) slots[i].w = edit.w;
      return slots;
    case "height":
      if (spec.heights.includes(edit.h)) slots[i].h = edit.h;
      return slots;
  }
}

/**
 * An edit as it arrives from the browser. The client says what it wants changed, never what the layout should be:
 * the server reads the stored layout and applies this to it. Anything that does not name a widget of the catalog and
 * one of the sizes that widget allows is rejected here rather than quietly corrected.
 */
export function parseEdit(raw: unknown, catalog: Catalog): LayoutEdit | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { kind, id, by, w, h } = raw as Record<string, unknown>;
  if (kind === "reset") return { kind: "reset" };
  if (typeof id !== "string") return null;
  const spec = specOf(catalog, id);
  if (!spec) return null;
  switch (kind) {
    case "move":
      return by === -1 || by === 1 ? { kind: "move", id, by } : null;
    case "hide":
      return { kind: "hide", id };
    case "add":
      return { kind: "add", id };
    case "width":
      return spec.widths.includes(w as Width) ? { kind: "width", id, w: w as Width } : null;
    case "height":
      return spec.heights.includes(h as Height) ? { kind: "height", id, h: h as Height } : null;
    default:
      return null;
  }
}
