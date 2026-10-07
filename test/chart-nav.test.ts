import { describe, expect, it } from "vitest";
import { columnForKey } from "../app/components/chart/nav";

describe("columnForKey", () => {
  it("starts at the near end when no column is selected yet", () => {
    expect(columnForKey("ArrowRight", null, 5)).toBe(0);
    expect(columnForKey("ArrowLeft", null, 5)).toBe(4);
    expect(columnForKey("Home", null, 5)).toBe(0);
    expect(columnForKey("End", null, 5)).toBe(4);
  });

  it("steps one column and stops at the ends", () => {
    expect(columnForKey("ArrowRight", 2, 5)).toBe(3);
    expect(columnForKey("ArrowLeft", 2, 5)).toBe(1);
    expect(columnForKey("ArrowRight", 4, 5)).toBe(4);
    expect(columnForKey("ArrowLeft", 0, 5)).toBe(0);
  });

  it("moves with the vertical arrows as well", () => {
    expect(columnForKey("ArrowDown", 1, 5)).toBe(2);
    expect(columnForKey("ArrowUp", 1, 5)).toBe(0);
  });

  it("leaves other keys to the page", () => {
    for (const key of ["Enter", " ", "Tab", "Escape", "a", "PageDown", "arrowright"]) {
      expect(columnForKey(key, 2, 5), key).toBeNull();
    }
  });

  it("has nowhere to go in an empty chart", () => {
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
      expect(columnForKey(key, null, 0), key).toBeNull();
    }
  });

  it("recovers from a selection outside the chart", () => {
    // Columns change with the filters while a column is selected.
    expect(columnForKey("ArrowRight", 9, 3)).toBe(0);
    expect(columnForKey("ArrowLeft", -1, 3)).toBe(2);
    expect(columnForKey("End", 9, 3)).toBe(2);
  });
});
