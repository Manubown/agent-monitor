"use client";

import { useState } from "react";
import { type HeatDay, type Heatmap, heatLevels } from "../../../src/core/heatmap";
import { integer, usd } from "../../lib/format";
import "../../insights.css";

type Metric = "events" | "cost" | "sessions";

const METRICS: { key: Metric; label: string }[] = [
  { key: "events", label: "Events" },
  { key: "cost", label: "Cost" },
  { key: "sessions", label: "Sessions" },
];

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Pixel pitch: CELL - GAP px squares with GAP px gaps. */
const CELL = 14;
const GAP = 2;
const LEFT = 32;
const TOP = 16;

interface Tip {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

/** "Mon 5 Oct 2026" from YYYY-MM-DD without time zone conversion. */
function dayLabel(day: string, weekday: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${WEEKDAYS[weekday]} ${d} ${MONTHS[m - 1]} ${y}`;
}

const fmt = (metric: Metric, v: number | null): string => (metric === "cost" ? usd(v) : integer(v ?? 0));

/** Each line of a tooltip, the selected metric first. */
function tipLines(values: Record<Metric, number | null>, metric: Metric, sessionsLabel: string): string[] {
  const line: Record<Metric, string> = {
    events: `${integer(values.events ?? 0)} events`,
    sessions: `${integer(values.sessions ?? 0)} ${sessionsLabel}`,
    cost: `${usd(values.cost)} cost`,
  };
  return [line[metric], ...METRICS.filter((m) => m.key !== metric).map((m) => line[m.key])];
}

function Legend() {
  return (
    <span className="hm-legend" aria-hidden="true">
      less
      {[0, 1, 2, 3, 4].map((l) => (
        <span key={l} className={`hm-swatch hm-l${l}`} />
      ))}
      more
    </span>
  );
}

/**
 * Activity heatmap: a calendar (weeks x weekdays) and a weekday x hour-of-day grid, colored by the selected metric
 * (quantile levels of an accent ramp). Days and hours are the server's local time.
 */
export function ActivityHeatmap({ data, rangeNote, timeZone }: { data: Heatmap; rangeNote: string; timeZone: string }) {
  const [metric, setMetric] = useState<Metric>("events");
  const [tip, setTip] = useState<Tip | null>(null);

  const dayValue = (d: HeatDay): number | null => (d.inRange ? d[metric] : null);
  const dayLevels = heatLevels(data.days.map(dayValue));
  const hourValues = data.hours[metric];
  const hourLevels = heatLevels(hourValues);
  const weeksWide = LEFT + data.weeks * CELL;
  const calHeight = TOP + 7 * CELL;
  const hourWide = LEFT + 24 * CELL;
  const total = metric === "cost" ? usd(data.totals.cost) : integer(data.totals[metric] ?? 0);

  // Month labels: the first week in range gets its month, later weeks the month whose 1st they contain. A label too
  // close to the previous one replaces it, so the newer month wins.
  const months: { x: number; label: string }[] = [];
  for (let w = 0; w < data.weeks; w++) {
    const week = data.days.slice(w * 7, w * 7 + 7).filter((d) => d.inRange);
    const start = months.length === 0 ? week[0] : week.find((d) => d.day.endsWith("-01"));
    if (!start) continue;
    const label = { x: LEFT + w * CELL, label: MONTHS[Number(start.day.slice(5, 7)) - 1] };
    if (months.length > 0 && label.x - months[months.length - 1].x < 3 * CELL) months.pop();
    months.push(label);
  }

  const show = (e: React.PointerEvent<SVGRectElement>, title: string, lines: string[]) => {
    const box = e.currentTarget.closest(".hm")!.getBoundingClientRect();
    const cell = e.currentTarget.getBoundingClientRect();
    setTip({ x: cell.left - box.left + cell.width / 2, y: cell.top - box.top, title, lines });
  };

  return (
    <section className="card" aria-labelledby="activity-heatmap">
      <div className="card-head">
        <h2 id="activity-heatmap">Activity</h2>
        <span className="muted">
          {rangeNote} · {timeZone} time · {total} {metric === "cost" ? "total" : metric}
        </span>
        <div className="hm-toggle" role="group" aria-label="Heatmap metric">
          {METRICS.map((m) => (
            <button key={m.key} type="button" aria-pressed={metric === m.key} onClick={() => setMetric(m.key)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="hm" onPointerLeave={() => setTip(null)}>
        <figure className="hm-panel">
          <figcaption className="muted">By day</figcaption>
          <div className="hm-scroll">
            <svg
              width={weeksWide}
              height={calHeight}
              role="img"
              aria-label={`${METRICS.find((m) => m.key === metric)!.label} per day, ${data.firstDay} to ${data.lastDay}`}
            >
              {months.map((m) => (
                <text key={m.x} className="chart-tick" x={m.x} y={10}>
                  {m.label}
                </text>
              ))}
              {[0, 2, 4].map((w) => (
                <text key={w} className="chart-tick" x={0} y={TOP + w * CELL + CELL / 2} dy="0.32em">
                  {WEEKDAYS[w]}
                </text>
              ))}
              {data.days.map((d, i) => (
                <rect
                  key={d.day}
                  className={d.inRange ? `hm-cell hm-l${dayLevels[i]}` : "hm-cell hm-out"}
                  x={LEFT + Math.floor(i / 7) * CELL}
                  y={TOP + d.weekday * CELL}
                  width={CELL - GAP}
                  height={CELL - GAP}
                  shapeRendering="crispEdges"
                  onPointerEnter={d.inRange ? (e) => show(e, dayLabel(d.day, d.weekday), tipLines(d, metric, "sessions")) : () => setTip(null)}
                />
              ))}
            </svg>
          </div>
        </figure>
        <figure className="hm-panel">
          <figcaption className="muted">By weekday and hour</figcaption>
          <div className="hm-scroll">
            <svg width={hourWide} height={calHeight} role="img" aria-label={`${METRICS.find((m) => m.key === metric)!.label} by weekday and hour of day`}>
              {[0, 6, 12, 18].map((h) => (
                <text key={h} className="chart-tick" x={LEFT + h * CELL} y={10}>
                  {String(h).padStart(2, "0")}
                </text>
              ))}
              {WEEKDAYS.map((label, w) => (
                <text key={label} className="chart-tick" x={0} y={TOP + w * CELL + CELL / 2} dy="0.32em">
                  {label}
                </text>
              ))}
              {hourValues.map((_, i) => {
                const w = Math.floor(i / 24);
                const h = i % 24;
                return (
                  <rect
                    key={i}
                    className={`hm-cell hm-l${hourLevels[i]}`}
                    x={LEFT + h * CELL}
                    y={TOP + w * CELL}
                    width={CELL - GAP}
                    height={CELL - GAP}
                    shapeRendering="crispEdges"
                    onPointerEnter={(e) =>
                      show(
                        e,
                        `${WEEKDAYS[w]}s ${String(h).padStart(2, "0")}:00–${String(h + 1).padStart(2, "0")}:00`,
                        tipLines({ events: data.hours.events[i], sessions: data.hours.sessions[i], cost: data.hours.cost[i] }, metric, "session-hours"),
                      )
                    }
                  />
                );
              })}
            </svg>
          </div>
        </figure>
        {tip && (
          <div className="tooltip hm-tip" style={{ left: tip.x, top: tip.y }} role="status">
            <div className="tooltip-title">{tip.title}</div>
            {tip.lines.map((line, i) => (
              <div key={line} className={i === 0 ? "tooltip-value" : "tooltip-name"}>
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="hm-foot">
        <Legend />
        <span className="muted">Sessions: distinct sessions with events, subagent runs counted with their parent.</span>
      </div>
      <details className="data-table">
        <summary>Show as table</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Events</th>
                <th className="num">Sessions</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.days
                .filter((d) => d.inRange && (d.events > 0 || d.cost !== null))
                .map((d) => (
                  <tr key={d.day}>
                    <td>{dayLabel(d.day, d.weekday)}</td>
                    <td className="num">{integer(d.events)}</td>
                    <td className="num">{integer(d.sessions)}</td>
                    <td className="num">{usd(d.cost)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th />
                {Array.from({ length: 24 }, (_, h) => (
                  <th key={h} className="num">
                    {String(h).padStart(2, "0")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {WEEKDAYS.map((label, w) => (
                <tr key={label}>
                  <td>{label}</td>
                  {Array.from({ length: 24 }, (_, h) => (
                    <td key={h} className="num">
                      {fmt(metric, hourValues[w * 24 + h])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
