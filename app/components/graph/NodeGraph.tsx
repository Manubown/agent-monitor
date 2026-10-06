"use client";

import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityAgent, ActivityFile, OpCounts } from "../../../src/store/activity";
import { agentColor } from "./categories";
import { agentKey, changes, isChanged, nodeKey } from "./selection";

interface Props {
  agents: ActivityAgent[];
  files: ActivityFile[];
  /** Key of the selected node (see `nodeKey`, `agentKey`), stable across live refreshes. */
  selection: string | null;
  onSelect: (key: string) => void;
}

/** A file column row: one file, a directory's read-only files, or a whole collapsed directory. */
interface FileNode {
  /** Stable: by path or directory, never by index. */
  key: string;
  kind: "file" | "reads" | "dir";
  label: string;
  detail: string;
  files: number[];
  modified: boolean;
  deleted: boolean;
  y: number;
}

interface DirHead {
  dir: string;
  label: string;
  y: number;
  collapsed: boolean;
}

interface Edge {
  agent: number;
  node: string;
  count: number;
  style: "write" | "read" | "delete";
  y: number;
}

const PAD = 8;
const AGENT_W = 168;
const AGENT_H = 22;
const AGENT_GAP = 8;
const ROW = 20;
const HEAD = 24;
const CHAR_W = 6.6;
/** Above this many changed files in total, big directories start collapsed. */
const COLLAPSE_TOTAL = 48;
/** ...namely directories with more changed files than this. */
const COLLAPSE_DIR = 6;
/** Height of the scroll viewport; agents stay inside it so they are visible without scrolling. */
const VIEW_H = 560;

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;

const clipEnd = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s);

/** Long directories keep their tail, the part that tells them apart. */
const clipStart = (s: string, max: number) => (s.length > max ? `…${s.slice(s.length - Math.max(1, max - 1))}` : s);

function countsLabel(c: OpCounts): string {
  const parts: string[] = [];
  if (c.writes) parts.push(`${c.writes} write${c.writes > 1 ? "s" : ""}`);
  if (c.edits) parts.push(`${c.edits} edit${c.edits > 1 ? "s" : ""}`);
  if (c.moves) parts.push(`${c.moves} move${c.moves > 1 ? "s" : ""}`);
  if (c.deletes) parts.push(`${c.deletes} delete${c.deletes > 1 ? "s" : ""}`);
  if (c.reads) parts.push(`${c.reads} read${c.reads > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

const sum = (files: ActivityFile[], idx: number[]): OpCounts => {
  const total = { reads: 0, writes: 0, edits: 0, deletes: 0, moves: 0 };
  for (const i of idx) {
    const f = files[i];
    total.reads += f.reads;
    total.writes += f.writes;
    total.edits += f.edits;
    total.deletes += f.deletes;
    total.moves += f.moves;
  }
  return total;
};

export function NodeGraph({ agents, files, selection, onSelect }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [showReads, setShowReads] = useState(false);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** Files per directory: directories with changes first, each part in path order with the working directory first. */
  const groups = useMemo(() => {
    const byDir = new Map<string, { modified: number[]; reads: number[] }>();
    files.forEach((f, i) => {
      const g = byDir.get(f.dir) ?? { modified: [], reads: [] };
      // Same rule as `resolveSelection` for `r:` (read-only) keys.
      (isChanged(f) ? g.modified : g.reads).push(i);
      byDir.set(f.dir, g);
    });
    const byName = (a: number, b: number) => basename(files[a].path).localeCompare(basename(files[b].path));
    for (const g of byDir.values()) {
      g.modified.sort(byName);
      g.reads.sort(byName);
    }
    return [...byDir.entries()].sort(
      ([a, ga], [b, gb]) => Number(!ga.modified.length) - Number(!gb.modified.length) || (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)),
    );
  }, [files]);

  const totalChanged = useMemo(() => files.filter((f) => isChanged(f)).length, [files]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    totalChanged > COLLAPSE_TOTAL ? Object.fromEntries(groups.filter(([, g]) => g.modified.length > COLLAPSE_DIR).map(([dir]) => [dir, true])) : {},
  );

  const fileX = Math.max(AGENT_W + PAD + 140, Math.round(width - Math.min(380, width * 0.45)));
  const labelChars = Math.max(8, Math.floor((width - fileX - 16) / CHAR_W));

  const { nodes, heads, sections, rowsBottom } = useMemo(() => {
    const nodes: FileNode[] = [];
    const heads: DirHead[] = [];
    const sections: { label: string; y: number }[] = [];
    let y = PAD;
    const dirLabel = (dir: string) => clipStart(dir ? `${dir}/` : "./", labelChars);
    for (const [dir, g] of groups) {
      if (!g.modified.length && !showReads) {
        // Directories that were only read: one row each under a shared label, no header.
        if (!sections.length) {
          sections.push({ label: "Only read", y: y + HEAD / 2 + 2 });
          y += HEAD;
        }
        const detail = `${g.reads.length} ${g.reads.length === 1 ? "file" : "files"}`;
        nodes.push({ key: nodeKey.reads(dir), kind: "reads", label: dirLabel(dir), detail, files: g.reads, modified: false, deleted: false, y: y + ROW / 2 });
        y += ROW;
        continue;
      }
      const isCollapsed = collapsed[dir] === true;
      heads.push({ dir, label: dirLabel(dir), y: y + HEAD / 2 + 2, collapsed: isCollapsed });
      y += HEAD;
      if (isCollapsed) {
        const all = [...g.modified, ...g.reads];
        const c = sum(files, all);
        nodes.push({
          key: nodeKey.dir(dir),
          kind: "dir",
          label: [g.modified.length && `${g.modified.length} changed`, g.reads.length && `${g.reads.length} read`].filter(Boolean).join(", "),
          detail: countsLabel(c),
          files: all,
          modified: g.modified.length > 0,
          deleted: c.deletes > 0,
          y: y + ROW / 2,
        });
        y += ROW;
        continue;
      }
      for (const i of [...g.modified, ...(showReads ? g.reads : [])]) {
        const f = files[i];
        nodes.push({
          key: nodeKey.file(f.path),
          kind: "file",
          label: basename(f.path),
          detail: countsLabel(f),
          files: [i],
          modified: isChanged(f),
          deleted: f.deletes > 0,
          y: y + ROW / 2,
        });
        y += ROW;
      }
      if (!showReads && g.reads.length) {
        nodes.push({ key: nodeKey.reads(dir), kind: "reads", label: `${g.reads.length} read-only`, detail: countsLabel(sum(files, g.reads)), files: g.reads, modified: false, deleted: false, y: y + ROW / 2 });
        y += ROW;
      }
    }
    return { nodes, heads, sections, rowsBottom: y };
  }, [groups, files, showReads, collapsed, labelChars]);

  /** One edge per agent and node, styled by the strongest op and as thick as the op count. */
  const edges = useMemo(() => {
    const out: Edge[] = [];
    for (const node of nodes) {
      const per = new Map<number, OpCounts>();
      for (const i of node.files) {
        for (const a of files[i].agents) {
          const c = per.get(a.agent) ?? { reads: 0, writes: 0, edits: 0, deletes: 0, moves: 0 };
          c.reads += a.reads;
          c.writes += a.writes;
          c.edits += a.edits;
          c.deletes += a.deletes;
          c.moves += a.moves;
          per.set(a.agent, c);
        }
      }
      for (const [agent, c] of per) {
        out.push({ agent, node: node.key, count: changes(c) + c.reads, style: c.deletes ? "delete" : isChanged(c) ? "write" : "read", y: node.y });
      }
    }
    return out;
  }, [nodes, files]);

  /** Agents sit at the weighted centre of their files, kept in tree order and apart, within the first screen of a tall graph. */
  const agentY = useMemo(() => {
    const ys = agents.map((_, i) => {
      let w = 0;
      let s = 0;
      for (const e of edges) {
        if (e.agent !== i) continue;
        w += e.count;
        s += e.count * e.y;
      }
      return w ? s / w : PAD + AGENT_H / 2 + i * (AGENT_H + AGENT_GAP);
    });
    const gap = AGENT_H + AGENT_GAP;
    const top = PAD + AGENT_H / 2;
    for (let i = 0; i < ys.length; i++) ys[i] = Math.max(ys[i], i ? ys[i - 1] + gap : top);
    const bottom = Math.max(Math.min(rowsBottom, VIEW_H - PAD), top + (ys.length - 1) * gap + AGENT_H / 2) - AGENT_H / 2;
    for (let i = ys.length - 1; i >= 0; i--) ys[i] = Math.min(ys[i], i < ys.length - 1 ? ys[i + 1] - gap : bottom);
    return ys;
  }, [agents, edges, rowsBottom]);

  const height = Math.max(rowsBottom, (agentY.at(-1) ?? 0) + AGENT_H / 2) + PAD;

  const connected = useMemo(() => {
    if (!hover) return null;
    const on = new Set<string>([hover]);
    for (const e of edges) {
      const a = agentKey(agents, e.agent);
      if (hover === a || hover === e.node) {
        on.add(a);
        on.add(e.node);
        on.add(`${e.agent}>${e.node}`);
      }
    }
    return on;
  }, [hover, edges, agents]);

  const nodeClass = (key: string, base: string) =>
    [base, connected && !connected.has(key) ? "ng-dim" : "", selection === key ? "ng-selected" : ""].filter(Boolean).join(" ");

  const activate = (e: KeyboardEvent, run: () => void) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      run();
    }
  };

  const toggleDir = (dir: string) => setCollapsed((c) => ({ ...c, [dir]: !c[dir] }));

  const readOnly = files.length - totalChanged;
  const x1 = PAD + AGENT_W;
  const x2 = fileX - 7;
  const mx = (x1 + x2) / 2;

  return (
    <div className="ng">
      <div className="ng-head">
        <span className="muted">
          {totalChanged} {totalChanged === 1 ? "file" : "files"} changed · {readOnly} read only
        </span>
        <label className="ng-toggle">
          <input type="checkbox" checked={showReads} onChange={(e) => setShowReads(e.target.checked)} disabled={readOnly === 0} /> Show reads
        </label>
      </div>
      <div ref={ref} className="ng-scroll" style={{ maxHeight: VIEW_H }}>
        {width > 0 && (
          <svg width={width} height={height} className={connected ? "ng-svg ng-hovering" : "ng-svg"} role="group" aria-label="Agents and the files they touched">
            {edges.map((e) => {
              const ay = agentY[e.agent];
              return (
                <g key={`${e.agent}>${e.node}`} className={`ng-edge ng-edge-${e.style}${connected?.has(`${e.agent}>${e.node}`) ? " ng-on" : ""}`} aria-hidden="true">
                  <path
                    d={`M${x1} ${ay} C${mx} ${ay} ${mx} ${e.y} ${x2} ${e.y}`}
                    stroke={e.style === "delete" ? "var(--kind-error)" : agentColor(agents[e.agent])}
                    strokeWidth={1 + Math.min(3.5, Math.log2(e.count))}
                  />
                  {e.style === "delete" && <path className="ng-cross" d={`M${x2 - 14} ${e.y - 4}l8 8m0 -8l-8 8`} />}
                </g>
              );
            })}
            {sections.map((s) => (
              <text key={s.label} x={fileX - 4} y={s.y} dy="0.32em" className="ng-section">
                {s.label}
              </text>
            ))}
            {heads.map((h) => (
              <g
                key={`h:${h.dir}`}
                className="ng-head-row"
                role="button"
                tabIndex={0}
                aria-expanded={!h.collapsed}
                aria-label={`${h.collapsed ? "Expand" : "Collapse"} directory ${h.dir || "./"}`}
                onClick={() => toggleDir(h.dir)}
                onKeyDown={(e) => activate(e, () => toggleDir(h.dir))}
              >
                <rect x={fileX - 10} y={h.y - HEAD / 2 + 1} width={Math.max(0, width - fileX + 10)} height={HEAD - 4} className="ng-hit" />
                <text x={fileX - 4} y={h.y} dy="0.32em" className="ng-dir">
                  <tspan className="ng-caret">{h.collapsed ? "▸" : "▾"}</tspan> {h.label}
                </text>
              </g>
            ))}
            {nodes.map((n) => (
              <g
                key={n.key}
                className={nodeClass(n.key, `ng-node ng-${n.kind}${n.modified ? " ng-mod" : ""}`)}
                role="button"
                tabIndex={0}
                aria-pressed={selection === n.key}
                aria-label={`${n.kind === "file" ? files[n.files[0]].path : n.label}: ${n.detail}. Show its tool calls.`}
                onPointerEnter={() => setHover(n.key)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(n.key)}
                onBlur={() => setHover(null)}
                onClick={() => onSelect(n.key)}
                onKeyDown={(e) => activate(e, () => onSelect(n.key))}
              >
                <title>{n.kind === "file" ? `${files[n.files[0]].path}\n${n.detail}` : `${n.label}\n${n.detail}`}</title>
                <rect x={fileX - 10} y={n.y - ROW / 2} width={Math.max(0, width - fileX + 10)} height={ROW} className="ng-hit" />
                {n.kind === "file" ? (
                  <circle cx={fileX} cy={n.y} r={n.modified ? 4.5 : 3.5} className={n.deleted ? "ng-dot ng-dot-deleted" : "ng-dot"} />
                ) : (
                  <rect x={fileX - 4} y={n.y - 4} width={8} height={8} rx={n.kind === "dir" ? 1 : 4} className={n.deleted ? "ng-dot ng-dot-deleted" : "ng-dot"} />
                )}
                <text x={fileX + 10} y={n.y} dy="0.32em">
                  <tspan className="ng-label">{clipEnd(n.label, labelChars)}</tspan>
                  {n.label.length + n.detail.length + 2 <= labelChars && (
                    <tspan className="ng-detail" dx={8}>
                      {n.detail}
                    </tspan>
                  )}
                </text>
              </g>
            ))}
            {agents.map((a, i) => {
              const key = agentKey(agents, i);
              const y = agentY[i];
              return (
                <g
                  key={a.id}
                  className={nodeClass(key, "ng-node ng-agent")}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selection === key}
                  aria-label={`${a.depth ? "Subagent" : "Session"} ${a.title}. Show its tool calls.`}
                  onPointerEnter={() => setHover(key)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(key)}
                  onBlur={() => setHover(null)}
                  onClick={() => onSelect(key)}
                  onKeyDown={(e) => activate(e, () => onSelect(key))}
                >
                  <title>{a.title}</title>
                  <rect x={PAD} y={y - AGENT_H / 2} width={AGENT_W} height={AGENT_H} rx={AGENT_H / 2} className="ng-pill" style={{ stroke: agentColor(a) }} />
                  <circle cx={PAD + 12} cy={y} r={4} fill={agentColor(a)} />
                  <text x={PAD + 22} y={y} dy="0.32em" className="ng-agent-label">
                    {clipEnd(a.title, Math.floor((AGENT_W - 30) / CHAR_W))}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}
