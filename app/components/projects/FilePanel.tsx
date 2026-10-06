import Link from "next/link";
import type { TouchKind } from "../../../src/core/gource";
import type { FileCounts, FileDetail } from "../../../src/store/projects";
import { dateTime, integer } from "../../lib/format";
import { sourceColor } from "../ui";
import "../../projects.css";

/** Calls listed in the panel; a file read thousands of times would otherwise bloat every render of the page. */
const MAX_CALLS = 1000;

const KIND_LABEL: Record<TouchKind, string> = {
  read: "read",
  write: "write",
  edit: "edit",
  delete: "delete",
  "move-from": "moved away",
  "move-to": "moved here",
};

const changes = (c: FileCounts) => c.writes + c.edits + c.deletes + c.moves;

/** One file across sessions: who touched it how often, and every call linking to its timeline event. */
export function FilePanel({ detail, closeHref }: { detail: FileDetail; closeHref: string }) {
  const total = detail.agents.reduce((sum, a) => sum + a.reads + changes(a), 0);
  const shown = detail.calls.slice(0, MAX_CALLS);
  return (
    <aside className="pm-panel" aria-label={`File ${detail.path}`}>
      <div className="pm-panel-head">
        <h3 className="mono" title={detail.abs}>
          {detail.path}
        </h3>
        <Link className="btn" href={closeHref} scroll={false} aria-label="Close file panel">
          ×
        </Link>
      </div>
      <p className="muted">
        {integer(total)} touches by {integer(detail.agents.length)} {detail.agents.length === 1 ? "agent" : "agents"}
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th className="num">Reads</th>
              <th className="num" title="Writes, edits, moves and deletes">
                Changes
              </th>
            </tr>
          </thead>
          <tbody>
            {detail.agents.map((a) => (
              <tr key={a.sessionId} className="row-click">
                <td>
                  <span className="swatch" style={{ background: sourceColor(a.source) }} />
                  <Link className="row-link" href={`/sessions/${encodeURIComponent(a.sessionId)}`} title={a.title}>
                    {a.title}
                  </Link>
                  {a.subagent && <span className="cell-sub">subagent</span>}
                </td>
                <td className="num">{integer(a.reads)}</td>
                <td className="num">{integer(changes(a))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4>Calls</h4>
      {detail.calls.length > MAX_CALLS && (
        <p className="muted">
          Latest {integer(MAX_CALLS)} of {integer(detail.calls.length)} calls.
        </p>
      )}
      <ol className="pm-calls">
        {shown.map((c) => (
          <li key={`${c.sessionId}:${c.seq}:${c.kind}`}>
            <Link href={`/sessions/${encodeURIComponent(c.sessionId)}?at=${c.seq}#e-${c.seq}`} title={`${c.title} · event ${c.seq}`}>
              <span className="ev-time">{dateTime(c.ts)}</span>
              <span className={c.kind === "read" ? "pm-kind" : "pm-kind pm-kind-change"}>{KIND_LABEL[c.kind]}</span>
              <span className="pm-call-agent">
                <span className="swatch" style={{ background: sourceColor(c.source) }} />
                {c.title}
              </span>
              <span className="tool-name">{c.tool}</span>
            </Link>
          </li>
        ))}
      </ol>
    </aside>
  );
}
