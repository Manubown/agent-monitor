"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { SessionActivity as Activity } from "../../../src/store/activity";
import { clock } from "../../lib/format";
import { agentColor, CATEGORY_COLOR, eventHref } from "./categories";
import { NodeGraph } from "./NodeGraph";
import { actionKey, resolveSelection } from "./selection";
import { TimeGraph } from "./TimeGraph";
import "../../graph.css";

/** Rows listed under the graphs for a selection; the time graph still shows all of them. */
const LIST_MAX = 200;

/** What the session page sends: no resources, and calls without their file and resource links (only the resource map uses those). */
export type SessionActivityData = Pick<Activity, "agents" | "markers" | "files"> & { actions: Omit<Activity["actions"][number], "files" | "res">[] };

/** "What it did": the session tree's tool calls over time and the files they touched, linked by selection. */
export function SessionActivity({ data }: { data: SessionActivityData }) {
  const { agents, actions, markers, files } = data;
  // A node key (agent id or path), not an index: a live refresh can insert agents and files anywhere.
  const [key, setKey] = useState<string | null>(null);
  const selection = useMemo(() => (key === null ? null : resolveSelection(key, data)), [key, data]);

  const selected = useMemo(() => (selection ? new Set(selection.actions) : null), [selection]);

  const listed = useMemo(
    () => (selected ? [...selected].sort((a, b) => actions[a].ts - actions[b].ts || a - b) : []),
    [selected, actions],
  );

  const select = (next: string) => setKey((cur) => (cur === next ? null : next));

  return (
    <div className="sa">
      {selection && (
        <div className="sa-filter" role="status">
          <span>
            Showing {listed.length} {listed.length === 1 ? "call" : "calls"} {selection.kind === "agent" ? "by" : "touching"}{" "}
            <span className="mono">{selection.label}</span>
          </span>
          <button type="button" className="btn" onClick={() => setKey(null)}>
            Clear
          </button>
        </div>
      )}
      <TimeGraph agents={agents} actions={actions} markers={markers} selected={selected} focusAgent={selection?.kind === "agent" ? selection.agent : null} />
      {files.length > 0 ? (
        <NodeGraph agents={agents} files={files} selection={selection ? key : null} onSelect={select} />
      ) : (
        <p className="muted">No file reads or changes recorded.</p>
      )}
      {selection && (
        <div className="sa-list">
          <ol>
            {listed.slice(0, LIST_MAX).map((i) => {
              const a = actions[i];
              const agent = agents[a.agent];
              return (
                <li key={actionKey(agents, a)}>
                  <Link href={eventHref(agent, a.seq)} className="sa-row">
                    <span className="ev-time">{clock(a.ts)}</span>
                    <span className="sa-agent" title={agent.title}>
                      <span className="sa-dot" style={{ background: agentColor(agent) }} />
                      {agent.title}
                    </span>
                    <span className="tool-name">
                      <span className="sa-dot" style={{ background: CATEGORY_COLOR[a.error ? "error" : a.cat] }} />
                      {a.tool}
                    </span>
                    <span className="secondary sa-label">{a.label}</span>
                    {a.error && <span className="error-text">failed</span>}
                  </Link>
                </li>
              );
            })}
          </ol>
          {listed.length > LIST_MAX && <p className="muted">and {listed.length - LIST_MAX} more</p>}
        </div>
      )}
    </div>
  );
}
