"use client";

import { useRouter } from "next/navigation";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ActionCategory, ActivityAction, ActivityAgent, ActivityMarker } from "../../../src/store/activity";
import { clock, duration } from "../../lib/format";
import { agentColor, CATEGORIES, CATEGORY_COLOR, CATEGORY_LABEL, eventHref } from "./categories";
import { actionKey, uniqueKeys } from "./selection";
import { timeScale, timeTicks } from "./timeScale";

interface Props {
  agents: ActivityAgent[];
  actions: ActivityAction[];
  markers: ActivityMarker[];
  /** Action indices to draw; null draws all. */
  selected: Set<number> | null;
  /** Lane to emphasize when filtering by agent. */
  focusAgent: number | null;
}

type Band = ActionCategory | "error";

/** One drawn mark: every visible action of a lane falling into the same few-pixel column, or a prompt/error marker. */
type Item =
  | { kind: "bin"; agent: number; x: number; actions: number[]; counts: [Band, number][] }
  | { kind: "marker"; agent: number; x: number; marker: number };

const AXIS_H = 26;
const LANE_H = 28;
const LABEL_W = 184;
const PAD_R = 12;
/** Column width: actions closer than this in one lane share a stacked mark. */
const BIN = 4;
const MARK_H = 14;
const MARK_MAX = 22;
const INDENT = 12;

const ORDER = Object.fromEntries(CATEGORIES.map((c, i) => [c.key, i])) as Record<Band, number>;

export function TimeGraph({ agents, actions, markers, selected, focusAgent }: Props) {
  const router = useRouter();
  const uid = useId().replace(/:/g, "");
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // Hover and keyboard focus by mark key (first call or marker by agent id and seq): a live refresh can insert calls anywhere.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const height = AXIS_H + agents.length * LANE_H + 6;
  const plotX0 = LABEL_W + 8;
  const plotW = Math.max(0, width - plotX0 - PAD_R);
  const laneTop = (agent: number) => AXIS_H + agent * LANE_H;
  const laneMid = (agent: number) => laneTop(agent) + LANE_H / 2;

  const scale = useMemo(() => {
    const times: number[] = [];
    for (const a of agents) times.push(a.startedAt, a.endedAt);
    for (const a of actions) times.push(a.ts);
    for (const m of markers) times.push(m.ts);
    return timeScale(times, plotX0, plotW);
  }, [agents, actions, markers, plotX0, plotW]);

  const ticks = useMemo(() => timeTicks(scale, 72, -new Date().getTimezoneOffset() * 60_000), [scale]);

  const items = useMemo(() => {
    const lanes: Item[][] = agents.map(() => []);
    const bins: Map<number, Item & { kind: "bin" }>[] = agents.map(() => new Map());
    actions.forEach((a, i) => {
      if (selected && !selected.has(i)) return;
      const col = Math.floor((scale.x(a.ts) - plotX0) / BIN);
      let bin = bins[a.agent].get(col);
      if (!bin) {
        bin = { kind: "bin", agent: a.agent, x: plotX0 + col * BIN, actions: [], counts: [] };
        bins[a.agent].set(col, bin);
        lanes[a.agent].push(bin);
      }
      bin.actions.push(i);
      const band: Band = a.error ? "error" : a.cat;
      const entry = bin.counts.find((c) => c[0] === band);
      if (entry) entry[1]++;
      else bin.counts.push([band, 1]);
    });
    markers.forEach((m, i) => lanes[m.agent].push({ kind: "marker", agent: m.agent, x: scale.x(m.ts), marker: i }));
    for (const lane of lanes) {
      lane.sort((p, q) => p.x - q.x || (p.kind === q.kind ? 0 : p.kind === "bin" ? -1 : 1));
      for (const item of lane) if (item.kind === "bin") item.counts.sort((p, q) => ORDER[p[0]] - ORDER[q[0]]);
    }
    return lanes.flat();
  }, [agents, actions, markers, selected, scale, plotX0]);

  /** Per mark, by its first call or its marker event; also the React key, so a refresh keeps the focused mark's element. */
  const keys = useMemo(
    () =>
      uniqueKeys(
        items.map((item) =>
          item.kind === "bin" ? `b\n${actionKey(agents, actions[item.actions[0]])}` : `m\n${actionKey(agents, markers[item.marker])}`,
        ),
      ),
    [items, agents, actions, markers],
  );
  const find = (key: string | null) => (key === null ? -1 : keys.indexOf(key));
  const current = Math.max(0, find(focusKey));
  const active = find(activeKey);

  const hrefOf = (item: Item): string => {
    if (item.kind === "marker") return eventHref(agents[item.agent], markers[item.marker].seq);
    const first = actions[item.actions[0]];
    return eventHref(agents[first.agent], first.seq);
  };

  const describe = (item: Item): string => {
    const agent = agents[item.agent].title;
    if (item.kind === "marker") {
      const m = markers[item.marker];
      return `${m.kind === "prompt" ? "Prompt" : "Error"} at ${clock(m.ts)} in ${agent}: ${m.label}`;
    }
    if (item.actions.length === 1) {
      const a = actions[item.actions[0]];
      return `${clock(a.ts)} ${agent}: ${a.tool} ${a.label}${a.error ? ", failed" : ""}`;
    }
    const first = actions[item.actions[0]];
    const last = actions[item.actions.at(-1)!];
    return `${item.actions.length} tool calls ${clock(first.ts)} to ${clock(last.ts)} in ${agent}`;
  };

  const moveFocus = (next: number) => {
    if (next < 0 || next >= items.length) return;
    setFocusKey(keys[next]);
    document.getElementById(`${uid}-m-${next}`)?.focus();
  };

  const onKey = (e: KeyboardEvent, index: number) => {
    const item = items[index];
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      router.push(hrefOf(item));
    } else if (e.key === "ArrowRight" && items[index + 1]?.agent === item.agent) {
      e.preventDefault();
      moveFocus(index + 1);
    } else if (e.key === "ArrowLeft" && items[index - 1]?.agent === item.agent) {
      e.preventDefault();
      moveFocus(index - 1);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      // Nearest mark in the next lane that has any.
      const dir = e.key === "ArrowDown" ? 1 : -1;
      for (let lane = item.agent + dir; lane >= 0 && lane < agents.length; lane += dir) {
        let best = -1;
        items.forEach((it, i) => {
          if (it.agent === lane && (best < 0 || Math.abs(it.x - item.x) < Math.abs(items[best].x - item.x))) best = i;
        });
        if (best >= 0) return moveFocus(best);
      }
    } else if (e.key === "Home") {
      e.preventDefault();
      moveFocus(items.findIndex((it) => it.agent === item.agent));
    } else if (e.key === "End") {
      e.preventDefault();
      moveFocus(items.findLastIndex((it) => it.agent === item.agent));
    }
  };

  const tip = active !== -1 ? items[active] : undefined;

  return (
    <div className="tg">
      <div className="chart-legend" aria-hidden="true">
        {CATEGORIES.map((c) => (
          <span key={c.key}>
            <span className="swatch" style={{ background: c.color }} />
            {c.label}
          </span>
        ))}
        <span>
          <span className="tg-legend-prompt" />
          prompt
        </span>
      </div>
      <div ref={ref} className="tg-plot" style={{ height }} onPointerLeave={() => setActiveKey(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="group" aria-label="Tool calls over time, one lane per agent">
            <defs>
              <pattern id={`${uid}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" className="tg-hatch" />
              </pattern>
            </defs>
            {ticks.map((t) => (
              <g key={t.ts} aria-hidden="true">
                <line x1={t.x} x2={t.x} y1={AXIS_H - 6} y2={height} className="tg-grid" shapeRendering="crispEdges" />
                {/* A tick label (about 32px wide, starting at x + 3) gives way to an idle-break label it would overlap. */}
                {!scale.breaks.some((b) => Math.abs((b.x0 + b.x1) / 2 - (t.x + 19)) < 28) && (
                  <text className="chart-tick" x={t.x + 3} y={13}>
                    {clock(t.ts).slice(0, 5)}
                  </text>
                )}
              </g>
            ))}
            {scale.breaks.map((b) => (
              <g key={b.from} aria-hidden="true">
                <rect x={b.x0 + 2} y={AXIS_H - 6} width={Math.max(0, b.x1 - b.x0 - 4)} height={height - AXIS_H + 6} fill={`url(#${uid}-hatch)`} />
                <text className="chart-tick tg-break-label" x={(b.x0 + b.x1) / 2} y={13} textAnchor="middle">
                  <title>{`Idle ${duration(b.to - b.from)}`}</title>
                  {duration(b.to - b.from).split(" ")[0]}
                </text>
              </g>
            ))}
            {agents.map((a, i) => {
              const href = `/sessions/${encodeURIComponent(a.id)}`;
              const indent = a.depth * INDENT;
              const maxChars = Math.max(4, Math.floor((LABEL_W - 22 - indent) / 6.6));
              const title = a.title.length > maxChars ? `${a.title.slice(0, maxChars - 1)}…` : a.title;
              return (
                <g key={a.id} className={focusAgent !== null && focusAgent !== i ? "tg-lane tg-dim" : "tg-lane"}>
                  {i % 2 === 1 && <rect x={0} y={laneTop(i)} width={width} height={LANE_H} className="tg-band" />}
                  <line x1={scale.x(a.startedAt)} x2={Math.max(scale.x(a.endedAt), scale.x(a.startedAt) + 1)} y1={laneMid(i)} y2={laneMid(i)} className="tg-life" />
                  <a
                    href={href}
                    onClick={(e) => {
                      e.preventDefault();
                      router.push(href);
                    }}
                    aria-label={`Open ${a.depth ? "subagent" : "session"} ${a.title}`}
                  >
                    <title>{a.title}</title>
                    {a.depth > 0 && <path d={`M${indent - 6} ${laneTop(i)} V${laneMid(i)} H${indent - 1}`} className="tg-tree" />}
                    <rect x={indent + 2} y={laneMid(i) - 4} width={8} height={8} rx={2} fill={agentColor(a)} />
                    <text x={indent + 15} y={laneMid(i)} dy="0.32em" className={focusAgent === i ? "tg-agent tg-agent-on" : "tg-agent"}>
                      {title}
                    </text>
                  </a>
                </g>
              );
            })}
            {agents.map((a, i) => {
              if (a.spawn === null || a.parent === null || !actions[a.spawn]) return null;
              const x1 = scale.x(actions[a.spawn].ts);
              const y1 = laneMid(a.parent);
              const x2 = scale.x(a.startedAt);
              const y2 = laneMid(i);
              const my = (y1 + y2) / 2;
              return (
                <g key={a.id} className="tg-spawn" aria-hidden="true">
                  <path d={`M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`} />
                  <circle cx={x2} cy={y2} r={2.5} />
                </g>
              );
            })}
            {items.map((item, index) => {
              const top = laneTop(item.agent);
              const common = {
                id: `${uid}-m-${index}`,
                tabIndex: index === current ? 0 : -1,
                role: "link",
                "aria-label": describe(item),
                onPointerEnter: () => setActiveKey(keys[index]),
                onFocus: () => {
                  setFocusKey(keys[index]);
                  setActiveKey(keys[index]);
                },
                onBlur: () => setActiveKey(null),
                onClick: () => router.push(hrefOf(item)),
                onKeyDown: (e: KeyboardEvent) => onKey(e, index),
              };
              if (item.kind === "marker") {
                const m = markers[item.marker];
                return (
                  <g key={keys[index]} className={`tg-mark tg-marker-${m.kind}`} {...common}>
                    <rect x={item.x - 4} y={top} width={8} height={LANE_H} className="tg-hit" />
                    {m.kind === "prompt" ? (
                      <>
                        <line x1={item.x} x2={item.x} y1={top + 7} y2={top + LANE_H - 2} />
                        <path d={`M${item.x - 4} ${top + 1}H${item.x + 4}L${item.x} ${top + 7}Z`} />
                      </>
                    ) : (
                      <circle cx={item.x} cy={top + LANE_H - 5} r={3.5} />
                    )}
                  </g>
                );
              }
              const n = item.actions.length;
              const h = Math.min(MARK_MAX, n === 1 ? (item.counts[0][0] === "error" ? 18 : MARK_H) : MARK_H + 2.5 * Math.log2(n));
              let y = top + LANE_H / 2 + h / 2;
              return (
                <g key={keys[index]} className="tg-mark" {...common}>
                  <rect x={item.x} y={top} width={BIN} height={LANE_H} className="tg-hit" />
                  {item.counts.map(([band, count]) => {
                    const sh = Math.max(1, (h * count) / n);
                    y -= sh;
                    return <rect key={band} x={item.x + 0.5} y={y} width={BIN - 1} height={sh} fill={CATEGORY_COLOR[band]} />;
                  })}
                </g>
              );
            })}
          </svg>
        )}
        {tip && <Tooltip item={tip} agents={agents} actions={actions} markers={markers} width={width} top={laneTop(tip.agent) + LANE_H + 2} />}
      </div>
    </div>
  );
}

function Tooltip({
  item,
  agents,
  actions,
  markers,
  width,
  top,
}: {
  item: Item;
  agents: ActivityAgent[];
  actions: ActivityAction[];
  markers: ActivityMarker[];
  width: number;
  top: number;
}) {
  const left = Math.min(Math.max(0, item.x - 100), Math.max(0, width - 280));
  const agent = agents[item.agent];
  let body: ReactNode;
  if (item.kind === "marker") {
    const m = markers[item.marker];
    body = (
      <>
        <div className="tooltip-title">
          {clock(m.ts)} · {agent.title}
        </div>
        <div className="tooltip-row">
          <span className="tooltip-value">{m.kind === "prompt" ? "Prompt" : "Error"}</span>
        </div>
        {m.label && <div className="tooltip-name tg-tip-label">{m.label}</div>}
      </>
    );
  } else if (item.actions.length === 1) {
    const a = actions[item.actions[0]];
    body = (
      <>
        <div className="tooltip-title">
          {clock(a.ts)} · {agent.title}
        </div>
        <div className="tooltip-row">
          <span className="tooltip-key" style={{ background: CATEGORY_COLOR[a.error ? "error" : a.cat] }} />
          <span className="tooltip-value">{a.tool}</span>
          {a.error && <span className="error-text">failed</span>}
        </div>
        {a.label && <div className="tooltip-name tg-tip-label">{a.label}</div>}
      </>
    );
  } else {
    const first = actions[item.actions[0]];
    const last = actions[item.actions.at(-1)!];
    body = (
      <>
        <div className="tooltip-title">
          {clock(first.ts)}–{clock(last.ts)} · {agent.title}
        </div>
        <div className="tooltip-row">
          <span className="tooltip-value">{item.actions.length}</span>
          <span className="tooltip-name">tool calls</span>
        </div>
        {item.counts.map(([band, count]) => (
          <div className="tooltip-row" key={band}>
            <span className="tooltip-key" style={{ background: CATEGORY_COLOR[band] }} />
            <span className="tooltip-value">{count}</span>
            <span className="tooltip-name">{CATEGORY_LABEL[band]}</span>
          </div>
        ))}
        {item.actions.slice(0, 3).map((i) => (
          <div className="tooltip-name tg-tip-label" key={i}>
            {actions[i].tool} {actions[i].label}
          </div>
        ))}
        {item.actions.length > 3 && <div className="tooltip-name">…click opens the first</div>}
      </>
    );
  }
  return (
    <div className="tooltip tg-tip" style={{ left, top }} role="status">
      {body}
    </div>
  );
}
