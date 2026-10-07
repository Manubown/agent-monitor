"use client";

import { useState } from "react";
import type { ContextAgent } from "../../../src/store/turns";
import { clock, tokens, usd } from "../../lib/format";
import { sessionHref } from "../search/shared";
import { type ChartMarker, StackedBarChart } from "../StackedBarChart";
import "../../turns.css";

/** Context per model request, stacked by how it was billed, with compaction boundaries; one agent of the tree at a time. */
export function ContextCard({ agents }: { agents: ContextAgent[] }) {
  const [selected, setSelected] = useState(agents[0]?.id);
  const agent = agents.find((a) => a.id === selected) ?? agents[0];
  if (!agent) return null;
  const requests = agent.requests;
  const markers: ChartMarker[] = agent.compactions.map((c) => {
    const change = c.before !== null && c.after !== null ? `: ${tokens(c.before)} → ${tokens(c.after)}` : "";
    return {
      index: c.index,
      label: c.drop !== null && c.drop > 0 ? `-${tokens(c.drop)}` : "compacted",
      title: `${c.inferred ? "Inferred compaction (context drop, no compaction record)" : "Compaction"}${change}`,
      dashed: c.inferred,
    };
  });
  const inferred = agent.compactions.filter((c) => c.inferred).length;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Context per request</h2>
        <span className="muted">
          input + cache tokens sent with each model call
          {agent.compactions.length > 0 &&
            ` · ${agent.compactions.length} ${agent.compactions.length === 1 ? "compaction" : "compactions"}${inferred ? ` (${inferred} inferred, dashed)` : ""}`}
        </span>
        {agents.length > 1 && (
          <select className="select ctx-agent" aria-label="Agent" value={agent.id} onChange={(e) => setSelected(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.depth === 0 ? `This session · ${a.requests.length} requests` : `${"\u00a0\u00a0".repeat(a.depth)}${a.title} · ${a.requests.length}`}
              </option>
            ))}
          </select>
        )}
      </div>
      <StackedBarChart
        key={agent.id}
        labels={requests.map((u, i) => `Request ${i + 1} · ${clock(u.ts)}`)}
        ticks={requests.map((_, i) => String(i + 1))}
        series={[
          { key: "cacheRead", label: "Cache read", color: "var(--series-1)", values: requests.map((u) => u.cacheRead) },
          { key: "cacheWrite", label: "Cache write", color: "var(--series-2)", values: requests.map((u) => u.cacheWrite) },
          { key: "input", label: "Uncached input", color: "var(--series-3)", values: requests.map((u) => u.input) },
        ]}
        notes={requests.map((u) => [
          `${tokens(u.output)} output · ${usd(u.cost)}${u.costSource === "estimated" ? " est." : ""}`,
          u.model,
          ...(u.prompt ? [`Prompt: ${u.prompt}`] : []),
        ])}
        // Opens the event the request followed, in the timeline of the agent that made it.
        hrefs={requests.map((u) => (u.seq === null ? undefined : sessionHref(agent.id, u.seq)))}
        markers={markers}
        format="tokens"
        height={200}
        ariaLabel="Context tokens per model request by cache read, cache write and uncached input, with compaction boundaries"
      />
    </section>
  );
}
