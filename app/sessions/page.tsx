import Link from "next/link";
import { sourceLabel } from "../../src/adapters";
import { totalTokens } from "../../src/core/types";
import { filterOptions, isActive, listSessions } from "../../src/store/queries";
import { FilterBar } from "../components/FilterBar";
import { Cost, Empty, ExportLinks, SourceBadge, TagList } from "../components/ui";
import { dateTime, duration, integer, project, tokens } from "../lib/format";
import { filtersFrom, RANGES, ready, type SearchParams } from "../lib/server";

const PAGE_SIZE = 50;

export default async function SessionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const f = filtersFrom(params);
  const page = Math.max(1, Number(params.page) || 1);
  const db = await ready();
  const { rows, total } = listSessions(db, f, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const options = filterOptions(db);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const now = Date.now();
  const current = { range: f.range, source: f.source, project: f.cwd, q: f.q, tag: f.tag };
  const pageHref = (p: number) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...current, page: String(p) })) if (v) qs.set(k, v);
    return `/sessions?${qs}`;
  };

  return (
    <>
      <div className="page-head">
        <div className="page-head-row">
          <h1>Sessions</h1>
          <ExportLinks view="sessions" filters={current} />
        </div>
        <span className="muted">
          {integer(total)} sessions active in range, most recently active first. Totals include the work of their subagents.
        </span>
      </div>
      <FilterBar
        search
        ranges={RANGES.map((r) => ({ value: r.id, label: r.label }))}
        sources={options.sources.map((s) => ({ value: s, label: sourceLabel(s) }))}
        projects={options.projects.map((p) => ({ value: p, label: project(p) }))}
        current={current}
      />
      <section className="card">
        {rows.length === 0 ? (
          <Empty>No sessions match these filters.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Tool</th>
                  <th>Model</th>
                  <th className="num">Started</th>
                  <th className="num">Duration</th>
                  <th className="num">Prompts</th>
                  <th className="num">Tool calls</th>
                  <th className="num">Errors</th>
                  <th className="num">Tokens</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td style={{ maxWidth: 420 }}>
                      <Link className="row-link" href={`/sessions/${encodeURIComponent(s.id)}`}>
                        {s.title || s.nativeId}
                      </Link>
                      {isActive(s.total.lastActive, now) && (
                        <>
                          {" "}
                          <span className="badge badge-live">Active</span>
                        </>
                      )}
                      <span className="cell-sub">
                        {project(s.cwd)}
                        {s.gitBranch && ` · ${s.gitBranch}`}
                        {s.subagents > 0 && ` · ${s.subagents} subagent${s.subagents === 1 ? "" : "s"}`}
                      </span>
                      <TagList tags={s.tags} />
                    </td>
                    <td>
                      <SourceBadge source={s.source} />
                    </td>
                    <td className="mono">{s.models[0] ?? "—"}</td>
                    <td className="num">{dateTime(s.startedAt)}</td>
                    <td className="num">{duration(Math.max(s.total.lastActive, s.endedAt) - s.startedAt)}</td>
                    <td className="num">{integer(s.userMessages)}</td>
                    <td className="num">{integer(s.total.toolCalls)}</td>
                    <td className={s.total.errors ? "num error-text" : "num muted"}>{integer(s.total.errors)}</td>
                    <td className="num">{tokens(totalTokens(s.total))}</td>
                    <td className="num">
                      <Cost value={s.total.cost} source={s.costSource} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="pager">
            {page > 1 && (
              <Link className="btn" href={pageHref(page - 1)}>
                ← Newer
              </Link>
            )}
            <span className="muted">
              Page {page} of {pages}
            </span>
            {page < pages && (
              <Link className="btn" href={pageHref(page + 1)}>
                Older →
              </Link>
            )}
          </div>
        )}
      </section>
    </>
  );
}
