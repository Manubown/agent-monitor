import Link from "next/link";
import type { LoopKind } from "../../src/core/loops";
import type { OpCounts, SessionActivity } from "../../src/store/activity";
import type { SessionLoop } from "../../src/store/loops";
import { clock, duration, integer } from "../lib/format";
import { agentColor, CATEGORY_COLOR, eventHref } from "./graph/categories";
import "../graph.css";
import "../file-heat.css";

/** Files listed before "Show all". */
const TOP_FILES = 15;
/** Calls listed under an expanded file. */
const CALLS_MAX = 200;

const LOOP_LABEL: Record<LoopKind, string> = { edit: "edit loop", command: "failing command", call: "repeated failed call" };

const changesOf = (f: OpCounts) => f.writes + f.edits + f.deletes + f.moves;
const plural = (n: number, one: string) => `${integer(n)} ${n === 1 ? one : `${one}s`}`;

/** "File heat": files the session tree touched, hottest first, with retry loops flagged on top. */
export function FileHeat({ data, loops }: { data: SessionActivity; loops: SessionLoop[] }) {
  const { agents, actions } = data;
  const files = data.files
    .map((f, i) => ({ f, i, reads: f.reads, changes: changesOf(f) }))
    .filter((x) => x.reads + x.changes > 0)
    .sort((a, b) => b.reads + b.changes - (a.reads + a.changes) || b.changes - a.changes || a.f.path.localeCompare(b.f.path));
  const max = Math.max(1, ...files.map((x) => x.reads + x.changes));
  const loopsByFile = new Map<number, SessionLoop[]>();
  for (const l of loops) if (l.file !== null) loopsByFile.set(l.file, [...(loopsByFile.get(l.file) ?? []), l]);
  const multiAgent = agents.length > 1;

  const row = ({ f, i, reads, changes }: (typeof files)[number]) => {
    const fileLoops = loopsByFile.get(i) ?? [];
    const loopSeqs = new Set(fileLoops.flatMap((l) => l.seqs.map((s) => `${l.agent}:${s}`)));
    const calls = [...f.actions].sort((a, b) => actions[a].ts - actions[b].ts || a - b);
    const total = reads + changes;
    return (
      <li key={i} className={fileLoops.length ? "fh-file fh-hot" : "fh-file"}>
        <details>
          <summary className="fh-row">
            <span className="fh-path mono" title={f.path}>
              {f.dir && <span className="muted">{f.dir}/</span>}
              {f.path.slice(f.dir ? f.dir.length + 1 : 0)}
              {fileLoops.length > 0 && (
                <span className="fh-flag" title={fileLoops.map((l) => `edited ${l.count} times, ${l.failures} right after a failure`).join("; ")}>
                  loop
                </span>
              )}
            </span>
            <span
              className="fh-bar"
              role="img"
              aria-label={`${plural(reads, "read")}, ${plural(changes, "change")}`}
              title={`${plural(reads, "read")} · ${plural(changes, "change")}${f.deletes ? ` (${f.deletes} deleted)` : ""}`}
            >
              <span className="fh-fill" style={{ width: `${(total / max) * 100}%` }}>
                {reads > 0 && <span style={{ flexGrow: reads, color: CATEGORY_COLOR.read }} />}
                {changes > 0 && <span style={{ flexGrow: changes, color: CATEGORY_COLOR.write }} />}
              </span>
            </span>
            <span className="num">{integer(total)}</span>
            <span className="fh-agents">
              {multiAgent &&
                f.agents.map((by) => (
                  <span key={by.agent} className="fh-agent" title={`${agents[by.agent].title}: ${by.reads} reads, ${changesOf(by)} changes`}>
                    <span className="sa-dot" style={{ background: agentColor(agents[by.agent]) }} />
                    {integer(by.reads + changesOf(by))}
                  </span>
                ))}
            </span>
            <span className="fh-when muted" title={`${clock(f.first)} – ${clock(f.last)}`}>
              {clock(f.first)}
              {f.last > f.first && ` +${duration(f.last - f.first)}`}
            </span>
          </summary>
          <ol className="fh-calls">
            {calls.slice(0, CALLS_MAX).map((ai) => {
              const a = actions[ai];
              const agent = agents[a.agent];
              return (
                <li key={ai}>
                  <Link href={eventHref(agent, a.seq)} className={loopSeqs.has(`${a.agent}:${a.seq}`) ? "sa-row fh-in-loop" : "sa-row"}>
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
          {calls.length > CALLS_MAX && <p className="muted">and {integer(calls.length - CALLS_MAX)} more</p>}
        </details>
      </li>
    );
  };

  return (
    <div className="fh">
      {loops.length > 0 && (
        <ol className="fh-loops" aria-label="Retry loops">
          {loops.map((l) => {
            const agent = agents[l.agent];
            return (
              <li key={`${l.agent}:${l.kind}:${l.firstSeq}:${l.subject}`} className="fh-loop">
                <span className="fh-flag">{LOOP_LABEL[l.kind]}</span>
                <Link href={eventHref(agent, l.firstSeq)} className="fh-loop-subject mono" title={l.subject}>
                  {l.subject}
                </Link>
                <span className="secondary">
                  {l.kind === "edit" ? `edited ${l.count} times, ${l.failures} right after a failure` : `failed ${l.count} times in a row`}
                  {" · "}
                  {clock(l.firstTs)}
                  {l.lastTs > l.firstTs && ` +${duration(l.lastTs - l.firstTs)}`}
                </span>
                {multiAgent && (
                  <span className="sa-agent" title={agent.title}>
                    <span className="sa-dot" style={{ background: agentColor(agent) }} />
                    {agent.title}
                  </span>
                )}
                <span className="fh-loop-links">
                  <Link href={eventHref(agent, l.firstSeq)}>first</Link>
                  <Link href={eventHref(agent, l.lastSeq)}>last</Link>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {files.length === 0 ? (
        <p className="muted">No file reads or changes recorded.</p>
      ) : (
        <>
          <div className="fh-legend muted">
            <span>
              <span className="sa-dot" style={{ background: CATEGORY_COLOR.read }} />
              reads
            </span>
            <span>
              <span className="sa-dot" style={{ background: CATEGORY_COLOR.write }} />
              changes (writes, edits, deletes, moves)
            </span>
            <span>click a file for its calls</span>
          </div>
          <ol className="fh-files">{files.slice(0, TOP_FILES).map(row)}</ol>
          {files.length > TOP_FILES && (
            <details className="fh-more">
              <summary className="btn">Show all {integer(files.length)} files</summary>
              <ol className="fh-files">{files.slice(TOP_FILES).map(row)}</ol>
            </details>
          )}
        </>
      )}
    </div>
  );
}
