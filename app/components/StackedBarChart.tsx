"use client";

import { useEffect, useId, useRef, useState } from "react";
import { integer, tokens, usd } from "../lib/format";

export interface ChartSeries {
  key: string;
  label: string;
  /** CSS color, normally a categorical token such as var(--series-1). */
  color: string;
  values: number[];
}

/** A vertical rule on the boundary before column `index` (`labels.length` = after the last column). */
export interface ChartMarker {
  index: number;
  /** Short text drawn above the plot, e.g. "-120k". */
  label: string;
  /** Longer description for the tooltip, the column's accessible name and the table view. */
  title?: string;
  /** Drawn dashed and muted, e.g. for inferred events. */
  dashed?: boolean;
}

interface Props {
  /** Full label per column, used in the tooltip and the table view. */
  labels: string[];
  /** Short axis label per column (defaults to `labels`). */
  ticks?: string[];
  series: ChartSeries[];
  format: "usd" | "tokens";
  /** Optional extra tooltip lines per column. */
  notes?: string[][];
  /** Optional boundary markers; the plot gains a strip above it for their labels. */
  markers?: ChartMarker[];
  height?: number;
  ariaLabel: string;
}

const MARGIN = { top: 8, right: 4, bottom: 24, left: 52 };
/** Pixel cell pitch: bars are drawn in whole cells of CELL - 1 px with 1 px gaps. */
const CELL = 6;

const formatters = {
  usd: (n: number) => usd(n),
  tokens: (n: number) => tokens(n),
};

/** Round the axis maximum up to 1, 2 or 5 times a power of ten. */
function niceScale(max: number, count = 4): { top: number; step: number } {
  if (max <= 0) return { top: 1, step: 0.25 };
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  return { top: Math.ceil(max / step) * step, step };
}

/** Nearest whole number of cells, in px. */
const snap = (px: number) => Math.round(px / CELL) * CELL;

export function StackedBarChart({ labels, ticks, series, format, notes, markers = [], height = 220, ariaLabel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const fmt = formatters[format];
  const maskId = `pixels-${useId().replace(/[^\w-]/g, "")}`;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const n = labels.length;
  const totals = labels.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const markerText = new Map(markers.map((m) => [m.index, m.title ?? m.label]));
  const marginTop = MARGIN.top + (markers.length ? 14 : 0);
  const { top, step } = niceScale(Math.max(0, ...totals));
  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotH = height - marginTop - MARGIN.bottom;
  const band = n ? plotW / n : 0;
  const barW = Math.max(1, Math.min(24, band * 0.7));
  // Bars at least two cells wide are cut into square cells; narrower ones (many requests) only into rows.
  const columns = barW >= 2 * CELL;
  const baseline = marginTop + plotH;
  const y = (v: number) => marginTop + plotH - (v / top) * plotH;
  const tickEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 64))));
  const axisTicks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);

  const tooltipLeft = active === null ? 0 : Math.min(Math.max(0, MARGIN.left + band * active + band / 2 - 80), Math.max(0, width - 180));

  return (
    <div className="chart">
      {series.length > 1 && (
        <div className="chart-legend">
          {series.map((s) => (
            <span key={s.key}>
              <span className="swatch" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div ref={ref} style={{ height, position: "relative" }} onPointerLeave={() => setActive(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={ariaLabel}>
            <defs>
              {/* Mask luminance, not a theme color: white cells show the bars, the 1 px gaps hide them. */}
              <pattern id={`${maskId}-cells`} width={columns ? CELL : 1} height={CELL} y={baseline % CELL} patternUnits="userSpaceOnUse">
                <rect width={columns ? CELL - 1 : 1} height={CELL - 1} fill="white" />
              </pattern>
              <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
                <rect width={width} height={height} fill={`url(#${maskId}-cells)`} />
              </mask>
            </defs>
            {axisTicks.map((t) => (
              <g key={t}>
                <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--baseline)" : "var(--grid)"} strokeWidth={1} shapeRendering="crispEdges" />
                <text className="chart-tick" x={MARGIN.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                  {fmt(t)}
                </text>
              </g>
            ))}
            {labels.map((label, i) => {
              const x = columns ? snap(MARGIN.left + band * i + (band - barW) / 2) : MARGIN.left + band * i + (band - barW) / 2;
              const w = columns ? snap(barW) : barW;
              const visible = series.filter((s) => (s.values[i] ?? 0) > 0);
              // Stack in whole cells: each segment ends at the snapped running total, so the column's height stays
              // true to its total; a non-zero column keeps at least one cell. Exact values are in the tooltip and table.
              const px = (v: number) => (v / top) * plotH;
              let sum = 0;
              let prev = 0;
              const segments = visible.map((s, j) => {
                sum += s.values[i];
                const end = j === visible.length - 1 ? Math.max(CELL, snap(px(sum))) : snap(px(sum));
                const seg = { key: s.key, color: s.color, y: baseline - end, h: end - prev };
                prev = end;
                return seg;
              });
              return (
                <g
                  key={label}
                  className="chart-col"
                  tabIndex={0}
                  aria-label={`${label}: ${fmt(totals[i])}${markerText.has(i) ? `, ${markerText.get(i)}` : ""}`}
                  onPointerEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                >
                  <rect
                    className="chart-hit"
                    x={MARGIN.left + band * i}
                    y={marginTop}
                    width={band}
                    height={plotH}
                    fill={active === i ? "var(--hover)" : "transparent"}
                  />
                  <g mask={`url(#${maskId})`}>
                    {segments.map((seg) => seg.h > 0 && <rect key={seg.key} x={x} y={seg.y} width={w} height={seg.h} fill={seg.color} />)}
                  </g>
                  {i % tickEvery === 0 && (
                    <text className="chart-tick" x={MARGIN.left + band * i + band / 2} y={height - 6} textAnchor="middle">
                      {(ticks ?? labels)[i]}
                    </text>
                  )}
                </g>
              );
            })}
            {markers.map((m) => {
              const mx = Math.round(MARGIN.left + band * m.index) + 0.5;
              const right = mx > width - 64;
              return (
                <g key={`${m.index}-${m.label}`} pointerEvents="none" aria-hidden="true">
                  <line
                    x1={mx}
                    x2={mx}
                    y1={MARGIN.top + 2}
                    y2={baseline}
                    stroke={m.dashed ? "var(--ink-muted)" : "var(--ink-2)"}
                    strokeWidth={1}
                    strokeDasharray={m.dashed ? "2 2" : undefined}
                    shapeRendering="crispEdges"
                  />
                  <text className="chart-tick" x={right ? mx - 4 : mx + 4} y={MARGIN.top + 9} textAnchor={right ? "end" : "start"} style={{ fill: "var(--ink-2)" }}>
                    {m.label}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
        {active !== null && (
          <div className="tooltip" style={{ left: tooltipLeft, top: Math.max(0, y(totals[active]) - 12) }} role="status">
            <div className="tooltip-title">{labels[active]}</div>
            {series.length > 1 && (
              <div className="tooltip-row">
                <span className="tooltip-value">{fmt(totals[active])}</span>
                <span className="tooltip-name">total</span>
              </div>
            )}
            {series.map((s) => (
              <div className="tooltip-row" key={s.key}>
                <span className="tooltip-key" style={{ background: s.color }} />
                <span className="tooltip-value">{fmt(s.values[active] ?? 0)}</span>
                <span className="tooltip-name">{s.label}</span>
              </div>
            ))}
            {notes?.[active]?.map((line) => (
              <div className="tooltip-name" key={line}>
                {line}
              </div>
            ))}
            {markerText.has(active) && <div className="tooltip-name">{markerText.get(active)}</div>}
          </div>
        )}
      </div>
      <details className="data-table">
        <summary>Show as table</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th />
                {series.map((s) => (
                  <th key={s.key} className="num">
                    {s.label}
                  </th>
                ))}
                {series.length > 1 && <th className="num">Total</th>}
              </tr>
            </thead>
            <tbody>
              {labels.map((label, i) => (
                <tr key={label}>
                  <td>
                    {label}
                    {markerText.has(i) && <span className="muted"> · {markerText.get(i)}</span>}
                  </td>
                  {series.map((s) => (
                    <td key={s.key} className="num">
                      {format === "usd" ? usd(s.values[i] ?? 0) : integer(s.values[i] ?? 0)}
                    </td>
                  ))}
                  {series.length > 1 && <td className="num">{format === "usd" ? usd(totals[i]) : integer(totals[i])}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
