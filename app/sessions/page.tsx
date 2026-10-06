import Link from "next/link";
import { sourceLabel } from "../../src/adapters";
import { totalTokens } from "../../src/core/types";
import { filterOptions, isActive, isSessionSort, listSessions, type SessionSort } from "../../src/store/queries";
import { FilterBar } from "../components/FilterBar";
import { Cost, Empty, ExportLinks, SourceBadge, TagList } from "../components/ui";
import { dateTime, duration, integer, project, tokens } from "../lib/format";
import { positiveInt } from "../lib/params";
import { filtersFrom, RANGES, ready, type SearchParams } from "../lib/server";

const PAGE_SIZE = 50;

const SORT_LABEL: Record<SessionSort, string> = {
  recent: "most recently active first",
  cost: "most expensive first",
  tokens: "most tokens first",
  requests: "most model requests first",
  tools: "most tool calls first",
  errors: "most errors first",
  duration: "longest first",
};

export default async function SessionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const f = filtersFrom(params);
  const sort: SessionSort = isSessionSort(params.sort) ? params.sort : "recent";
  const requested = positiveInt(params.page);
  const db = await ready();
  let { rows, total } = listSessions(db, f, { limit: PAGE_SIZE, offset: (requested - 1) * PAGE_SIZE }, sort);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Past the end (a stale link after sessions were deleted, a hand-edited URL): show the last page instead of nothing.
  const page = Math.min(requested, pages);
  if (page !== requested) ({ rows, total } = listSessions(db, f, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }, sort));
  const options = filterOptions(db);
  const now = Date.now();
  const current = { range: f.range, source: f.source, project: f.cwd, q: f.q, tag: f.tag, sort: sort === "recent" ? undefined : sort };
  const href = (changes: Record<string, string | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...current, ...changes })) if (v) qs.set(k, v);
    return `/sessions?${qs}`;
  };
  /** Sortable header: the active column links back to the default order. */
  const sortHeader = (by: SessionSort, label: string) => (
    <th className="num" aria-sort={sort === by ? "descending" : undefined}>
      <Link
        className={sort === by ? "sort-link sort-active" : "sort-link"}
        href={href({ sort: sort === by ? undefined : by })}
        title={sort === by ? "Sorted, highest first; click for most recently active first" : "Sort, highest first"}
        scroll={false}
      >
        {label}
        <span aria-hidden="true">{sort === by ? " ↓" : ""}</span>
      </Link>
    </th>
  );

  return (
    <>
      <div className="page-head">
        <div className="page-head-row">
          <h1>Sessions</h1>
          <ExportLinks view="sessions" filters={current} />
        </div>
        <span className="muted">
          {integer(total)} sessions active in range, {SORT_LABEL[sort]}. Totals include the work of their subagents.
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
                  {sortHeader("duration", "Duration")}
                  <th className="num">Prompts</th>
                  {sortHeader("tools", "Tool calls")}
                  {sortHeader("errors", "Errors")}
                  {sortHeader("tokens", "Tokens")}
                  {sortHeader("cost", "Cost")}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className="row-click">
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
                      <TagList tags={s.tags} autoTags={s.autoTags} />
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
              <Link className="btn" href={href({ page: String(page - 1) })}>
                {sort === "recent" ? "← Newer" : "← Previous"}
              </Link>
            )}
            <span className="muted">
              Page {page} of {pages}
            </span>
            {page < pages && (
              <Link className="btn" href={href({ page: String(page + 1) })}>
                {sort === "recent" ? "Older →" : "Next →"}
              </Link>
            )}
          </div>
        )}
      </section>
    </>
  );
}
