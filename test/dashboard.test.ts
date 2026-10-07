import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WIDGET_SPECS } from "../app/components/dashboard/specs";
import { applyEdit, type Catalog, defaultLayout, HEIGHTS, hiddenWidgets, normalizeLayout, parseEdit, type Slot, WIDTHS } from "../src/core/dashboard";
import { DEFAULT_LAYOUT_NAME, loadLayout, resetLayout, saveLayout } from "../src/store/dashboard";
import { type Db, openDb } from "../src/store/db";

/** A catalog with the shapes that matter: one size each, a single height, a widget that cannot be 12 wide. */
const CATALOG: Catalog = [
  { id: "alpha", title: "Alpha", note: "first", widths: [6, 12], heights: ["S", "M", "L"], defaultSize: { w: 12, h: "M" } },
  { id: "beta", title: "Beta", note: "second", widths: [3, 6], heights: ["M"], defaultSize: { w: 6, h: "M" } },
  { id: "gamma", title: "Gamma", note: "third", widths: [4, 8], heights: ["S", "L"], defaultSize: { w: 4, h: "S" } },
];

const ids = (layout: readonly Slot[]) => layout.map((s) => s.id);

describe("default layout", () => {
  it("is every widget of the catalog in order, at its own default size", () => {
    expect(defaultLayout(CATALOG)).toEqual([
      { id: "alpha", w: 12, h: "M" },
      { id: "beta", w: 6, h: "M" },
      { id: "gamma", w: 4, h: "S" },
    ]);
  });

  it("reproduces the overview's own order and proportions", () => {
    expect(defaultLayout(WIDGET_SPECS)).toEqual([
      { id: "sessions", w: 12, h: "M" },
      { id: "summary", w: 12, h: "M" },
      { id: "cost-per-day", w: 6, h: "S" },
      { id: "tokens-per-day", w: 6, h: "S" },
      { id: "heatmap", w: 12, h: "M" },
      { id: "token-mix", w: 6, h: "S" },
      { id: "tools", w: 6, h: "L" },
      { id: "models", w: 12, h: "L" },
      { id: "projects", w: 12, h: "L" },
    ]);
  });

  it("only offers sizes the grid and the presets know, and defaults the widget allows", () => {
    const seen = new Set<string>();
    for (const spec of WIDGET_SPECS) {
      expect(seen.has(spec.id)).toBe(false);
      seen.add(spec.id);
      expect(spec.widths.every((w) => WIDTHS.includes(w))).toBe(true);
      expect(spec.heights.every((h) => HEIGHTS.includes(h))).toBe(true);
      expect(spec.widths).toContain(spec.defaultSize.w);
      expect(spec.heights).toContain(spec.defaultSize.h);
    }
  });
});

describe("normalizeLayout", () => {
  it("falls back to the default when the stored value is not a list", () => {
    for (const raw of [undefined, null, 42, "[]", { id: "alpha" }]) expect(normalizeLayout(raw, CATALOG)).toEqual(defaultLayout(CATALOG));
  });

  it("keeps an empty list empty: that is a user who hid every widget", () => {
    expect(normalizeLayout([], CATALOG)).toEqual([]);
  });

  it("drops unknown ids, repeats and entries that are not slots, and keeps the stored order", () => {
    const stored = [
      { id: "gamma", w: 8, h: "L" },
      "nonsense",
      null,
      { w: 6, h: "M" },
      { id: "removed-widget", w: 6, h: "M" },
      { id: "alpha", w: 6, h: "S" },
      { id: "gamma", w: 4, h: "S" },
    ];
    expect(normalizeLayout(stored, CATALOG)).toEqual([
      { id: "gamma", w: 8, h: "L" },
      { id: "alpha", w: 6, h: "S" },
    ]);
  });

  it("snaps a size the widget does not allow to its default", () => {
    const stored = [
      { id: "beta", w: 12, h: "L" },
      { id: "gamma", w: 4, h: "M" },
      { id: "alpha", w: "wide", h: 3 },
    ];
    expect(normalizeLayout(stored, CATALOG)).toEqual([
      { id: "beta", w: 6, h: "M" },
      { id: "gamma", w: 4, h: "S" },
      { id: "alpha", w: 12, h: "M" },
    ]);
  });
});

describe("hiddenWidgets", () => {
  it("lists what the layout does not show, in registry order", () => {
    expect(hiddenWidgets([{ id: "gamma", w: 4, h: "S" }], CATALOG).map((w) => w.id)).toEqual(["alpha", "beta"]);
    expect(hiddenWidgets(defaultLayout(CATALOG), CATALOG)).toEqual([]);
  });
});

describe("applyEdit", () => {
  const layout = defaultLayout(CATALOG);

  it("moves a widget one place and leaves the ends alone", () => {
    expect(ids(applyEdit(layout, { kind: "move", id: "gamma", by: -1 }, CATALOG))).toEqual(["alpha", "gamma", "beta"]);
    expect(ids(applyEdit(layout, { kind: "move", id: "alpha", by: 1 }, CATALOG))).toEqual(["beta", "alpha", "gamma"]);
    // The first cannot move earlier, the last cannot move later.
    expect(ids(applyEdit(layout, { kind: "move", id: "alpha", by: -1 }, CATALOG))).toEqual(ids(layout));
    expect(ids(applyEdit(layout, { kind: "move", id: "gamma", by: 1 }, CATALOG))).toEqual(ids(layout));
  });

  it("sets a width and a height the widget allows, and ignores one it does not", () => {
    expect(applyEdit(layout, { kind: "width", id: "alpha", w: 6 }, CATALOG)[0]).toEqual({ id: "alpha", w: 6, h: "M" });
    expect(applyEdit(layout, { kind: "height", id: "alpha", h: "L" }, CATALOG)[0]).toEqual({ id: "alpha", w: 12, h: "L" });
    expect(applyEdit(layout, { kind: "width", id: "beta", w: 12 }, CATALOG)[1]).toEqual({ id: "beta", w: 6, h: "M" });
    expect(applyEdit(layout, { kind: "height", id: "gamma", h: "M" }, CATALOG)[2]).toEqual({ id: "gamma", w: 4, h: "S" });
  });

  it("hides a widget, down to the last one", () => {
    const one = applyEdit(applyEdit(layout, { kind: "hide", id: "alpha" }, CATALOG), { kind: "hide", id: "gamma" }, CATALOG);
    expect(ids(one)).toEqual(["beta"]);
    expect(applyEdit(one, { kind: "hide", id: "beta" }, CATALOG)).toEqual([]);
    // Hiding what is not there changes nothing.
    expect(applyEdit(one, { kind: "hide", id: "alpha" }, CATALOG)).toEqual(one);
  });

  it("adds a hidden widget at the end, at its default size, and never twice", () => {
    const hidden = applyEdit(layout, { kind: "hide", id: "beta" }, CATALOG);
    expect(applyEdit(hidden, { kind: "add", id: "beta" }, CATALOG)).toEqual([
      { id: "alpha", w: 12, h: "M" },
      { id: "gamma", w: 4, h: "S" },
      { id: "beta", w: 6, h: "M" },
    ]);
    expect(applyEdit(layout, { kind: "add", id: "beta" }, CATALOG)).toEqual(layout);
    expect(applyEdit(layout, { kind: "add", id: "nope" }, CATALOG)).toEqual(layout);
  });

  it("resets to the default and never mutates the layout it was given", () => {
    const custom: Slot[] = [{ id: "gamma", w: 8, h: "L" }];
    expect(applyEdit(custom, { kind: "reset" }, CATALOG)).toEqual(defaultLayout(CATALOG));
    applyEdit(custom, { kind: "width", id: "gamma", w: 4 }, CATALOG);
    applyEdit(custom, { kind: "hide", id: "gamma" }, CATALOG);
    expect(custom).toEqual([{ id: "gamma", w: 8, h: "L" }]);
  });
});

describe("parseEdit", () => {
  it("accepts what the controls send", () => {
    expect(parseEdit({ kind: "move", id: "beta", by: 1 }, CATALOG)).toEqual({ kind: "move", id: "beta", by: 1 });
    expect(parseEdit({ kind: "width", id: "gamma", w: 8 }, CATALOG)).toEqual({ kind: "width", id: "gamma", w: 8 });
    expect(parseEdit({ kind: "height", id: "alpha", h: "L" }, CATALOG)).toEqual({ kind: "height", id: "alpha", h: "L" });
    expect(parseEdit({ kind: "hide", id: "alpha" }, CATALOG)).toEqual({ kind: "hide", id: "alpha" });
    expect(parseEdit({ kind: "add", id: "alpha" }, CATALOG)).toEqual({ kind: "add", id: "alpha" });
    expect(parseEdit({ kind: "reset" }, CATALOG)).toEqual({ kind: "reset" });
  });

  it("rejects anything the registry does not know", () => {
    const bad: unknown[] = [
      null,
      "reset",
      ["reset"],
      { kind: "drop", id: "alpha" },
      { kind: "move", id: "alpha" },
      { kind: "move", id: "alpha", by: 2 },
      { kind: "move", id: "alpha", by: "-1" },
      { kind: "hide" },
      { kind: "hide", id: 7 },
      { kind: "hide", id: "unknown" },
      // A column span the grid knows, but not for this widget.
      { kind: "width", id: "beta", w: 12 },
      { kind: "width", id: "beta", w: 5 },
      { kind: "height", id: "beta", h: "L" },
      { kind: "height", id: "alpha", h: "XL" },
    ];
    for (const raw of bad) expect(parseEdit(raw, CATALOG)).toBeNull();
  });
});

describe("the stored layout", () => {
  const dirs: string[] = [];
  const open = (): { db: Db; file: string; userDb: string } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-dashboard-"));
    dirs.push(dir);
    const file = path.join(dir, "monitor.db");
    const userDb = path.join(dir, "user.db");
    return { db: openDb(file, { userDb }), file, userDb };
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round trips, normalizes on the way in and falls back to the default", () => {
    const db = openDb(":memory:");
    expect(loadLayout(db, CATALOG)).toEqual(defaultLayout(CATALOG));

    const custom: Slot[] = [
      { id: "gamma", w: 8, h: "L" },
      { id: "alpha", w: 6, h: "S" },
    ];
    expect(saveLayout(db, CATALOG, custom)).toEqual(custom);
    expect(loadLayout(db, CATALOG)).toEqual(custom);

    // Only layouts the registry allows are ever stored.
    saveLayout(db, CATALOG, [
      { id: "beta", w: 12, h: "M" },
      { id: "removed", w: 6, h: "M" },
    ] as Slot[]);
    expect(loadLayout(db, CATALOG)).toEqual([{ id: "beta", w: 6, h: "M" }]);

    resetLayout(db);
    expect(loadLayout(db, CATALOG)).toEqual(defaultLayout(CATALOG));
    expect(db.prepare("SELECT COUNT(*) AS n FROM user.dashboard_layout").get()).toEqual({ n: 0 });
    db.close();
  });

  it("survives a row that is not readable JSON", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO user.dashboard_layout (name, layout, updated_at) VALUES (?, ?, ?)").run(DEFAULT_LAYOUT_NAME, "{not json", Date.now());
    expect(loadLayout(db, CATALOG)).toEqual(defaultLayout(CATALOG));
    db.close();
  });

  it("is keyed by name, so a second layout can be stored beside it", () => {
    const db = openDb(":memory:");
    saveLayout(db, CATALOG, [{ id: "alpha", w: 6, h: "S" }]);
    saveLayout(db, CATALOG, [{ id: "beta", w: 3, h: "M" }], "cost");
    expect(loadLayout(db, CATALOG)).toEqual([{ id: "alpha", w: 6, h: "S" }]);
    expect(loadLayout(db, CATALOG, "cost")).toEqual([{ id: "beta", w: 3, h: "M" }]);
    db.close();
  });

  it("survives a SCHEMA_VERSION rebuild of the cache database", () => {
    const { db, file, userDb } = open();
    const custom: Slot[] = [{ id: "gamma", w: 8, h: "L" }];
    saveLayout(db, CATALOG, custom);
    db.prepare("INSERT INTO meta (key, value) VALUES ('generation', '7')").run();
    // An older schema: the next open drops and recreates everything in the cache database.
    db.exec("PRAGMA main.user_version = 1");
    db.close();

    const reopened = openDb(file, { userDb });
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM meta").get()).toEqual({ n: 0 });
    expect(loadLayout(reopened, CATALOG)).toEqual(custom);
    reopened.close();
  });
});
