"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { integer, tokens, usd } from "../lib/format";
import { columnForKey } from "./chart/nav";

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
  /**
   * Optional link per column: clicking the column or pressing Enter on it opens the link, and the table view links
   * its rows. Columns without one stay inert, so a partly linkable chart is fine.
   */
  hrefs?: (string | undefined)[];
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

export function StackedBarChart({ labels, ticks, series, format, notes, markers = [], hrefs, height = 220, ariaLabel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
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
  const linked = hrefs?.some(Boolean) ?? false;
  // The component survives navigations that keep it mounted (a day link on the errors chart narrows its own page), so
  // a selection from the longer previous axis must never reach the tooltip or the geometry below.
  const shown = active !== null && active >= 0 && active < n ? active : null;

  const tooltipLeft = shown === null ? 0 : Math.min(Math.max(0, MARGIN.left + band * shown + band / 2 - 80), Math.max(0, width - 180));
  // One line per column for the live region; it stays mounted so the first column is announced too.
  const announcement =
    shown === null
      ? ""
      : [
          labels[shown],
          ...(series.length > 1 ? [`${fmt(totals[shown])} total`] : []),
          ...series.map((s) => `${s.label} ${fmt(s.values[shown] ?? 0)}`),
          ...(notes?.[shown] ?? []),
          ...(markerText.has(shown) ? [String(markerText.get(shown))] : []),
        ].join(", ");

  /** Plain left clicks navigate inside the app; modified clicks stay with the browser (new tab, download, …). */
  const open = (e: React.MouseEvent, href: string) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    router.push(href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const href = shown === null ? undefined : hrefs?.[shown];
    if (href && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      router.push(href);
      return;
    }
    const next = columnForKey(e.key, shown, n);
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  };

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
      {/* One tab stop for the whole chart: the columns are read with the arrow keys, and a live region inside the plot
          repeats what the tooltip shows. The drawing itself is hidden from assistive technology; its numbers are in
          this label, that live region and the table view. */}
      <div
        ref={ref}
        className="chart-plot"
        style={{ height, position: "relative" }}
        tabIndex={n ? 0 : -1}
        role="group"
        aria-label={`${ariaLabel}. ${n} ${n === 1 ? "column" : "columns"}; left and right arrow keys read them${linked ? ", Enter opens the selected one" : ""}.`}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setActive(null);
        }}
        onPointerLeave={() => setActive(null)}
      >
        {width > 0 && (
          <svg width={width} height={height} aria-hidden="true">
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
            {labels.map((_, i) => {
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
              const href = hrefs?.[i];
              const column = (
                <>
                  <rect
                    className="chart-hit"
                    x={MARGIN.left + band * i}
                    y={marginTop}
                    width={band}
                    height={plotH}
                    fill={shown === i ? "var(--hover)" : "transparent"}
                  />
                  <g mask={`url(#${maskId})`}>
                    {segments.map((seg) => seg.h > 0 && <rect key={seg.key} x={x} y={seg.y} width={w} height={seg.h} fill={seg.color} />)}
                  </g>
                  {i % tickEvery === 0 && (
                    <text className="chart-tick" x={MARGIN.left + band * i + band / 2} y={height - 6} textAnchor="middle">
                      {(ticks ?? labels)[i]}
                    </text>
                  )}
                </>
              );
              // Index keys: labels repeat ("Mon 6 Oct" one year apart, "Request 1" per agent).
              const cls = `chart-col${shown === i ? " chart-col-active" : ""}`;
              return href ? (
                // A real link, so the browser's own "open in new tab" works; tabIndex -1 keeps the single tab stop.
                <a key={i} className={`${cls} chart-link`} href={href} tabIndex={-1} onPointerEnter={() => setActive(i)} onClick={(e) => open(e, href)}>
                  {column}
                </a>
              ) : (
                <g key={i} className={cls} onPointerEnter={() => setActive(i)}>
                  {column}
                </g>
              );
            })}
            {markers.map((m, i) => {
              const mx = Math.round(MARGIN.left + band * m.index) + 0.5;
              const right = mx > width - 64;
              return (
                <g key={i} pointerEvents="none">
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
        {shown !== null && (
          <div className="tooltip" style={{ left: tooltipLeft, top: Math.max(0, y(totals[shown]) - 12) }}>
            <div className="tooltip-title">{labels[shown]}</div>
            {series.length > 1 && (
              <div className="tooltip-row">
                <span className="tooltip-value">{fmt(totals[shown])}</span>
                <span className="tooltip-name">total</span>
              </div>
            )}
            {series.map((s) => (
              <div className="tooltip-row" key={s.key}>
                <span className="tooltip-key" style={{ background: s.color }} />
                <span className="tooltip-value">{fmt(s.values[shown] ?? 0)}</span>
                <span className="tooltip-name">{s.label}</span>
              </div>
            ))}
            {notes?.[shown]?.map((line, i) => (
              <div className="tooltip-name" key={i}>
                {line}
              </div>
            ))}
            {markerText.has(shown) && <div className="tooltip-name">{markerText.get(shown)}</div>}
          </div>
        )}
        {/* Mounted for as long as the chart is: a live region that only appears with its text is announced late or not at all. */}
        <div className="chart-sr" role="status">
          {announcement}
        </div>
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
              {labels.map((label, i) => {
                const href = hrefs?.[i];
                return (
                  <tr key={i}>
                    <td>
                      {href ? (
                        <Link className="row-link" href={href}>
                          {label}
                        </Link>
                      ) : (
                        label
                      )}
                      {markerText.has(i) && <span className="muted"> · {markerText.get(i)}</span>}
                    </td>
                    {series.map((s) => (
                      <td key={s.key} className="num">
                        {format === "usd" ? usd(s.values[i] ?? 0) : integer(s.values[i] ?? 0)}
                      </td>
                    ))}
                    {series.length > 1 && <td className="num">{format === "usd" ? usd(totals[i]) : integer(totals[i])}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
