"use client";

import { useEffect, useRef, useState } from "react";
import { integer, tokens, usd } from "../lib/format";

export interface ChartSeries {
  key: string;
  label: string;
  /** CSS color, normally a categorical token such as var(--series-1). */
  color: string;
  values: number[];
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
  height?: number;
  ariaLabel: string;
}

const MARGIN = { top: 8, right: 4, bottom: 24, left: 52 };
const GAP = 2; // surface gap between stacked segments
const RADIUS = 4;

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

/** Rect with only the top corners rounded: data-end rounded, baseline square. */
function topRoundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

export function StackedBarChart({ labels, ticks, series, format, notes, height = 220, ariaLabel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const fmt = formatters[format];

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const n = labels.length;
  const totals = labels.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const { top, step } = niceScale(Math.max(0, ...totals));
  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const band = n ? plotW / n : 0;
  const barW = Math.max(1, Math.min(24, band * 0.7));
  const y = (v: number) => MARGIN.top + plotH - (v / top) * plotH;
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
            {axisTicks.map((t) => (
              <g key={t}>
                <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--baseline)" : "var(--grid)"} strokeWidth={1} shapeRendering="crispEdges" />
                <text className="chart-tick" x={MARGIN.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                  {fmt(t)}
                </text>
              </g>
            ))}
            {labels.map((label, i) => {
              const x = MARGIN.left + band * i + (band - barW) / 2;
              let base = 0;
              const visible = series.filter((s) => (s.values[i] ?? 0) > 0);
              return (
                <g
                  key={label}
                  className="chart-col"
                  tabIndex={0}
                  aria-label={`${label}: ${fmt(totals[i])}`}
                  onPointerEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                >
                  <rect
                    className="chart-hit"
                    x={MARGIN.left + band * i}
                    y={MARGIN.top}
                    width={band}
                    height={plotH}
                    fill={active === i ? "var(--hover)" : "transparent"}
                  />
                  {visible.map((s, j) => {
                    const v = s.values[i];
                    const y0 = y(base);
                    base += v;
                    const y1 = y(base);
                    const isTop = j === visible.length - 1;
                    // Leave a surface gap below every segment that sits on another one.
                    const gap = j > 0 ? GAP : 0;
                    const h = Math.max(1, y0 - y1 - gap);
                    return isTop ? (
                      <path key={s.key} d={topRoundedRect(x, y0 - gap - h, barW, h, RADIUS)} fill={s.color} />
                    ) : (
                      <rect key={s.key} x={x} y={y0 - gap - h} width={barW} height={h} fill={s.color} />
                    );
                  })}
                  {i % tickEvery === 0 && (
                    <text className="chart-tick" x={MARGIN.left + band * i + band / 2} y={height - 6} textAnchor="middle">
                      {(ticks ?? labels)[i]}
                    </text>
                  )}
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
                  <td>{label}</td>
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
