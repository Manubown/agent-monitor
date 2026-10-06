"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ActivityAction, ActivityAgent } from "../../../src/store/activity";
import type { SessionFlame } from "../../../src/store/flame";
import { clock, duration, integer, tokens, usd } from "../../lib/format";
import { agentColor, CATEGORIES, CATEGORY_COLOR, CATEGORY_LABEL, eventHref } from "./categories";
import { type Band, type CostBox, callEnds, costLayout, dominantBand, issuedBy, mergeThin, packTracks, subtreeCosts, subtreeEnd } from "./flameLayout";
import { type TimeScale, timeScale, timeTicks } from "./timeScale";
import "../../flame.css";

interface Props {
  agents: ActivityAgent[];
  actions: ActivityAction[];
  flame: SessionFlame;
}

type ColorBy = "tool" | "cost";
type WidthBy = "time" | "cost";

/** One drawn, focusable mark: an agent bar, or one or more merged tool calls / model requests of an agent. */
type Item = { agent: number; x0: number; x1: number; y: number; h: number } & (
  | { kind: "agent" }
  | { kind: "calls"; items: number[] }
  | { kind: "requests"; items: number[] }
);

const AXIS_H = 22;
const BAR_H = 18;
const TOOL_H = 14;
const ROW_GAP = 2;
const TRACK_H = BAR_H + ROW_GAP + TOOL_H + 6;
/** Narrowest an agent bar is drawn in the time layout. */
const MIN_AGENT_PX = 3;
/** Parallel calls of one agent stack in at most this many thin rows. */
const MAX_CALL_TRACKS = 3;
const CHAR_W = 6.2;
const TIP_W = 300;

/** Cost shading: from a faint to a strong mix of one series color into the surface; square root so cheap items stay visible. */
const ramp = (share: number): string =>
  `color-mix(in oklab, var(--series-7) ${Math.round(12 + 63 * Math.sqrt(Math.min(1, Math.max(0, share))))}%, var(--surface))`;
const NEUTRAL = "var(--baseline)";
const REPLY = "var(--kind-system)";

const clipText = (s: string, px: number): string => {
  const max = Math.floor(px / CHAR_W);
  if (max < 3) return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

const costText = (cost: number | null, source: string): string =>
  cost === null ? "unpriced" : `${usd(cost)}${source === "estimated" || source === "mixed" ? " est." : source === "partial" ? " partial" : ""}`;

/**
 * "Flame": the session tree as an icicle. Each agent is a bar under its spawner (x = time, or = cost share in the
 * cost layout), with its tool calls (or, by cost, its model requests) as blocks below the bar.
 */
export function FlameGraph({ agents, actions, flame }: Props) {
  const router = useRouter();
  const uid = useId().replace(/:/g, "");
  const ref = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const [width, setWidth] = useState(0);
  const [colorBy, setColorBy] = useState<ColorBy>("tool");
  const [widthBy, setWidthBy] = useState<WidthBy>("time");
  const [root, setRoot] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const [tipX, setTipX] = useState(0);
  const [focusIndex, setFocusIndex] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Everything that does not depend on the view.
  const data = useMemo(() => {
    const { costs, results, requests } = flame;
    const ends = callEnds(actions, results, agents.map((a) => a.endedAt));
    const byAgent: number[][] = agents.map(() => []);
    actions.forEach((a, i) => byAgent[a.agent].push(i));
    const callTrack: number[] = new Array(actions.length).fill(0);
    const callTracks = byAgent.map((list) => {
      const { track, count } = packTracks(list.map((i) => ({ start: actions[i].ts, end: ends[i] })), MAX_CALL_TRACKS);
      for (const [k, a] of list.entries()) callTrack[a] = track[k];
      return Math.max(1, count);
    });
    const reqByAgent: number[][] = agents.map(() => []);
    requests.forEach((r, i) => reqByAgent[r.agent].push(i));
    const issuer = issuedBy(actions, requests);
    const issued: number[][] = requests.map(() => []);
    for (const [a, r] of issuer.entries()) if (r !== null) issued[r].push(a);
    const own = costs.map((c) => c.cost);
    const totals = subtreeCosts(agents, own);
    const maxAgent = Math.max(0, ...own.map((c) => c ?? 0));
    const maxRequest = Math.max(0, ...requests.map((r) => r.cost ?? 0));
    return { ends, byAgent, callTrack, callTracks, reqByAgent, issuer, issued, totals, maxAgent, maxRequest };
  }, [agents, actions, flame]);

  const band = (i: number): Band => (actions[i].error ? "error" : actions[i].cat);
  const priced = data.totals[0] > 0;
  const byCost = widthBy === "cost" && priced;
  const shadeByCost = colorBy === "cost" && priced;

  const view = useMemo(() => {
    const end = subtreeEnd(agents, root);
    if (width <= 0) return { scale: null, items: [] as Item[], height: AXIS_H, hidden: 0, empty: false };
    let scale: TimeScale | null = null;
    let boxes: (CostBox | null)[];
    if (byCost) {
      boxes = costLayout(agents, flame.costs.map((c) => c.cost), root, 0, width);
    } else {
      const times: number[] = [];
      for (let i = root; i < end; i++) {
        times.push(agents[i].startedAt, agents[i].endedAt);
        for (const a of data.byAgent[i]) times.push(actions[a].ts, data.ends[a]);
      }
      const s = timeScale(times, 0, width);
      scale = s;
      boxes = agents.map((a, i) => {
        if (i < root || i >= end) return null;
        const x0 = s.x(a.startedAt);
        return { x0, x1: Math.max(s.x(a.endedAt), x0 + MIN_AGENT_PX), self: x0 };
      });
    }

    // Rows: one level per nesting depth; agents overlapping in time on a level get their own tracks.
    let hidden = 0;
    const levels = new Map<number, number[]>();
    for (let i = root; i < end; i++) {
      const b = boxes[i]!;
      if (b.x1 - b.x0 < 0.5) {
        hidden++;
        continue;
      }
      const list = levels.get(agents[i].depth);
      if (list) list.push(i);
      else levels.set(agents[i].depth, [i]);
    }
    const rowY: number[] = agents.map(() => 0);
    let y = AXIS_H;
    for (const depth of [...levels.keys()].sort((p, q) => p - q)) {
      const members = levels.get(depth)!;
      const { track, count } = byCost
        ? { track: members.map(() => 0), count: 1 }
        : packTracks(members.map((i) => ({ start: boxes[i]!.x0, end: boxes[i]!.x1 })), Number.POSITIVE_INFINITY, 2);
      for (const [k, i] of members.entries()) rowY[i] = y + track[k] * TRACK_H;
      y += count * TRACK_H;
    }

    const items: Item[] = [];
    for (let i = root; i < end; i++) {
      const b = boxes[i]!;
      if (b.x1 - b.x0 < 0.5) continue;
      items.push({ kind: "agent", agent: i, x0: b.x0, x1: b.x1, y: rowY[i], h: BAR_H });
      const top = rowY[i] + BAR_H + ROW_GAP;
      const blocks: Item[] = [];
      if (scale) {
        const k = data.callTracks[i];
        const th = (TOOL_H - (k - 1)) / k;
        const tracks: { x0: number; x1: number; index: number }[][] = Array.from({ length: k }, () => []);
        for (const a of data.byAgent[i]) tracks[data.callTrack[a]].push({ x0: scale.x(actions[a].ts), x1: scale.x(data.ends[a]), index: a });
        tracks.forEach((list, t) => {
          list.sort((p, q) => p.x0 - q.x0);
          for (const m of mergeThin(list)) blocks.push({ kind: "calls", agent: i, x0: m.x0, x1: m.x1, y: top + t * (th + 1), h: th, items: m.items });
        });
      } else {
        const reqs = data.reqByAgent[i].filter((r) => (flame.requests[r].cost ?? 0) > 0);
        const sum = reqs.reduce((s, r) => s + flame.requests[r].cost!, 0);
        let x = b.self;
        const list = reqs.map((r) => {
          const x0 = x;
          x += sum > 0 ? ((b.x1 - b.self) * flame.requests[r].cost!) / sum : 0;
          return { x0, x1: x, index: r };
        });
        for (const m of mergeThin(list)) blocks.push({ kind: "requests", agent: i, x0: m.x0, x1: m.x1, y: top, h: TOOL_H, items: m.items });
      }
      blocks.sort((p, q) => p.x0 - q.x0 || p.y - q.y);
      items.push(...blocks);
    }
    return { scale, items, height: y + 2, hidden, empty: byCost && data.totals[root] <= 0 };
  }, [agents, actions, flame, data, root, width, byCost]);

  const { items } = view;
  const current = Math.min(focusIndex, Math.max(0, items.length - 1));

  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    document.getElementById(`${uid}-i-0`)?.focus();
  }, [view, uid]);

  const ticks = useMemo(() => {
    if (view.scale) return timeTicks(view.scale, 72, -new Date().getTimezoneOffset() * 60_000).map((t) => ({ x: t.x, label: clock(t.ts).slice(0, 5) }));
    const total = data.totals[root];
    if (!byCost || total <= 0) return [];
    const n = Math.max(1, Math.min(4, Math.floor(width / 90)));
    return Array.from({ length: n }, (_, k) => ({ x: (width * k) / n, label: usd((total * k) / n) }));
  }, [view.scale, data.totals, root, byCost, width]);

  const zoom = (next: number) => {
    if (next === root) return;
    setRoot(next);
    setActive(null);
    setFocusIndex(0);
    refocus.current = true;
  };

  const activate = (item: Item) => {
    if (item.kind === "agent") return zoom(item.agent);
    const agent = agents[item.agent];
    if (item.kind === "calls") return router.push(eventHref(agent, actions[item.items[0]].seq));
    const seq = flame.requests[item.items[0]].seq;
    router.push(seq === null ? `/sessions/${encodeURIComponent(agent.id)}` : eventHref(agent, seq));
  };

  const moveFocus = (next: number) => {
    if (next < 0 || next >= items.length) return;
    setFocusIndex(next);
    document.getElementById(`${uid}-i-${next}`)?.focus();
  };

  const onKey = (e: KeyboardEvent, index: number) => {
    const step = (dir: 1 | -1, agentsOnly: boolean) => {
      for (let i = index + dir; i >= 0 && i < items.length; i += dir) if (!agentsOnly || items[i].kind === "agent") return moveFocus(i);
    };
    if (e.key === "Enter" || e.key === " ") activate(items[index]);
    else if (e.key === "ArrowRight") step(1, false);
    else if (e.key === "ArrowLeft") step(-1, false);
    else if (e.key === "ArrowDown") step(1, true);
    else if (e.key === "ArrowUp") step(-1, true);
    else if (e.key === "Home") moveFocus(0);
    else if (e.key === "End") moveFocus(items.length - 1);
    else if (e.key === "Escape" && agents[root].parent !== null) zoom(agents[root].parent!);
    else return;
    e.preventDefault();
  };

  const fillOf = (item: Item): string => {
    if (item.kind === "agent") {
      const c = flame.costs[item.agent].cost;
      if (!shadeByCost) return `color-mix(in srgb, ${agentColor(agents[item.agent])} 24%, var(--surface))`;
      return c === null ? `url(#${uid}-hatch)` : ramp(data.maxAgent > 0 ? c / data.maxAgent : 0);
    }
    if (item.kind === "calls") {
      if (!shadeByCost) return CATEGORY_COLOR[dominantBand(item.items.map(band)) ?? "other"];
      const costs = item.items.flatMap((a) => {
        const r = data.issuer[a];
        const c = r === null ? null : flame.requests[r].cost;
        return c === null ? [] : [c];
      });
      return costs.length && data.maxRequest > 0 ? ramp(Math.max(...costs) / data.maxRequest) : NEUTRAL;
    }
    if (shadeByCost) return ramp(data.maxRequest > 0 ? Math.max(...item.items.map((r) => flame.requests[r].cost ?? 0)) / data.maxRequest : 0);
    const b = dominantBand(item.items.flatMap((r) => data.issued[r].map(band)));
    return b ? CATEGORY_COLOR[b] : REPLY;
  };

  const describe = (item: Item): string => {
    const a = agents[item.agent];
    if (item.kind === "agent") {
      const c = flame.costs[item.agent];
      return `${a.depth ? "Subagent" : "Session"} ${a.title}, ${duration(a.endedAt - a.startedAt)}, ${costText(c.cost, c.costSource)}${item.agent !== root ? ". Zoom in" : ""}`;
    }
    if (item.kind === "calls") {
      if (item.items.length === 1) {
        const x = actions[item.items[0]];
        return `${clock(x.ts)} ${a.title}: ${x.tool} ${x.label}, ${duration(data.ends[item.items[0]] - x.ts)}${x.error ? ", failed" : ""}`;
      }
      return `${item.items.length} tool calls from ${clock(actions[item.items[0]].ts)} in ${a.title}`;
    }
    const r = flame.requests[item.items[0]];
    return item.items.length === 1
      ? `${clock(r.ts)} ${a.title}: model request, ${costText(r.cost, r.costSource)}`
      : `${item.items.length} model requests from ${clock(r.ts)} in ${a.title}`;
  };

  const crumbs: number[] = [];
  for (let i: number | null = root; i !== null; i = agents[i].parent) crumbs.unshift(i);

  const tip = active !== null ? items[active] : undefined;
  const legend: ReactNode = shadeByCost ? (
    <>
      <span>
        <span className="fg-ramp" style={{ background: `linear-gradient(to right, ${ramp(0)}, ${ramp(1)})` }} />
        {byCost ? "own cost per agent and request" : "agents by own cost, calls by the cost of the request that issued them"}
      </span>
      <span>
        <span className="swatch fg-unpriced" />
        unpriced
      </span>
    </>
  ) : (
    <>
      {CATEGORIES.map((c) => (
        <span key={c.key}>
          <span className="swatch" style={{ background: c.color }} />
          {c.label}
        </span>
      ))}
      {byCost && (
        <span>
          <span className="swatch" style={{ background: REPLY }} />
          reply, no tool call
        </span>
      )}
    </>
  );

  return (
    <div className="fg">
      <div className="fg-head">
        <div className="chart-legend" aria-hidden="true">
          {legend}
        </div>
        <div className="fg-controls">
          <Toggle
            label="Color by"
            value={colorBy}
            options={[
              ["tool", "tool type"],
              ["cost", "cost"],
            ]}
            disabled={!priced}
            onChange={setColorBy}
          />
          <Toggle
            label="Width by"
            value={widthBy}
            options={[
              ["time", "time"],
              ["cost", "cost"],
            ]}
            disabled={!priced}
            onChange={(v) => {
              setWidthBy(v);
              setActive(null);
            }}
          />
        </div>
      </div>
      {root !== 0 && (
        <nav className="fg-crumbs" aria-label="Zoom">
          {crumbs.map((i) =>
            i === root ? (
              <span key={i} className="fg-crumb-on" aria-current="true">
                {agents[i].title}
              </span>
            ) : (
              <button key={i} type="button" className="fg-crumb" onClick={() => zoom(i)}>
                {i === 0 ? "Whole session" : agents[i].title}
              </button>
            ),
          )}
          <Link href={`/sessions/${encodeURIComponent(agents[root].id)}`} className="fg-open">
            Open subagent →
          </Link>
        </nav>
      )}
      <div ref={ref} className="fg-plot" style={{ height: view.height }} onPointerLeave={() => setActive(null)}>
        {width > 0 && (
          <svg
            width={width}
            height={view.height}
            role="group"
            aria-label={`${byCost ? "Cost" : "Time"} flame of the agent tree. Arrow keys move, Enter zooms into an agent or opens a call, Escape zooms out.`}
          >
            <defs>
              <pattern id={`${uid}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" className="fg-hatch-bg" />
                <line x1="0" y1="0" x2="0" y2="6" className="fg-hatch" />
              </pattern>
            </defs>
            <g aria-hidden="true">
              {ticks.map((t) => (
                <g key={t.x}>
                  <line x1={t.x} x2={t.x} y1={AXIS_H - 6} y2={view.height} className="fg-grid" shapeRendering="crispEdges" />
                  {/* A label (about 40px) that would run past the right edge is left out. */}
                  {t.x + 43 <= width && (
                    <text className="chart-tick" x={t.x + 3} y={12}>
                      {t.label}
                    </text>
                  )}
                </g>
              ))}
              {view.scale?.breaks.map((b) => (
                <rect key={b.from} x={b.x0 + 2} y={AXIS_H - 6} width={Math.max(0, b.x1 - b.x0 - 4)} height={view.height - AXIS_H + 6} fill={`url(#${uid}-hatch)`}>
                  <title>{`Idle ${duration(b.to - b.from)}`}</title>
                </rect>
              ))}
            </g>
            <g key={`${root}-${widthBy}`} className="fg-view">
              {items.map((item, index) => {
                const w = Math.max(1, item.x1 - item.x0);
                const common = {
                  id: `${uid}-i-${index}`,
                  tabIndex: index === current ? 0 : -1,
                  role: item.kind === "agent" ? "button" : "link",
                  "aria-label": describe(item),
                  onPointerEnter: (e: PointerEvent) => {
                    setActive(index);
                    setTipX(e.clientX - (ref.current?.getBoundingClientRect().left ?? 0));
                  },
                  onFocus: () => {
                    setFocusIndex(index);
                    setActive(index);
                    setTipX((item.x0 + item.x1) / 2);
                  },
                  onBlur: () => setActive(null),
                  onClick: () => activate(item),
                  onKeyDown: (e: KeyboardEvent) => onKey(e, index),
                };
                if (item.kind !== "agent") {
                  const failed = !shadeByCost && item.kind === "calls" && item.items.some((a) => actions[a].error);
                  return (
                    <g key={`${item.kind}${item.agent}-${item.items[0]}`} className={failed ? "fg-block fg-failed" : "fg-block"} {...common}>
                      <rect x={item.x0} y={item.y} width={w} height={item.h} fill={fillOf(item)} shapeRendering="crispEdges" />
                    </g>
                  );
                }
                const a = agents[item.agent];
                const c = flame.costs[item.agent];
                const label = clipText(
                  `${a.title} · ${duration(a.endedAt - a.startedAt)} · ${costText(byCost ? data.totals[item.agent] : c.cost, c.costSource)}`,
                  w - 10,
                );
                return (
                  <g key={`a${item.agent}`} className={item.agent === root ? "fg-agent fg-root" : "fg-agent"} {...common}>
                    <rect x={item.x0} y={item.y} width={w} height={item.h} fill={fillOf(item)} className="fg-bar" shapeRendering="crispEdges" />
                    {!shadeByCost && <rect x={item.x0} y={item.y} width={Math.min(3, w)} height={item.h} fill={agentColor(a)} shapeRendering="crispEdges" />}
                    {label && (
                      <text x={item.x0 + 6} y={item.y + item.h / 2} dy="0.32em" className="fg-label">
                        {label}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        )}
        {view.empty && <p className="muted fg-empty">Nothing in this part of the tree could be priced.</p>}
        {tip && (
          <div className="tooltip fg-tip" style={{ left: Math.min(Math.max(0, tipX - 120), Math.max(0, width - TIP_W)), top: tip.y + tip.h + 4 }} role="status">
            <TipBody item={tip} agents={agents} actions={actions} flame={flame} data={data} root={root} byCost={byCost} />
          </div>
        )}
      </div>
      {byCost && !view.empty && view.hidden > 0 && (
        <p className="muted fg-note">
          {view.hidden} {view.hidden === 1 ? "agent has" : "agents have"} no priced cost and {view.hidden === 1 ? "is" : "are"} not drawn.
        </p>
      )}
    </div>
  );
}

function Toggle<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  disabled: boolean;
  onChange: (v: T) => void;
}) {
  return (
    <span className="fg-toggle" role="group" aria-label={label} title={disabled ? "Nothing in this session tree could be priced" : undefined}>
      <span className="muted">{label}</span>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} disabled={disabled && v === "cost"} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </span>
  );
}

interface TipProps {
  item: Item;
  agents: ActivityAgent[];
  actions: ActivityAction[];
  flame: SessionFlame;
  data: { ends: number[]; byAgent: number[][]; issuer: (number | null)[]; issued: number[][]; totals: number[] };
  root: number;
  byCost: boolean;
}

function TipBody({ item, agents, actions, flame, data, root, byCost }: TipProps) {
  const agent = agents[item.agent];
  if (item.kind === "agent") {
    const c = flame.costs[item.agent];
    const kids = agents.filter((a) => a.parent === item.agent).length;
    const share = data.totals[0] > 0 ? Math.round((data.totals[item.agent] / data.totals[0]) * 100) : null;
    return (
      <>
        <div className="tooltip-title">
          {agent.depth ? "Subagent" : "Session"} · {clock(agent.startedAt)}–{clock(agent.endedAt)} · {duration(agent.endedAt - agent.startedAt)}
        </div>
        <div className="tooltip-value fg-tip-text">{agent.title}</div>
        <div className="tooltip-row">
          <span className="tooltip-value">{costText(c.cost, c.costSource)}</span>
          <span className="tooltip-name">
            own cost · {tokens(c.tokens)} tokens · {integer(c.requests)} requests · {integer(data.byAgent[item.agent].length)} tool calls
          </span>
        </div>
        {kids > 0 && (
          <div className="tooltip-row">
            <span className="tooltip-value">{usd(data.totals[item.agent])}</span>
            <span className="tooltip-name">
              with {kids} {kids === 1 ? "subagent" : "subagents"}
              {share !== null && item.agent !== 0 ? ` · ${share}% of the tree` : ""}
            </span>
          </div>
        )}
        {agent.prompt && <div className="tooltip-name fg-tip-text">Dispatched with: {agent.prompt}</div>}
        <div className="tooltip-name">{item.agent !== root ? "Click to zoom in" : root !== 0 ? "Esc zooms out" : ""}</div>
      </>
    );
  }
  if (item.kind === "calls") {
    const first = actions[item.items[0]];
    if (item.items.length === 1) {
      const end = data.ends[item.items[0]];
      const r = data.issuer[item.items[0]];
      const req = r === null ? null : flame.requests[r];
      return (
        <>
          <div className="tooltip-title">
            {clock(first.ts)} · {agent.title}
          </div>
          <div className="tooltip-row">
            <span className="tooltip-key" style={{ background: CATEGORY_COLOR[first.error ? "error" : first.cat] }} />
            <span className="tooltip-value">{first.tool}</span>
            <span className="tooltip-name">{duration(end - first.ts)}</span>
            {first.error && <span className="error-text">failed</span>}
          </div>
          {first.label && <div className="tooltip-name fg-tip-text">{first.label}</div>}
          {flame.results[item.items[0]] === null && <div className="tooltip-name">no result recorded; drawn until the next call</div>}
          {req && <div className="tooltip-name">issued by a {costText(req.cost, req.costSource)} model request</div>}
        </>
      );
    }
    const counts = new Map<Band, number>();
    for (const a of item.items) {
      const b: Band = actions[a].error ? "error" : actions[a].cat;
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    return (
      <>
        <div className="tooltip-title">
          {clock(first.ts)}–{clock(actions[item.items.at(-1)!].ts)} · {agent.title}
        </div>
        <div className="tooltip-row">
          <span className="tooltip-value">{item.items.length}</span>
          <span className="tooltip-name">tool calls</span>
        </div>
        {CATEGORIES.filter((c) => counts.has(c.key)).map((c) => (
          <div className="tooltip-row" key={c.key}>
            <span className="tooltip-key" style={{ background: c.color }} />
            <span className="tooltip-value">{counts.get(c.key)}</span>
            <span className="tooltip-name">{CATEGORY_LABEL[c.key]}</span>
          </div>
        ))}
        {item.items.slice(0, 3).map((a) => (
          <div className="tooltip-name fg-tip-text" key={a}>
            {actions[a].tool} {actions[a].label}
          </div>
        ))}
        <div className="tooltip-name">click opens the first</div>
      </>
    );
  }
  const reqs = item.items.map((r) => flame.requests[r]);
  const calls = item.items.flatMap((r) => data.issued[r]);
  const cost = reqs.reduce((s, r) => s + (r.cost ?? 0), 0);
  return (
    <>
      <div className="tooltip-title">
        {clock(reqs[0].ts)}
        {reqs.length > 1 ? `–${clock(reqs.at(-1)!.ts)}` : ""} · {agent.title}
      </div>
      <div className="tooltip-row">
        <span className="tooltip-value">{reqs.length === 1 ? costText(reqs[0].cost, reqs[0].costSource) : usd(cost)}</span>
        <span className="tooltip-name">
          {reqs.length === 1 ? reqs[0].model : `${reqs.length} model requests`} · {tokens(reqs.reduce((s, r) => s + r.tokens, 0))} tokens
          {byCost && data.totals[0] > 0 ? ` · ${((cost / data.totals[0]) * 100).toFixed(1)}% of the tree` : ""}
        </span>
      </div>
      {calls.length === 0 ? (
        <div className="tooltip-name">reply, no tool call</div>
      ) : (
        calls.slice(0, 3).map((a) => (
          <div className="tooltip-row" key={a}>
            <span className="tooltip-key" style={{ background: CATEGORY_COLOR[actions[a].error ? "error" : actions[a].cat] }} />
            <span className="tooltip-name fg-tip-text">
              {actions[a].tool} {actions[a].label}
            </span>
          </div>
        ))
      )}
      {calls.length > 3 && <div className="tooltip-name">and {calls.length - 3} more calls</div>}
    </>
  );
}
