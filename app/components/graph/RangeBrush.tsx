"use client";

import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { clock } from "../../lib/format";
import { invertTime } from "./resourceMap";
import { timeScale, timeTicks } from "./timeScale";

interface Props {
  /** Every call's time, ascending. */
  times: number[];
  from: number | null;
  to: number | null;
  /** Null ends mean the whole span on that side. */
  onChange: (from: number | null, to: number | null) => void;
}

const BAR_H = 30;
const AXIS_H = 16;
const BIN = 3;
const GRAB = 7;

type Drag = { mode: "lo" | "hi" | "new"; anchor: number } | { mode: "move"; anchor: number; lo: number; hi: number };

/** Calls over the session span (idle gaps squeezed) with a draggable, keyboard-adjustable range. */
export function RangeBrush({ times, from, to, onChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  /** Pixel range while dragging; committed on release. */
  const [draft, setDraft] = useState<[number, number] | null>(null);
  const drag = useRef<Drag | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const start = times[0] ?? 0;
  const end = times.at(-1) ?? 0;
  const scale = useMemo(() => timeScale(times, 0, Math.max(1, width), { breakPx: 24, minPx: 6 }), [times, width]);
  const { bins, max } = useMemo(() => {
    const bins = new Array<number>(Math.ceil(Math.max(1, width) / BIN) + 1).fill(0);
    for (const t of times) bins[Math.floor(scale.x(t) / BIN)]++;
    return { bins, max: Math.max(1, ...bins) };
  }, [times, scale, width]);
  const ticks = useMemo(() => (width ? timeTicks(scale, 90, -new Date().getTimezoneOffset() * 60_000) : []), [scale, width]);

  const lo = from ?? start;
  const hi = to ?? end;
  const [x0, x1] = draft ?? [scale.x(lo), scale.x(hi)];
  const full = from === null && to === null && !draft;

  const commit = (px0: number, px1: number) => {
    const a = Math.max(0, Math.min(px0, px1));
    const b = Math.min(width, Math.max(px0, px1));
    const t0 = invertTime(scale, a);
    const t1 = invertTime(scale, b);
    // Edges dragged to the ends of the axis mean "open", so live sessions keep growing into the range.
    onChange(a <= 0.5 || t0 <= start ? null : Math.floor(t0), b >= width - 0.5 || t1 >= end ? null : Math.ceil(t1));
  };

  const px = (e: PointerEvent) => {
    const rect = (e.currentTarget as Element).getBoundingClientRect();
    return Math.max(0, Math.min(width, e.clientX - rect.left));
  };

  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const p = px(e);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (!full && Math.abs(p - x0) <= GRAB) drag.current = { mode: "lo", anchor: x1 };
    else if (!full && Math.abs(p - x1) <= GRAB) drag.current = { mode: "hi", anchor: x0 };
    else if (!full && p > x0 && p < x1) drag.current = { mode: "move", anchor: p, lo: x0, hi: x1 };
    else drag.current = { mode: "new", anchor: p };
    if (drag.current.mode === "new") setDraft([p, p]);
  };

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = px(e);
    if (d.mode === "move") {
      const shift = Math.max(-d.lo, Math.min(width - d.hi, p - d.anchor));
      setDraft([d.lo + shift, d.hi + shift]);
    } else setDraft([Math.min(p, d.anchor), Math.max(p, d.anchor)]);
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !draft) return setDraft(null);
    setDraft(null);
    // A click without a drag clears the range.
    if (d.mode === "new" && draft[1] - draft[0] < 3) onChange(null, null);
    else commit(draft[0], draft[1]);
  };

  const onKey = (side: "lo" | "hi") => (e: KeyboardEvent) => {
    const step = width / (e.shiftKey ? 10 : 50);
    let p = side === "lo" ? x0 : x1;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") p -= step;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") p += step;
    else if (e.key === "Home") p = 0;
    else if (e.key === "End") p = width;
    else return;
    e.preventDefault();
    if (side === "lo") commit(Math.min(p, x1), x1);
    else commit(x0, Math.max(p, x0));
  };

  const shownLo = draft ? invertTime(scale, x0) : lo;
  const shownHi = draft ? invertTime(scale, x1) : hi;
  const inRange = useMemo(() => {
    let n = 0;
    for (const t of times) if (t >= shownLo && t <= shownHi) n++;
    return n;
  }, [times, shownLo, shownHi]);

  return (
    <div className="rm-brush">
      <div className="rm-brush-head">
        <span>
          <span className="mono">
            {clock(shownLo)} – {clock(shownHi)}
          </span>{" "}
          <span className="muted">
            {inRange} of {times.length} calls
          </span>
        </span>
        <button type="button" className="btn" disabled={full} onClick={() => onChange(null, null)}>
          Whole session
        </button>
      </div>
      <div ref={ref} className="rm-brush-plot">
        {width > 0 && (
          <svg
            width={width}
            height={BAR_H + AXIS_H}
            className="rm-brush-svg"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            role="group"
            aria-label="Time range. Drag to select, drag the edges to adjust, click to clear."
          >
            {scale.breaks.map((b) => (
              <rect key={b.from} x={b.x0} y={0} width={b.x1 - b.x0} height={BAR_H} className="rm-brush-break" />
            ))}
            {bins.map((n, i) =>
              n ? <rect key={i} x={i * BIN} y={BAR_H - Math.max(2, (n / max) * BAR_H)} width={BIN - 1} height={Math.max(2, (n / max) * BAR_H)} className="rm-brush-bar" /> : null,
            )}
            {!full && (
              <>
                <rect x={0} y={0} width={Math.max(0, x0)} height={BAR_H} className="rm-brush-out" />
                <rect x={x1} y={0} width={Math.max(0, width - x1)} height={BAR_H} className="rm-brush-out" />
                <rect x={x0} y={0.5} width={Math.max(1, x1 - x0)} height={BAR_H - 1} className="rm-brush-sel" />
              </>
            )}
            {ticks.map((t) => (
              <text key={t.ts} x={t.x} y={BAR_H + 12} className="chart-tick" textAnchor={t.x < 20 ? "start" : "middle"}>
                {clock(t.ts).slice(0, 5)}
              </text>
            ))}
            {(["lo", "hi"] as const).map((side) => {
              const x = side === "lo" ? x0 : x1;
              const t = side === "lo" ? shownLo : shownHi;
              return (
                <rect
                  key={side}
                  x={x - 3}
                  y={0}
                  width={6}
                  height={BAR_H}
                  className="rm-brush-handle"
                  tabIndex={0}
                  role="slider"
                  aria-label={side === "lo" ? "Range start" : "Range end"}
                  aria-valuemin={start}
                  aria-valuemax={end}
                  aria-valuenow={Math.round(t)}
                  aria-valuetext={clock(t)}
                  onKeyDown={onKey(side)}
                />
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}
