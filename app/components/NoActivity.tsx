import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import { adapters } from "../../src/adapters";
import { rootsEnvVar, rootsFor } from "../../src/ingest/sync";
import type { Db } from "../../src/store/db";
import { syncStatus } from "../../src/store/queries";
import { integer } from "../lib/format";
import { RANGES } from "../lib/server";
import { Empty } from "./ui";

const exists = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Fresh install: nothing has ever been ingested, so show where each adapter looked (the same roots sync scans, with
 * the server's environment) and how to point it elsewhere.
 */
function NoLogs() {
  const roots = adapters.map((a) => ({ adapter: a, dirs: rootsFor(a, process.env), env: rootsEnvVar(a.id) }));
  return (
    <section className="card" aria-labelledby="no-logs">
      <div className="card-head">
        <h2 id="no-logs">No agent logs found yet</h2>
        <span className="muted">nothing has been ingested</span>
      </div>
      <p className="muted" style={{ margin: "0 0 12px" }}>
        Agent Monitor reads the session logs the agent tools write on this machine. It looked in these folders and found none:
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>Folder</th>
              <th>Status</th>
              <th>Override</th>
            </tr>
          </thead>
          <tbody>
            {roots.flatMap(({ adapter, dirs, env }) =>
              (dirs.length ? dirs : [null]).map((dir, i) => (
                <tr key={`${adapter.id}:${dir ?? ""}`}>
                  <td>{i === 0 ? adapter.label : ""}</td>
                  <td className="mono" style={{ overflowWrap: "anywhere" }}>
                    {dir ?? "—"}
                  </td>
                  <td className="muted">{dir === null ? "no folder configured" : exists(dir) ? "exists, no session logs" : "not found"}</td>
                  <td className="mono muted">{i === 0 ? env : ""}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      <div className="note" style={{ marginTop: 12 }}>
        <p>Start a session in one of these tools and it appears here within a few seconds.</p>
        <p>
          Logs somewhere else? Set the tool&apos;s override variable to one or more folders (separated by <code>{path.delimiter}</code>) and restart the
          server. <code>pnpm sources</code> prints the folders in use.
        </p>
      </div>
    </section>
  );
}

/**
 * Empty state for a page whose filters matched nothing. With no log files at all (a fresh install) it lists the
 * folders that were scanned; otherwise it says nothing is in range and links to a wider view.
 */
export function NoActivity({
  db,
  subject,
  range,
  filtered,
  query,
  allTimeHref,
  clearHref,
}: {
  db: Db;
  /** "agent activity", "project activity": what is missing. */
  subject: string;
  range: string;
  /** Any filter besides the range (tool, project, tag, search) is set. */
  filtered: boolean;
  /** The search text, when set; named in the message (pages without a search box would otherwise hide it). */
  query?: string;
  /** The same view over all time, other filters kept. */
  allTimeHref: string;
  /** The same view over all time without any other filter. */
  clearHref: string;
}) {
  const status = syncStatus(db);
  if (status.files === 0) return <NoLogs />;
  const label = RANGES.find((r) => r.id === range && r.ms > 0)?.label;
  const failed = status.errors.length;
  const search = query ? ` (search “${query}”)` : "";
  // Missing activity may be in a log that could not be read; say so whatever the filters.
  const unread = failed > 0 && (
    <>
      {" "}
      {integer(failed)} log {failed === 1 ? "file" : "files"} could not be read.
    </>
  );
  return (
    <section className="card">
      <Empty>
        {label ? (
          <>
            No {subject} in the last {label}
            {filtered && " with these filters"}
            {search}. <Link href={allTimeHref}>Show all time</Link>
            {unread}
          </>
        ) : filtered ? (
          <>
            No {subject} matches these filters{search}. <Link href={clearHref}>Clear filters</Link>
            {unread}
          </>
        ) : (
          <>
            No {subject} in the {integer(status.files)} log {status.files === 1 ? "file" : "files"} read so far
            {failed > 0 && `; ${integer(failed)} could not be read`}.
          </>
        )}
      </Empty>
    </section>
  );
}
