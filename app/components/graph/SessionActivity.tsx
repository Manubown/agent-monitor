"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { SessionActivity as Activity } from "../../../src/store/activity";
import { clock } from "../../lib/format";
import { agentColor, CATEGORY_COLOR, eventHref } from "./categories";
import { NodeGraph, type Selection } from "./NodeGraph";
import { TimeGraph } from "./TimeGraph";
import "../../graph.css";

/** Rows listed under the graphs for a selection; the time graph still shows all of them. */
const LIST_MAX = 200;

/** "What it did": the session tree's tool calls over time and the files they touched, linked by selection. */
export function SessionActivity({ data }: { data: Activity }) {
  const { agents, actions, markers, files } = data;
  const [selection, setSelection] = useState<Selection | null>(null);

  const selected = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === "agent") return new Set(actions.flatMap((a, i) => (a.agent === selection.agent ? [i] : [])));
    return new Set(selection.files.flatMap((f) => files[f].actions));
  }, [selection, actions, files]);

  const listed = useMemo(
    () => (selected ? [...selected].sort((a, b) => actions[a].ts - actions[b].ts || a - b) : []),
    [selected, actions],
  );

  const select = (next: Selection) => setSelection((cur) => (cur?.key === next.key ? null : next));

  return (
    <div className="sa">
      {selection && (
        <div className="sa-filter" role="status">
          <span>
            Showing {listed.length} {listed.length === 1 ? "call" : "calls"} {selection.kind === "agent" ? "by" : "touching"}{" "}
            <span className="mono">{selection.label}</span>
          </span>
          <button type="button" className="btn" onClick={() => setSelection(null)}>
            Clear
          </button>
        </div>
      )}
      <TimeGraph agents={agents} actions={actions} markers={markers} selected={selected} focusAgent={selection?.kind === "agent" ? selection.agent : null} />
      {files.length > 0 ? (
        <NodeGraph agents={agents} files={files} selection={selection} onSelect={select} />
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
                <li key={i}>
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
