/**
 * The dashboard layout in user.db: it is the user's own data, so it lives beside the tags and survives the
 * `SCHEMA_VERSION` rebuilds of the cache database. Everything that decides what a layout may look like is in
 * `src/core/dashboard.ts`; this module only reads and writes it.
 */

import { type Catalog, defaultLayout, normalizeLayout, type Slot } from "../core/dashboard";
import type { Db } from "./db";

/** The overview's layout. The table is keyed by name so named layouts can be added later without a migration. */
export const DEFAULT_LAYOUT_NAME = "default";

/** The stored layout, normalized against the catalog, or the default when nothing (or nothing readable) is stored. */
export function loadLayout(db: Db, catalog: Catalog, name: string = DEFAULT_LAYOUT_NAME): Slot[] {
  const row = db.prepare("SELECT layout FROM user.dashboard_layout WHERE name = ?").get(name) as { layout: string } | undefined;
  if (!row) return defaultLayout(catalog);
  try {
    return normalizeLayout(JSON.parse(row.layout), catalog);
  } catch {
    // A hand-edited or truncated row must not take the dashboard down; the default is always renderable.
    return defaultLayout(catalog);
  }
}

/** Normalizes before writing, so only layouts the registry allows are ever stored. Returns what was written. */
export function saveLayout(db: Db, catalog: Catalog, layout: readonly Slot[], name: string = DEFAULT_LAYOUT_NAME): Slot[] {
  const clean = normalizeLayout(layout, catalog);
  db.prepare(
    `INSERT INTO user.dashboard_layout (name, layout, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at`,
  ).run(name, JSON.stringify(clean), Date.now());
  return clean;
}

/** Back to the default: the row is deleted rather than overwritten, so "no row" keeps meaning "whatever ships". */
export function resetLayout(db: Db, name: string = DEFAULT_LAYOUT_NAME): void {
  db.prepare("DELETE FROM user.dashboard_layout WHERE name = ?").run(name);
}
