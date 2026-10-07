import Link from "next/link";
import { sourceLabel } from "../../src/adapters";
import { listProjects } from "../../src/store/projects";
import { filterOptions } from "../../src/store/queries";
import { FilterBar } from "../components/FilterBar";
import { projectMapHref } from "../components/projects/links";
import { NoActivity } from "../components/NoActivity";
import { sourceColor } from "../components/ui";
import { ago, integer, project, tokens, usd } from "../lib/format";
import { filtersFrom, queryOf, RANGES, ready, type SearchParams } from "../lib/server";
import "../projects.css";

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const f = filtersFrom(params);
  const db = await ready();
  const rows = listProjects(db, f);
  const options = filterOptions(db);
  const current = queryOf(f);
  const filters = { ...current, project: undefined };
  const projectsHref = (query: Record<string, string | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) qs.set(k, v);
    return `/projects?${qs}`;
  };
  /** That project's sessions under the same filters (the window included). */
  const sessionsHref = (cwd: string) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...current, project: cwd })) if (v) qs.set(k, v);
    return `/sessions?${qs}`;
  };

  return (
    <>
      <div className="page-head">
        <div className="page-head-row">
          <h1>Projects</h1>
        </div>
        <span className="muted">
          {integer(rows.length)} working directories with sessions active in range. Files changed counts files any agent wrote, edited, moved or deleted
          there, subagents included.
        </span>
      </div>
      <FilterBar
        search
        ranges={RANGES.map((r) => ({ value: r.id, label: r.label }))}
        sources={options.sources.map((s) => ({ value: s, label: sourceLabel(s) }))}
        projects={options.projects.map((p) => ({ value: p, label: project(p) }))}
        current={current}
      />
      {rows.length === 0 ? (
        <NoActivity
          db={db}
          subject="project activity"
          range={f.days ? "custom" : f.range}
          filtered={Boolean(f.source || f.cwd || f.q || f.tag || f.days)}
          allTimeHref={projectsHref({ ...current, range: "all", from: undefined, to: undefined })}
          clearHref={projectsHref({ range: "all" })}
        />
      ) : (
        <section className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Tools</th>
                  <th className="num">Sessions</th>
                  <th className="num" title="Sessions plus their subagents">
                    Agents
                  </th>
                  <th className="num" title="Files written, edited, moved or deleted">
                    Files changed
                  </th>
                  <th className="num" title="Files read or changed">
                    Files touched
                  </th>
                  <th className="num">Tokens</th>
                  <th className="num">Cost</th>
                  <th className="num">Last active</th>
                  <th>
                    <span className="pm-sr">Sessions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.cwd} className="row-click">
                    <td>
                      <Link className="row-link" href={projectMapHref(p.cwd, filters)} title={`File map of ${p.cwd}`}>
                        {project(p.cwd)}
                      </Link>
                      <span className="cell-sub mono">{p.cwd}</span>
                    </td>
                    <td>
                      <span className="pm-sources">
                        {p.sources.map((s) => (
                          <span key={s} title={sourceLabel(s)}>
                            <span className="swatch" style={{ background: sourceColor(s) }} />
                            {sourceLabel(s)}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="num">{integer(p.sessions)}</td>
                    <td className="num">{integer(p.agents)}</td>
                    <td className="num">{integer(p.filesChanged)}</td>
                    <td className="num">{integer(p.filesTouched)}</td>
                    <td className="num">{tokens(p.tokens)}</td>
                    <td className="num">{usd(p.cost)}</td>
                    <td className="num muted">{ago(p.lastActive)}</td>
                    <td>
                      <Link className="muted" href={sessionsHref(p.cwd)}>
                        Sessions →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
