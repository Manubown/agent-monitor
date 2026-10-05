import { motionEnabled, subscribeMotion } from "./motion";

/**
 * The pixel band's canvas: a data skyline along the bottom and a slow value-noise wave drifting above it, drawn as
 * square cells in four brightness levels taken from the --field-* tokens. One Path2D per level, so a frame is four
 * fills. Animates at FPS only while visible, on screen and with motion enabled; otherwise it shows one still frame.
 * Cells under [data-quiet] elements are dimmed so text never sits on the field.
 */

/** Cell pitch and gap in CSS px. */
const CELL = 10;
const GAP = 2;
const FPS = 20;
/** Share of the rows the tallest skyline column fills. */
const SKY = 0.45;
/** Per-frame step of skyline columns toward new data (live updates grow, they do not jump). */
const EASE = 0.2;
/** Clearance around quiet elements, CSS px. */
const QUIET_PAD = 12;
/** Background, then levels 1..4: field dim and mid (the wave), skyline body and skyline crest. */
const TOKENS = ["--page", "--field-dim", "--field-mid", "--field-lit", "--field-crest"] as const;

export interface PixelField {
  /** New skyline data: event counts per time bin, oldest first. */
  setData(counts: readonly number[]): void;
  /** Re-reads size, device pixel ratio and quiet zones; call after layout or text changes. */
  measure(): void;
  destroy(): void;
}

/** Pseudo-random value in [0, 1) per lattice point. */
function hash(i: number, j: number): number {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth 2D value noise in [0, 1] over the hash lattice; cheap enough for a few thousand cells per frame. */
function noise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function createPixelField(band: HTMLElement, canvas: HTMLCanvasElement): PixelField {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return { setData() {}, measure() {}, destroy() {} };

  let colors: string[] = [];
  let counts: readonly number[] = [];
  let cols = 0;
  let rows = 0;
  let cell = CELL;
  let gap = GAP;
  /** Grid origin in device px: the grid is anchored bottom-right, so the newest data and the ground row are whole. */
  let ox = 0;
  let oy = 0;
  let target = new Float32Array(0);
  let current = new Float32Array(0);
  let quiet = new Uint8Array(0);
  let t = 3;
  let raf = 0;
  let last = 0;
  let onScreen = true;

  const readColors = () => {
    const style = getComputedStyle(band);
    colors = TOKENS.map((name) => style.getPropertyValue(name).trim());
  };

  /** Column heights in cells: the busiest bin each column covers, scaled to the busiest bin overall. */
  const skyline = () => {
    const sky = Math.max(1, Math.floor(rows * SKY));
    const n = counts.length;
    let max = 0;
    for (const c of counts) max = Math.max(max, c);
    for (let x = 0; x < cols; x++) {
      const from = Math.floor((x * n) / cols);
      const to = Math.max(from + 1, Math.floor(((x + 1) * n) / cols));
      let v = 0;
      for (let i = from; i < Math.min(to, n); i++) v = Math.max(v, counts[i]);
      target[x] = v > 0 ? Math.max(1, Math.round((v / max) * sky)) : 0;
    }
  };

  const paint = () => {
    const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    const size = cell - gap;
    for (let x = 0; x < cols; x++) {
      const h = Math.round(current[x]);
      // The wave's crest line rolls along the band; noise breaks it into drifting clusters.
      const crest = rows * (0.45 + 0.18 * Math.sin(x * 0.07 + t * 0.9));
      for (let y = 0; y < rows; y++) {
        const fromBottom = rows - 1 - y;
        let level = 0;
        if (fromBottom < h) level = fromBottom === h - 1 ? 4 : 3;
        else {
          const v = (1 - (Math.abs(y - crest) / rows) * 3.2) * 0.75 + noise(x * 0.18 - t * 1.4, y * 0.35 + t * 0.25) * 0.55 - 0.35;
          level = v > 0.62 ? 2 : v > 0.38 ? 1 : 0;
        }
        if (level && quiet[y * cols + x]) level = level >= 3 ? 1 : 0;
        if (level) paths[level].rect(ox + x * cell, oy + y * cell, size, size);
      }
    }
    ctx.fillStyle = colors[0];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 1; i < paths.length; i++) {
      ctx.fillStyle = colors[i];
      ctx.fill(paths[i]);
    }
  };

  /** A still frame with the skyline at its data, for paused states. */
  const still = () => {
    current.set(target);
    paint();
  };

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (now - last < 1000 / FPS - 1) return;
    t += Math.min(now - last, 100) / 1000;
    last = now;
    for (let x = 0; x < cols; x++) {
      const d = target[x] - current[x];
      current[x] = Math.abs(d) < 0.05 ? target[x] : current[x] + d * EASE;
    }
    paint();
  };

  const sync = () => {
    const run = onScreen && !document.hidden && motionEnabled();
    if (run && !raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    } else if (!run && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
      still();
    }
  };

  const measure = () => {
    // Whole device pixels per cell keep edges crisp; DPR is capped at 2 to bound the cell count.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const box = canvas.getBoundingClientRect();
    const width = Math.round(box.width * dpr);
    const height = Math.round(box.height * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    cell = Math.max(2, Math.round(CELL * dpr));
    gap = Math.max(1, Math.round(GAP * dpr));
    const nextCols = Math.ceil(width / cell);
    rows = Math.ceil(height / cell);
    ox = width - nextCols * cell + gap;
    oy = height - rows * cell + gap;
    if (nextCols !== cols) {
      cols = nextCols;
      target = new Float32Array(cols);
      current = new Float32Array(cols);
      skyline();
      current.set(target);
    } else skyline();
    quiet = new Uint8Array(cols * rows);
    const unit = cell / dpr;
    const left = box.left + ox / dpr;
    const top = box.top + oy / dpr;
    for (const el of band.querySelectorAll("[data-quiet]")) {
      const q = el.getBoundingClientRect();
      if (!q.width || !q.height) continue;
      const x0 = Math.max(0, Math.floor((q.left - left - QUIET_PAD) / unit));
      const x1 = Math.min(cols, Math.ceil((q.right - left + QUIET_PAD) / unit));
      const y0 = Math.max(0, Math.floor((q.top - top - QUIET_PAD) / unit));
      const y1 = Math.min(rows, Math.ceil((q.bottom - top + QUIET_PAD) / unit));
      for (let y = y0; y < y1; y++) quiet.fill(1, y * cols + x0, y * cols + x1);
    }
    // Resizing clears the canvas; repaint now rather than on the next tick.
    if (raf) paint();
    else still();
  };

  const recolor = () => {
    readColors();
    if (raf) paint();
    else still();
  };

  readColors();
  const resize = new ResizeObserver(measure);
  resize.observe(canvas);
  const visibility = new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    sync();
  });
  visibility.observe(band);
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", recolor);
  const theme = new MutationObserver(recolor);
  theme.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  document.addEventListener("visibilitychange", sync);
  const unsubscribe = subscribeMotion(sync);
  let alive = true;
  // Quiet zones follow the pixel font's metrics.
  document.fonts.ready.then(() => {
    if (alive) measure();
  });
  measure();
  sync();

  return {
    setData(next) {
      counts = next;
      skyline();
      if (!raf) still();
    },
    measure,
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      raf = 0;
      resize.disconnect();
      visibility.disconnect();
      theme.disconnect();
      scheme.removeEventListener("change", recolor);
      document.removeEventListener("visibilitychange", sync);
      unsubscribe();
    },
  };
}
