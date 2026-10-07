import Link from "next/link";
import { sourceLabel } from "../../src/adapters";
import { ERROR_CATEGORIES, type ErrorCategory } from "../../src/core/errors";
import { type ErrorBreakdown, errorTaxonomy } from "../../src/store/insights";
import { filterOptions } from "../../src/store/queries";
import { FilterBar } from "../components/FilterBar";
import { sessionHref } from "../components/search/shared";
import { StackedBarChart } from "../components/StackedBarChart";
import { Empty, SourceBadge, Tile } from "../components/ui";
import { dateTime, dayRange, integer, localDay, project, shortDay } from "../lib/format";
import { filtersFrom, queryOf, RANGES, ready, type SearchParams } from "../lib/server";
import "../insights.css";

/** Examples listed per category. */
const EXAMPLES = 5;
/** Rows in the per-tool table; the rest are summed into one row. */
const TOOL_ROWS = 15;

const COLOR: Record<ErrorCategory, string> = {
  interrupted: "var(--kind-thinking)",
  rate_limit: "var(--series-4)",
  edit_mismatch: "var(--series-2)",
  test_failure: "var(--series-8)",
  build_error: "var(--series-7)",
  timeout: "var(--series-5)",
  network: "var(--series-3)",
  permission: "var(--series-6)",
  not_found: "var(--series-1)",
  other: "var(--baseline)",
};

const LABEL = Object.fromEntries(ERROR_CATEGORIES.map((c) => [c.key, c.label])) as Record<ErrorCategory, string>;

function Swatch({ category }: { category: ErrorCategory }) {
  return <span className="er-swatch" style={{ "--c": COLOR[category] } as React.CSSProperties} aria-hidden="true" />;
}

/** Rows (a tool or an agent CLI) by category columns, only the categories that occur. */
function BreakdownTable<K>({ rows, columns, head, cell }: { rows: ErrorBreakdown<K>[]; columns: ErrorCategory[]; head: string; cell: (key: K) => React.ReactNode }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{head}</th>
            {columns.map((c) => (
              <th key={c} className="num">
                <Swatch category={c} />
                {LABEL[c]}
              </th>
            ))}
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r.key)}>
              <td>{cell(r.key)}</td>
              {columns.map((c) => (
                <td key={c} className={r.counts[c] ? "num" : "num muted"}>
                  {integer(r.counts[c])}
                </td>
              ))}
              <td className="num">{integer(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function ErrorsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const f = filtersFrom(params);
  const db = await ready();
  const t = errorTaxonomy(db, f, EXAMPLES);
  const options = filterOptions(db);
  const current = queryOf(f);
  const present = t.byCategory.filter((c) => c.count > 0);
  const columns = ERROR_CATEGORIES.map((c) => c.key).filter((k) => t.byCategory.some((c) => c.category === k && c.count > 0));
  const max = Math.max(1, ...t.byCategory.map((c) => c.count));
  const agentErrors = t.byTool.find((r) => r.key === null)?.total ?? 0;

  const tools = t.byTool.slice(0, TOOL_ROWS);
  const rest = t.byTool.slice(TOOL_ROWS);
  if (rest.length) {
    const counts = Object.fromEntries(columns.map((c) => [c, rest.reduce((sum, r) => sum + r.counts[c], 0)])) as Record<ErrorCategory, number>;
    tools.push({ key: `${rest.length} more tools`, total: rest.reduce((sum, r) => sum + r.total, 0), counts });
  }

  // Continuous day axis from the range start (or the first error) to the end of the range, so quiet days show as gaps.
  const until = f.to === undefined ? Date.now() : Math.min(f.to - 1, Date.now());
  const firstDay = f.from !== undefined ? localDay(f.from) : t.byDay[0]?.key;
  const days = firstDay ? dayRange(firstDay, localDay(until)) : [];
  const perDay = new Map(t.byDay.map((d) => [d.key, d]));
  /** A column drills into that day's errors: the same page, its window narrowed to the day. */
  const dayHrefs = days.map((d) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...current, from: d, to: d })) if (v) qs.set(k, v);
    return `/errors?${qs}`;
  });

  return (
    <>
      <div className="page-head">
        <h1>Errors</h1>
        <span className="muted">Failed tool calls and agent errors, sorted into categories by their message.</span>
      </div>
      <FilterBar
        ranges={RANGES.map((r) => ({ value: r.id, label: r.label }))}
        sources={options.sources.map((s) => ({ value: s, label: sourceLabel(s) }))}
        projects={options.projects.map((p) => ({ value: p, label: project(p) }))}
        current={current}
      />

      {t.total === 0 ? (
        <section className="card">
          <Empty>No failed tool calls or agent errors in this range.</Empty>
        </section>
      ) : (
        <>
          <div className="tiles">
            <Tile label="Failures" value={integer(t.total)} note={`${integer(t.total - agentErrors)} tool results · ${integer(agentErrors)} agent errors`} />
            <Tile label="Sessions affected" value={integer(t.sessions)} note="incl. subagent runs" />
            <Tile label="Most common" value={LABEL[present[0].category]} note={`${integer(present[0].count)} · ${Math.round((present[0].count / t.total) * 100)}%`} />
            <Tile label="Categorized" value={`${Math.round(((t.total - (t.byCategory.find((c) => c.category === "other")?.count ?? 0)) / t.total) * 100)}%`} note="not in Other" />
          </div>

          <div className="grid-2">
            <section className="card" aria-labelledby="by-category">
              <div className="card-head">
                <h2 id="by-category">By category</h2>
                <span className="muted">first matching rule wins</span>
              </div>
              <div className="er-bars">
                {ERROR_CATEGORIES.map((c) => {
                  const count = t.byCategory.find((b) => b.category === c.key)?.count ?? 0;
                  return (
                    <div key={c.key} style={{ display: "contents" }} className={count ? undefined : "er-zero"}>
                      <span title={c.note}>
                        <Swatch category={c.key} />
                        {count ? <a href={`#ex-${c.key}`}>{c.label}</a> : c.label}
                      </span>
                      <span className="num">{integer(count)}</span>
                      <span className="num muted">{count ? `${((count / t.total) * 100).toFixed(1)}%` : "—"}</span>
                      <span className="er-bar" style={{ "--c": COLOR[c.key], width: count ? `${Math.max(2, (count / max) * 100)}%` : 0 } as React.CSSProperties} />
                    </div>
                  );
                })}
              </div>
            </section>
            <section className="card" aria-labelledby="per-day">
              <div className="card-head">
                <h2 id="per-day">Per day</h2>
                <span className="muted">failures by category · open a day</span>
              </div>
              <StackedBarChart
                labels={days.map((d) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }))}
                ticks={days.map(shortDay)}
                series={columns.map((c) => ({ key: c, label: LABEL[c], color: COLOR[c], values: days.map((d) => perDay.get(d)?.counts[c] ?? 0) }))}
                hrefs={dayHrefs}
                format="tokens"
                ariaLabel="Failures per day by category"
              />
            </section>
          </div>

          <section className="card" aria-labelledby="by-tool">
            <div className="card-head">
              <h2 id="by-tool">Category × tool</h2>
              <span className="muted">agent errors belong to no tool</span>
            </div>
            <BreakdownTable rows={tools} columns={columns} head="Tool" cell={(key) => (key === null ? <span className="muted">(agent error)</span> : <span className="tool-name">{key}</span>)} />
          </section>

          <section className="card" aria-labelledby="by-source">
            <div className="card-head">
              <h2 id="by-source">Category × agent</h2>
              <span className="muted">by agent CLI</span>
            </div>
            <BreakdownTable rows={t.bySource} columns={columns} head="Agent" cell={(key) => <SourceBadge source={key} />} />
          </section>

          <section className="card" aria-labelledby="examples">
            <div className="card-head">
              <h2 id="examples">Recent examples</h2>
              <span className="muted">newest {EXAMPLES} per category, text clipped</span>
            </div>
            <div className="er-examples">
              {present.map(({ category, count }) => (
                <div key={category} id={`ex-${category}`}>
                  <h3>
                    <Swatch category={category} />
                    {LABEL[category]} <span className="muted">· {integer(count)}</span>
                  </h3>
                  <div className="table-wrap">
                    <table>
                      <tbody>
                        {t.examples[category].map((e) => (
                          <tr key={`${e.sessionId}:${e.seq}`} className="row-click">
                            <td className="num" style={{ textAlign: "left", whiteSpace: "nowrap" }}>
                              <Link className="row-link" href={sessionHref(e.sessionId, e.seq)}>
                                {dateTime(e.ts)}
                              </Link>
                              <span className="cell-sub">{e.title ?? e.sessionId}</span>
                            </td>
                            <td>
                              <SourceBadge source={e.source} />
                            </td>
                            <td className="tool-name">{e.tool ?? <span className="muted">agent</span>}</td>
                            <td className="er-snippet">{e.snippet || <span className="muted">(no text)</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="note">
            <p>
              Each failure gets the first matching category in this order: {ERROR_CATEGORIES.map((c) => c.label).join(" → ")}. So &quot;Test failed: ENOENT&quot;
              counts as a test failure and &quot;error TS2307: Cannot find module&quot; as a build error. Only the start and end of long outputs are
              read. Days are in the server&apos;s local time.
            </p>
          </div>
        </>
      )}
    </>
  );
}
