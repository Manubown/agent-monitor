/** Squarified treemap (Bruls, Huizing, van Wijk 2000): rectangles with areas proportional to values, as square as possible. */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Worst aspect ratio of a row with total area `sum`, largest item `max`, smallest `min`, along a side of length `side`. */
function worst(sum: number, max: number, min: number, side: number): number {
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/**
 * Lay `values` out inside `rect`. Returns one rect per input value, in input order; values <= 0 (or NaN) get an empty
 * rect at the origin of `rect`. The rects tile `rect` exactly (up to floating point) when at least one value is positive.
 */
export function squarify(values: readonly number[], rect: Rect): Rect[] {
  const out: Rect[] = values.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
  const items = values
    .map((v, i) => ({ v, i }))
    .filter((it) => it.v > 0)
    .sort((a, b) => b.v - a.v || a.i - b.i);
  const total = items.reduce((s, it) => s + it.v, 0);
  if (!total || rect.w <= 0 || rect.h <= 0) return out;
  const scale = (rect.w * rect.h) / total;
  const area = items.map((it) => it.v * scale);

  let { x, y, w, h } = rect;
  let start = 0;
  while (start < items.length) {
    const side = Math.min(w, h);
    // Grow the row while it keeps the worst aspect ratio from getting worse. Areas are sorted descending, so the
    // row's largest item is its first and its smallest its last.
    let end = start + 1;
    let rowArea = area[start];
    let current = worst(rowArea, area[start], area[start], side);
    while (end < items.length) {
      const next = worst(rowArea + area[end], area[start], area[end], side);
      if (next > current) break;
      current = next;
      rowArea += area[end];
      end++;
    }
    const last = end === items.length;
    if (w >= h) {
      // Column on the left; the last row takes the remaining width exactly.
      const cw = last ? w : rowArea / h;
      let cy = y;
      for (let k = start; k < end; k++) {
        const ch = k === end - 1 ? y + h - cy : area[k] / cw;
        out[items[k].i] = { x, y: cy, w: cw, h: ch };
        cy += ch;
      }
      x += cw;
      w -= cw;
    } else {
      // Row along the top.
      const rh = last ? h : rowArea / w;
      let cx = x;
      for (let k = start; k < end; k++) {
        const cw = k === end - 1 ? x + w - cx : area[k] / rh;
        out[items[k].i] = { x: cx, y, w: cw, h: rh };
        cx += cw;
      }
      y += rh;
      h -= rh;
    }
    start = end;
  }
  return out;
}

export interface LayoutBox<T> {
  node: T;
  rect: Rect;
  /** 1 for the root's children. */
  depth: number;
  /** Directory drawn with a header and its children inside (false: drawn as one block). */
  open: boolean;
}

export interface NestedOptions {
  /** Levels below the root to lay out (1: only the root's children). */
  depth: number;
  /** Height reserved for an open directory's header. */
  header: number;
  /** Inset of an open directory's children from its edges. */
  pad: number;
  /** Directories smaller than this in either dimension are not opened. */
  minOpen: number;
  /** Boxes smaller than this in either dimension are dropped (their area stays empty). */
  minBox: number;
}

/**
 * Nested layout of `root`'s children inside `rect`, parents before children. `value` sizes a node, `children` lists a
 * directory's children (undefined for leaves); a parent's value must be the sum of its children's for areas to stay
 * proportional at every level.
 */
export function nestedLayout<T>(root: T, rect: Rect, o: NestedOptions, value: (n: T) => number, children: (n: T) => readonly T[] | undefined): LayoutBox<T>[] {
  const out: LayoutBox<T>[] = [];
  const visit = (node: T, r: Rect, depth: number) => {
    const kids = children(node) ?? [];
    const rects = squarify(kids.map(value), r);
    kids.forEach((kid, i) => {
      const kr = rects[i];
      if (kr.w < o.minBox || kr.h < o.minBox) return;
      const open = !!children(kid)?.length && depth < o.depth && kr.w >= o.minOpen && kr.h >= o.minOpen + o.header;
      out.push({ node: kid, rect: kr, depth, open });
      if (open) visit(kid, { x: kr.x + o.pad, y: kr.y + o.header, w: kr.w - 2 * o.pad, h: kr.h - o.header - o.pad }, depth + 1);
    });
  };
  visit(root, rect, 1);
  return out;
}
