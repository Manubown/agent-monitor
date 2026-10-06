"use client";

import Link from "next/link";
import { type CSSProperties, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ActionCategory, SessionActivity } from "../../../src/store/activity";
import { clock, integer } from "../../lib/format";
import { agentColor, CATEGORY_COLOR, eventHref } from "./categories";
import { RangeBrush } from "./RangeBrush";
import { KIND_OF_RESOURCE, MAP_KIND_LABEL, MAP_KINDS, type MapFilters, type MapKind, mapQuery, passes } from "./resourceMap";
import "../../graph.css";
import "../../resource-map.css";

interface Props {
  data: SessionActivity;
  initial: MapFilters;
}

/** One file or resource; files come first, resource `r` is node `files.length + r`. */
interface CatalogNode {
  kind: MapKind;
  file: boolean;
  /** Full name: file path, command head, URL, pattern, agent title, tool name. */
  label: string;
  /** Name under its group header. */
  short: string;
  /** Index into `groups`. */
  group: number;
  actions: number[];
}

interface CatalogGroup {
  key: string;
  kind: MapKind;
  label: string;
  nodes: number[];
}

interface EdgeAcc {
  agent: number;
  to: number;
  calls: number;
  errors: number;
  cats: Partial<Record<ActionCategory, number>>;
}

interface Row {
  key: string;
  kind: MapKind;
  label: string;
  title: string;
  nodes: number[];
  calls: number;
  errors: number;
  /** A collapsed group: one row standing for all its members, with an expand caret. */
  group: boolean;
  /** Shown after the label instead of the call count. */
  detail?: string;
  y: number;
}

interface Head {
  key: string;
  label: string;
  detail: string;
  y: number;
  /** Group key for collapsible group headers; sections have none. */
  group?: string;
  collapsed?: boolean;
}

interface Edge {
  id: string;
  agent: number;
  row: number;
  calls: number;
  errors: number;
  cat: ActionCategory;
}

interface Selection {
  key: string;
  label: string;
  kind: MapKind;
  nodes: number[];
}

const PAD = 10;
const AGENT_W = 220;
const AGENT_H = 22;
const AGENT_GAP = 8;
const INDENT = 10;
const ROW = 20;
const HEAD = 24;
const SECTION = 30;
const CHAR_W = 6.6;
/** Above this many rows with every group open, only the busiest few groups start open. */
const COLLAPSE_ROWS = 40;
const OPEN_GROUPS = 3;
/** Groups this big start collapsed even among the busiest. */
const OPEN_MAX = 15;
/** Folders outside the working directory (absolute, under home, dependencies) start collapsed. */
const OUTSIDE = /^[/~]|(^|\/)node_modules\//;
/** Height of the scroll viewport: min(80% of the window, VIEW_MAX). */
const VIEW_MAX = 900;
/** Horizontal room for edges between the agent column and the resource dots. */
const EDGE_MIN = 180;
/** Width of the pinned agent column. */
const AGENTS_PANEL = PAD + AGENT_W + PAD;
const LIST_MAX = 300;

const NOUN: Record<MapKind, [string, string]> = {
  files: ["file", "files"],
  shell: ["command", "commands"],
  web: ["page", "pages"],
  search: ["search", "searches"],
  agents: ["subagent", "subagents"],
  tools: ["tool", "tools"],
};

const plural = (n: number, kind: MapKind) => `${integer(n)} ${NOUN[kind][n === 1 ? 0 : 1]}`;

const clipEnd = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s);

const callsText = (calls: number, errors: number) => `${integer(calls)} ${calls === 1 ? "call" : "calls"}${errors ? `, ${integer(errors)} failed` : ""}`;

const activate = (e: KeyboardEvent, run: () => void) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    run();
  }
};

/** Full-page map of a session tree: agents on the left, everything their calls worked on on the right. */
export function ResourceMap({ data, initial }: Props) {
  const { agents, actions, files, resources } = data;
  const [filters, setFilters] = useState(initial);
  const [hover, setHover] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [query, setQuery] = useState("");
  const [width, setWidth] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const agentsRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [viewMax, setViewMax] = useState(VIEW_MAX);
  const [scroll, setScroll] = useState({ a: 0, r: 0 });
  const frame = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    const fit = () => setViewMax(Math.max(360, Math.min(VIEW_MAX, Math.round(window.innerHeight * 0.8))));
    fit();
    window.addEventListener("resize", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
      cancelAnimationFrame(frame.current);
    };
  }, []);

  /** Both columns scroll independently; edges follow at most once per frame. */
  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setScroll({ a: agentsRef.current?.scrollTop ?? 0, r: rowsRef.current?.scrollTop ?? 0 });
    });
  };

  // Filters live in the URL so a view can be shared; replaceState keeps the server out of it.
  useEffect(() => {
    const url = `${window.location.pathname}${mapQuery(filters)}`;
    if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", url);
  }, [filters]);

  const update = (patch: Partial<MapFilters>) => setFilters((f) => ({ ...f, ...patch }));

  /** Every node, grouped and ordered once; filters only decide what is shown. */
  const catalog = useMemo(() => {
    const nodes: CatalogNode[] = [];
    const groups: CatalogGroup[] = [];
    const groupIndex = new Map<string, number>();
    const groupOf = (kind: MapKind, label: string) => {
      const key = `${kind}:${label}`;
      let g = groupIndex.get(key);
      if (g === undefined) {
        g = groups.length;
        groupIndex.set(key, g);
        groups.push({ key, kind, label, nodes: [] });
      }
      return g;
    };
    for (const f of files) {
      const group = groupOf("files", f.dir ? `${f.dir}/` : "./");
      nodes.push({ kind: "files", file: true, label: f.path, short: f.path.slice(f.path.lastIndexOf("/") + 1) || f.path, group, actions: f.actions });
    }
    for (const r of resources) {
      const kind = KIND_OF_RESOURCE[r.kind];
      const group = groupOf(kind, r.group);
      const short = kind === "web" && r.label.startsWith(r.group) ? r.label.slice(r.group.length) || "/" : r.label;
      nodes.push({ kind, file: false, label: r.label, short, group, actions: r.actions });
    }
    nodes.forEach((n, i) => groups[n.group].nodes.push(i));

    const changed = (i: number) => {
      const f = files[i];
      return f.writes + f.edits + f.deletes + f.moves > 0;
    };
    const calls = (g: CatalogGroup) => g.nodes.reduce((s, n) => s + nodes[n].actions.length, 0);
    const groupCalls = groups.map(calls);
    for (const g of groups) {
      if (g.kind === "files") g.nodes.sort((a, b) => Number(changed(b)) - Number(changed(a)) || nodes[a].short.localeCompare(nodes[b].short));
      else g.nodes.sort((a, b) => nodes[b].actions.length - nodes[a].actions.length || nodes[a].label.localeCompare(nodes[b].label));
    }
    // Directories with changes first, the working directory first; everything else by calls.
    const order = groups.map((_, i) => i);
    const dirChanged = groups.map((g) => g.kind === "files" && g.nodes.some(changed));
    order.sort((a, b) => {
      const ga = groups[a];
      const gb = groups[b];
      if (ga.kind !== gb.kind) return MAP_KINDS.indexOf(ga.kind) - MAP_KINDS.indexOf(gb.kind);
      if (ga.kind === "files")
        return (
          Number(OUTSIDE.test(ga.label)) - Number(OUTSIDE.test(gb.label)) ||
          Number(dirChanged[b]) - Number(dirChanged[a]) ||
          (ga.label === "./" ? -1 : gb.label === "./" ? 1 : ga.label.localeCompare(gb.label))
        );
      return groupCalls[b] - groupCalls[a] || ga.label.localeCompare(gb.label);
    });

    const actionNodes = actions.map((a) => [...(a.files ?? []), ...(a.res ?? []).map((r) => files.length + r)]);
    return { nodes, groups, order, actionNodes };
  }, [files, resources, actions]);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const multi = catalog.groups.filter((g) => g.nodes.length > 1);
    const out: Record<string, boolean> = Object.fromEntries(multi.filter((g) => g.kind === "files" && OUTSIDE.test(g.label)).map((g) => [g.key, true]));
    const rows = catalog.groups.reduce((s, g) => s + (g.nodes.length > 1 ? g.nodes.length + 1 : 1), 0);
    if (rows <= COLLAPSE_ROWS) return out;
    const calls = (g: CatalogGroup) => g.nodes.reduce((s, n) => s + catalog.nodes[n].actions.length, 0);
    const open = new Set(
      multi
        .filter((g) => !out[g.key] && g.nodes.length <= OPEN_MAX)
        .sort((a, b) => calls(b) - calls(a))
        .slice(0, OPEN_GROUPS),
    );
    for (const g of multi) if (!open.has(g)) out[g.key] = true;
    return out;
  });

  const focus = useMemo(() => {
    const i = filters.agent ? agents.findIndex((a) => a.id === filters.agent) : -1;
    return i === -1 ? null : i;
  }, [agents, filters.agent]);

  /** Calls per node and per (agent, node) under the time, agent, errors and changed filters; kinds apply in the layout. */
  const counted = useMemo(() => {
    const n = catalog.nodes.length;
    const calls = new Int32Array(n);
    const errors = new Int32Array(n);
    const edges = new Map<number, EdgeAcc>();
    actions.forEach((a, i) => {
      if (!passes(a, filters, focus)) return;
      for (const node of catalog.actionNodes[i]) {
        if (filters.changed && catalog.nodes[node].file && a.cat !== "write") continue;
        calls[node]++;
        if (a.error) errors[node]++;
        const key = a.agent * n + node;
        let e = edges.get(key);
        if (!e) edges.set(key, (e = { agent: a.agent, to: node, calls: 0, errors: 0, cats: {} }));
        e.calls++;
        if (a.error) e.errors++;
        e.cats[a.cat] = (e.cats[a.cat] ?? 0) + 1;
      }
    });
    const perKind = Object.fromEntries(MAP_KINDS.map((k) => [k, 0])) as Record<MapKind, number>;
    for (let i = 0; i < n; i++) if (calls[i]) perKind[catalog.nodes[i].kind]++;
    return { calls, errors, edges, perKind };
  }, [catalog, actions, filters, focus]);

  const nodeX = Math.max(AGENTS_PANEL + EDGE_MIN, Math.round(width - Math.min(520, width * 0.5)));
  const rowsW = Math.max(0, width - AGENTS_PANEL);
  /** Resource dot x inside the scrolling resource column. */
  const nodeL = nodeX - AGENTS_PANEL;
  const labelChars = Math.max(10, Math.floor((rowsW - nodeL - 32) / CHAR_W));

  const layout = useMemo(() => {
    const { calls, errors } = counted;
    const rows: Row[] = [];
    const heads: Head[] = [];
    const rowOf = new Int32Array(catalog.nodes.length).fill(-1);
    const hidden = new Set(filters.hide);
    let y = PAD;
    let section: MapKind | null = null;
    for (const gi of catalog.order) {
      const g = catalog.groups[gi];
      if (hidden.has(g.kind)) continue;
      const shown = g.nodes.filter((n) => calls[n] > 0);
      if (!shown.length) continue;
      if (section !== g.kind) {
        section = g.kind;
        const kindCalls = catalog.groups.filter((x) => x.kind === g.kind).reduce((s, x) => s + x.nodes.reduce((t, n) => t + calls[n], 0), 0);
        heads.push({ key: `s:${g.kind}`, label: MAP_KIND_LABEL[g.kind], detail: `${plural(counted.perKind[g.kind], g.kind)} · ${callsText(kindCalls, 0)}`, y: y + SECTION / 2 + 4 });
        y += SECTION;
      }
      const push = (row: Omit<Row, "y">) => {
        for (const n of row.nodes) rowOf[n] = rows.length;
        rows.push({ ...row, y: y + ROW / 2 });
        y += ROW;
      };
      const sum = (list: number[], of: Int32Array) => list.reduce((s, n) => s + of[n], 0);
      if (shown.length === 1) {
        const n = shown[0];
        const node = catalog.nodes[n];
        push({ key: `n:${n}`, kind: g.kind, label: node.label, title: node.label, nodes: [n], calls: calls[n], errors: errors[n], group: false });
        continue;
      }
      const isCollapsed = collapsed[g.key] === true;
      const groupCalls = sum(shown, calls);
      const groupErrors = sum(shown, errors);
      const detail = `${plural(shown.length, g.kind)} · ${callsText(groupCalls, groupErrors)}`;
      if (isCollapsed) {
        push({ key: `g:${g.key}`, kind: g.kind, label: g.label, title: `${g.label} (${plural(shown.length, g.kind)})`, detail, nodes: shown, calls: groupCalls, errors: groupErrors, group: true });
        continue;
      }
      heads.push({ key: `g:${g.key}`, label: g.label, detail, y: y + HEAD / 2 + 2, group: g.key, collapsed: false });
      y += HEAD;
      for (const n of shown) {
        const node = catalog.nodes[n];
        push({ key: `n:${n}`, kind: g.kind, label: node.short, title: node.label, nodes: [n], calls: calls[n], errors: errors[n], group: false });
      }
    }

    // Edges per (agent, row); colored by the calls' main category, writes winning for files.
    const byRow = new Map<number, { agent: number; row: number; calls: number; errors: number; cats: Partial<Record<ActionCategory, number>> }>();
    for (const e of counted.edges.values()) {
      const row = rowOf[e.to];
      if (row === -1) continue;
      const key = e.agent * rows.length + row;
      let acc = byRow.get(key);
      if (!acc) byRow.set(key, (acc = { agent: e.agent, row, calls: 0, errors: 0, cats: {} }));
      acc.calls += e.calls;
      acc.errors += e.errors;
      for (const [c, k] of Object.entries(e.cats) as [ActionCategory, number][]) acc.cats[c] = (acc.cats[c] ?? 0) + k;
    }
    const edges: Edge[] = [...byRow.values()].map((e) => {
      const cats = Object.entries(e.cats) as [ActionCategory, number][];
      const cat = e.cats.write ? "write" : cats.reduce((best, c) => (c[1] > best[1] ? c : best))[0];
      return { id: `${e.agent}>${rows[e.row].key}`, agent: e.agent, row: e.row, calls: e.calls, errors: e.errors, cat };
    });
    return { rows, heads, edges, bottom: y };
  }, [catalog, counted, filters.hide, collapsed]);

  // Agents sit in their own pinned column; edges are drawn in viewport coordinates from both columns' scroll positions.
  const gap = AGENT_H + AGENT_GAP;
  const agentTop = PAD + SECTION + AGENT_H / 2;
  const agentsH = agentTop + (agents.length - 1) * gap + AGENT_H / 2 + PAD;
  const viewH = Math.min(viewMax, Math.max(layout.bottom + PAD, agentsH));
  const agentY = (i: number) => agentTop + i * gap;
  const agentX = (i: number) => PAD + Math.min(agents[i].depth, 6) * INDENT;

  const agentCalls = useMemo(() => {
    const out = new Array<number>(agents.length).fill(0);
    for (const e of layout.edges) out[e.agent] += e.calls;
    return out;
  }, [agents, layout]);

  /** Edges to rows inside the viewport; recomputed per (rAF-throttled) scroll. */
  const visibleEdges = useMemo(() => {
    const top = scroll.r - ROW;
    const bottom = scroll.r + viewH + ROW;
    return layout.edges.filter((e) => layout.rows[e.row].y >= top && layout.rows[e.row].y <= bottom);
  }, [layout, scroll.r, viewH]);
  /** Many edges fade so the bundle stays readable; highlighted ones stay solid. */
  const edgeOpacity = Math.max(0.08, Math.min(0.5, 3 / Math.sqrt(Math.max(1, visibleEdges.length))));
  const litKey = hover ?? selection?.key ?? (focus === null ? null : `a:${focus}`);
  const isLit = (e: Edge) => litKey !== null && (litKey === `a:${e.agent}` || litKey === layout.rows[e.row].key);

  const connected = useMemo(() => {
    if (!hover) return null;
    const on = new Set<string>([hover]);
    for (const e of layout.edges) {
      const a = `a:${e.agent}`;
      const r = layout.rows[e.row].key;
      if (hover === a || hover === r) {
        on.add(a);
        on.add(r);
      }
    }
    return on;
  }, [hover, layout]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const keys: string[] = [];
    agents.forEach((a, i) => {
      if (a.title.toLowerCase().includes(q)) keys.push(`a:${i}`);
    });
    for (const r of layout.rows) {
      if (r.title.toLowerCase().includes(q) || r.nodes.some((n) => catalog.nodes[n].label.toLowerCase().includes(q))) keys.push(r.key);
    }
    return { keys, set: new Set(keys) };
  }, [query, agents, layout, catalog]);

  const selectRow = (r: Row) =>
    setSelection((cur) => (cur?.key === r.key ? null : { key: r.key, label: r.title, kind: r.kind, nodes: r.nodes }));

  const focusAgent = (i: number) => update({ agent: focus === i ? null : agents[i].id });

  const toggleGroup = (group: string | undefined) => {
    if (group) setCollapsed((c) => ({ ...c, [group]: !c[group] }));
  };

  const jump = () => {
    const key = matches?.keys[0];
    if (!key) return;
    if (key.startsWith("a:")) focusAgent(Number(key.slice(2)));
    else {
      const row = layout.rows.find((r) => r.key === key);
      if (row) {
        setSelection({ key: row.key, label: row.title, kind: row.kind, nodes: row.nodes });
        if (row.group) setCollapsed((c) => ({ ...c, [row.key.slice(2)]: false }));
      }
    }
    const el = viewRef.current?.querySelector<SVGGElement>(`[data-key="${CSS.escape(key)}"]`);
    el?.scrollIntoView({ block: "center", behavior: document.documentElement.dataset.motion === "on" ? "smooth" : "auto" });
    el?.focus({ preventScroll: true });
  };

  const listed = useMemo(() => {
    if (!selection) return [];
    const out = new Set<number>();
    for (const n of selection.nodes) {
      const node = catalog.nodes[n];
      for (const i of node.actions) {
        const a = actions[i];
        if (passes(a, filters, focus) && !(filters.changed && node.file && a.cat !== "write")) out.add(i);
      }
    }
    return [...out].sort((a, b) => actions[a].ts - actions[b].ts || a - b);
  }, [selection, catalog, actions, filters, focus]);

  const times = useMemo(() => actions.map((a) => a.ts).sort((a, b) => a - b), [actions]);

  const isDefault = mapQuery(filters) === "";
  const nodeClass = (key: string, base: string) =>
    [
      base,
      connected && !connected.has(key) ? "rm-dim" : "",
      selection?.key === key ? "rm-selected" : "",
      matches?.set.has(key) ? "rm-match" : "",
    ]
      .filter(Boolean)
      .join(" ");

  const edgePath = (e: Edge) => {
    const ay = Math.max(0, Math.min(viewH, agentY(e.agent) - scroll.a));
    const ry = layout.rows[e.row].y - scroll.r;
    const x1 = PAD + AGENT_W;
    const x2 = nodeX - 8;
    const mx = (x1 + x2) / 2;
    const d = `M${x1} ${ay} C${mx} ${ay} ${mx} ${ry} ${x2} ${ry}`;
    const allFailed = e.errors === e.calls;
    return (
      <g key={e.id} className={isLit(e) ? "rm-edge rm-on" : "rm-edge"}>
        <path d={d} stroke={CATEGORY_COLOR[allFailed ? "error" : e.cat]} strokeWidth={1 + Math.min(4, Math.log2(e.calls))} />
        {e.errors > 0 && !allFailed && <path d={d} className="rm-edge-error" strokeWidth={1 + Math.min(3, Math.log2(e.errors))} />}
      </g>
    );
  };

  const focused = focus === null ? null : agents[focus];

  return (
    <div className="rm">
      <div className="rm-controls">
        <div className="rm-chips" role="group" aria-label="Resource kinds">
          {MAP_KINDS.map((k) => {
            const on = !filters.hide.includes(k);
            return (
              <button
                key={k}
                type="button"
                className="chip"
                aria-pressed={on}
                onClick={() => update({ hide: on ? [...filters.hide, k] : filters.hide.filter((x) => x !== k) })}
              >
                {MAP_KIND_LABEL[k]} <span className="muted">{counted.perKind[k]}</span>
              </button>
            );
          })}
          <span className="rm-sep" aria-hidden="true" />
          <button type="button" className="chip" aria-pressed={filters.changed} disabled={filters.hide.includes("files")} onClick={() => update({ changed: !filters.changed })}>
            Changed files only
          </button>
          <button type="button" className="chip" aria-pressed={filters.errors} onClick={() => update({ errors: !filters.errors })}>
            <span className="sa-dot" style={{ background: "var(--kind-error)" }} />
            Errors only
          </button>
          {!isDefault && (
            <button type="button" className="chip" onClick={() => setFilters({ hide: [], changed: false, errors: false, agent: null, from: null, to: null })}>
              Reset
            </button>
          )}
        </div>
        <label className="rm-search">
          <input
            type="search"
            aria-label="Find a node by name; Enter jumps to the first match"
            placeholder="Find agent, file, command…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                jump();
              }
            }}
            aria-describedby="rm-search-count"
          />
          <span id="rm-search-count" className="muted" aria-live="polite">
            {matches ? `${matches.keys.length} ${matches.keys.length === 1 ? "match" : "matches"}` : ""}
          </span>
        </label>
      </div>

      <RangeBrush times={times} from={filters.from} to={filters.to} onChange={(from, to) => update({ from, to })} />

      {focused && (
        <div className="sa-filter rm-focus" role="status">
          <span>
            Only calls by <span className="sa-dot" style={{ background: agentColor(focused) }} />
            <span className="mono">{focused.title}</span>
            {focused.prompt && <span className="rm-prompt muted">Dispatched with: {focused.prompt}</span>}
          </span>
          <button type="button" className="btn" onClick={() => update({ agent: null })}>
            All agents
          </button>
        </div>
      )}

      <div className={selection ? "rm-body rm-body-panel" : "rm-body"}>
        <div ref={ref} className="rm-plot">
          {width > 0 && (
            <div ref={viewRef} className="rm-view" style={{ height: viewH }} role="group" aria-label="Agents and the resources their tool calls worked on">
              <div ref={agentsRef} className="rm-agents" style={{ width: AGENTS_PANEL }} onScroll={onScroll}>
                <svg width={AGENTS_PANEL} height={agentsH} className={connected ? "rm-svg rm-hovering" : "rm-svg"} role="group" aria-label="Agents">
                  <text x={PAD} y={PAD + SECTION / 2 - 2} className="rm-section">
                    Agents
                  </text>
                  {agents.map((a, i) => {
                    const p = a.parent;
                    if (p === null) return null;
                    return (
                      <path
                        key={`t:${a.id}`}
                        d={`M${agentX(p) + 6} ${agentY(p) + AGENT_H / 2} V${agentY(i)} H${agentX(i)}`}
                        className="rm-tree"
                        aria-hidden="true"
                      />
                    );
                  })}
                  {agents.map((a, i) => {
                    const key = `a:${i}`;
                    const y = agentY(i);
                    const x = agentX(i);
                    const w = PAD + AGENT_W - x;
                    return (
                      <g
                        key={a.id}
                        data-key={key}
                        className={nodeClass(key, `rm-node rm-agent${agentCalls[i] ? "" : " rm-idle"}${focus === i ? " rm-selected" : ""}`)}
                        role="button"
                        tabIndex={0}
                        aria-pressed={focus === i}
                        aria-label={`${a.depth ? "Subagent" : "Session"} ${a.title}, ${callsText(agentCalls[i], 0)} shown. ${focus === i ? "Show all agents." : "Show only its calls."}`}
                        onPointerEnter={() => setHover(key)}
                        onPointerLeave={() => setHover(null)}
                        onFocus={() => setHover(key)}
                        onBlur={() => setHover(null)}
                        onClick={() => focusAgent(i)}
                        onKeyDown={(e) => activate(e, () => focusAgent(i))}
                      >
                        <title>{`${a.title}\n${callsText(agentCalls[i], 0)}${a.prompt ? `\nDispatched with: ${a.prompt}` : ""}`}</title>
                        <rect x={x} y={y - AGENT_H / 2} width={w} height={AGENT_H} className="rm-pill" style={{ stroke: agentColor(a) }} />
                        <rect x={x + 8} y={y - 4} width={8} height={8} fill={agentColor(a)} />
                        <text x={x + 22} y={y} dy="0.32em" className="rm-agent-label">
                          {clipEnd(a.title, Math.floor((w - 60) / CHAR_W))}
                          <tspan className="rm-detail" dx={6}>
                            {agentCalls[i] ? integer(agentCalls[i]) : ""}
                          </tspan>
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>
              <div ref={rowsRef} className="rm-rows" style={{ left: AGENTS_PANEL }} onScroll={onScroll}>
                <svg width={rowsW} height={layout.bottom + PAD} className={connected ? "rm-svg rm-hovering" : "rm-svg"} role="group" aria-label="Resources">
                  {layout.heads.map((h) =>
                    h.group ? (
                      <g
                        key={h.key}
                        className="rm-head-row"
                        role="button"
                        tabIndex={0}
                        aria-expanded={!h.collapsed}
                        aria-label={`${h.collapsed ? "Expand" : "Collapse"} ${h.label}: ${h.detail}`}
                        onClick={() => toggleGroup(h.group)}
                        onKeyDown={(e) => activate(e, () => toggleGroup(h.group))}
                      >
                        <rect x={nodeL - 12} y={h.y - HEAD / 2 + 1} width={Math.max(0, rowsW - nodeL + 12)} height={HEAD - 4} className="rm-hit" />
                        <text x={nodeL - 4} y={h.y} dy="0.32em" className="rm-group">
                          <tspan className="rm-caret">{h.collapsed ? "▸" : "▾"}</tspan> {clipEnd(h.label, Math.max(6, labelChars - h.detail.length - 4))}
                          <tspan className="rm-detail" dx={8}>
                            {h.detail}
                          </tspan>
                        </text>
                      </g>
                    ) : (
                      <text key={h.key} x={nodeL - 12} y={h.y} className="rm-section">
                        {h.label}
                        <tspan className="rm-detail" dx={8}>
                          {h.detail}
                        </tspan>
                      </text>
                    ),
                  )}
                  {layout.rows.map((r) => (
                    <g key={r.key}>
                      <g
                        data-key={r.key}
                        className={nodeClass(r.key, `rm-node rm-kind-${r.kind}${r.group ? " rm-collapsed" : ""}${r.errors ? " rm-failed" : ""}`)}
                        role="button"
                        tabIndex={0}
                        aria-pressed={selection?.key === r.key}
                        aria-label={`${MAP_KIND_LABEL[r.kind]}: ${r.title}, ${callsText(r.calls, r.errors)}. Show the calls.`}
                        onPointerEnter={() => setHover(r.key)}
                        onPointerLeave={() => setHover(null)}
                        onFocus={() => setHover(r.key)}
                        onBlur={() => setHover(null)}
                        onClick={() => selectRow(r)}
                        onKeyDown={(e) => activate(e, () => selectRow(r))}
                      >
                        <title>{`${r.title}\n${callsText(r.calls, r.errors)}`}</title>
                        <rect x={nodeL - 12} y={r.y - ROW / 2} width={Math.max(0, rowsW - nodeL + 12)} height={ROW} className="rm-hit" />
                        <rect x={nodeL - 4} y={r.y - 4} width={8} height={8} className="rm-dot" />
                        <text x={nodeL + (r.group ? 26 : 10)} y={r.y} dy="0.32em">
                          <tspan className="rm-label">{clipEnd(r.label, labelChars - (r.group ? 3 : 0))}</tspan>
                          {r.label.length + (r.detail ?? "").length + 12 <= labelChars && (
                            <tspan className={r.errors ? "rm-detail error-text" : "rm-detail"} dx={8}>
                              {r.detail ??
                                `${integer(r.calls)}${r.errors ? ` · ${integer(r.errors)} failed` : ""}`}
                            </tspan>
                          )}
                        </text>
                      </g>
                      {r.group && (
                        <g
                          className="rm-head-row rm-expand"
                          role="button"
                          tabIndex={0}
                          aria-expanded={false}
                          aria-label={`Expand ${r.title}`}
                          onClick={() => toggleGroup(r.key.slice(2))}
                          onKeyDown={(e) => activate(e, () => toggleGroup(r.key.slice(2)))}
                        >
                          <rect x={nodeL + 8} y={r.y - ROW / 2 + 2} width={16} height={ROW - 4} className="rm-hit" />
                          <text x={nodeL + 11} y={r.y} dy="0.32em" className="rm-caret">
                            ▸
                          </text>
                        </g>
                      )}
                    </g>
                  ))}
                </svg>
                {layout.rows.length === 0 && <p className="muted rm-empty">No calls match these filters.</p>}
              </div>
              <svg
                className={litKey ? "rm-overlay rm-lit" : "rm-overlay"}
                width={width}
                height={viewH}
                aria-hidden="true"
                style={{ "--rm-edge-opacity": edgeOpacity } as CSSProperties}
              >
                {visibleEdges.filter((e) => !isLit(e)).map(edgePath)}
                {litKey && visibleEdges.filter(isLit).map(edgePath)}
              </svg>
            </div>
          )}
        </div>

        {selection && (
          <aside className="rm-panel" aria-label={`Calls on ${selection.label}`}>
            <div className="rm-panel-head">
              <div>
                <div className="muted">{MAP_KIND_LABEL[selection.kind]}</div>
                <div className="mono rm-panel-title">{selection.label}</div>
                <div className="muted">
                  {callsText(listed.length, listed.filter((i) => actions[i].error).length)}
                  {listed.length > 0 && ` · ${clock(actions[listed[0]].ts)} – ${clock(actions[listed[listed.length - 1]].ts)}`}
                </div>
              </div>
              <button type="button" className="btn" onClick={() => setSelection(null)} aria-label="Close the calls panel">
                Close
              </button>
            </div>
            <ol className="rm-calls">
              {listed.slice(0, LIST_MAX).map((i) => {
                const a = actions[i];
                const agent = agents[a.agent];
                return (
                  <li key={i}>
                    <Link href={eventHref(agent, a.seq)} className="rm-call">
                      <span className="ev-time">{clock(a.ts)}</span>
                      <span className="tool-name">
                        <span className="sa-dot" style={{ background: CATEGORY_COLOR[a.error ? "error" : a.cat] }} />
                        {a.tool}
                        {a.error && <span className="error-text"> failed</span>}
                      </span>
                      <span className="rm-call-agent" title={agent.title}>
                        <span className="sa-dot" style={{ background: agentColor(agent) }} />
                        {agent.title}
                      </span>
                      <span className="secondary rm-call-label">{a.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ol>
            {listed.length > LIST_MAX && <p className="muted">and {integer(listed.length - LIST_MAX)} more</p>}
          </aside>
        )}
      </div>
    </div>
  );
}
