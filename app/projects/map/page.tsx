import Link from "next/link";
import { redirect } from "next/navigation";
import { sourceLabel } from "../../../src/adapters";
import { ancestors, buildTree, findDir, joinPath } from "../../../src/core/filetree";
import { projectFile, projectMap } from "../../../src/store/projects";
import { filterOptions } from "../../../src/store/queries";
import { FilterBar } from "../../components/FilterBar";
import { FilePanel } from "../../components/projects/FilePanel";
import { GourceLinks } from "../../components/projects/GourceLinks";
import { projectMapHref } from "../../components/projects/links";
import { type ColorMode, fillFor, Treemap, TreemapLegend } from "../../components/projects/Treemap";
import { Empty, Tile } from "../../components/ui";
import { ago, integer, project } from "../../lib/format";
import { first } from "../../lib/params";
import { filtersFrom, RANGES, ready, type SearchParams } from "../../lib/server";
import "../../projects.css";

/** Rows in the hot files table. */
const HOT_FILES = 50;

export default async function ProjectMapPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const f = filtersFrom(params);
  const cwd = f.cwd;
  if (!cwd) redirect("/projects");
  const db = await ready();
  const map = projectMap(db, cwd, f);
  const options = filterOptions(db);
  const mode: ColorMode = first(params.color) === "source" ? "source" : "ratio";
  const tree = buildTree(map.files);
  const dir = findDir(tree, first(params.dir) ?? "") ?? tree;
  const selected = first(params.file);
  const detail = selected ? projectFile(db, cwd, f, selected) : null;

  const state = { range: f.range, source: f.source, q: f.q, tag: f.tag, dir: dir.path || undefined, color: mode === "ratio" ? undefined : mode, file: selected };
  const href = (changes: Record<string, string | undefined>) => projectMapHref(cwd, { ...state, ...changes });
  const filters = { range: f.range, source: f.source, q: f.q, tag: f.tag };
  const sources = [...new Set(map.files.flatMap((x) => Object.keys(x.sources)))].sort();
  const changed = map.files.filter((x) => x.changes > 0).length;
  const prefix = dir.path ? joinPath(dir.path, "") : "";
  const hot = map.files.filter((x) => x.path.startsWith(prefix)).slice(0, HOT_FILES);

  return (
    <>
      <div className="page-head">
        <div className="crumbs">
          <Link href={`/projects?${new URLSearchParams({ range: f.range })}`}>Projects</Link>
        </div>
        <div className="page-head-row">
          <h1 title={cwd}>{project(cwd)}</h1>
          <GourceLinks params={{ project: cwd, ...filters }} />
          <Link className="muted" href={`/sessions?${new URLSearchParams({ project: cwd, range: f.range })}`}>
            Sessions →
          </Link>
        </div>
        <span className="muted mono">{cwd}</span>
      </div>
      <FilterBar
        ranges={RANGES.map((r) => ({ value: r.id, label: r.label }))}
        sources={options.sources.map((s) => ({ value: s, label: sourceLabel(s) }))}
        projects={options.projects.map((p) => ({ value: p, label: project(p) }))}
        current={{ ...state, project: cwd, dir: undefined, file: undefined }}
      />
      <div className="tiles">
        <Tile hero label="Files touched" value={integer(map.files.length)} note={`${integer(changed)} changed`} />
        <Tile label="Reads" value={integer(map.reads)} />
        <Tile label="Changes" value={integer(map.changes)} note="writes, edits, moves, deletes" />
        <Tile label="Sessions" value={integer(map.sessions)} note={`${integer(map.agents)} agents incl. subagents`} />
      </div>

      {map.files.length === 0 ? (
        <section className="card">
          <Empty>
            No file activity in this project for these filters.{" "}
            {f.range !== "all" && (
              <Link href={href({ range: "all", dir: undefined, file: undefined })} scroll={false}>
                Show all time
              </Link>
            )}
          </Empty>
        </section>
      ) : (
        <>
          <section className="card" aria-labelledby="file-map">
            <div className="card-head">
              <h2 id="file-map">File map</h2>
              <span className="muted">area = reads + changes across every session and subagent</span>
            </div>
            <div className="pm-toolbar">
              <nav className="pm-crumbs crumbs" aria-label="Directory">
                {ancestors(dir.path).map((a, i, all) => (
                  <span key={a.path}>
                    {i > 0 && all[i - 1].path !== "/" && " / "}
                    {i === all.length - 1 ? (
                      <span aria-current="location" className="mono">
                        {a.name || project(cwd)}
                      </span>
                    ) : (
                      <Link className="mono" href={href({ dir: a.path || undefined })} scroll={false}>
                        {a.name || project(cwd)}
                      </Link>
                    )}
                  </span>
                ))}
              </nav>
              <nav className="segmented" aria-label="Colour by">
                <Link href={href({ color: undefined })} aria-current={mode === "ratio" ? "true" : undefined} scroll={false}>
                  Reads vs changes
                </Link>
                <Link href={href({ color: "source" })} aria-current={mode === "source" ? "true" : undefined} scroll={false}>
                  Agent tool
                </Link>
              </nav>
              <TreemapLegend mode={mode} sources={sources} />
            </div>
            <div className={detail ? "pm-layout pm-with-panel" : "pm-layout"}>
              <Treemap
                dir={dir}
                mode={mode}
                selected={selected}
                dirHref={(p) => href({ dir: p || undefined })}
                fileHref={(p) => href({ file: p === selected ? undefined : p })}
              />
              {selected &&
                (detail ? (
                  <FilePanel detail={detail} closeHref={href({ file: undefined })} />
                ) : (
                  <aside className="pm-panel">
                    <p className="muted">
                      No touches of <span className="mono">{selected}</span> for these filters.
                    </p>
                    <Link className="btn" href={href({ file: undefined })} scroll={false}>
                      Close
                    </Link>
                  </aside>
                ))}
            </div>
          </section>

          <section className="card" aria-labelledby="hot-files">
            <div className="card-head">
              <h2 id="hot-files">Hot files</h2>
              <span className="muted">
                most touched{dir.path ? ` in ${dir.path}` : ""}
                {hot.length === HOT_FILES ? `, top ${HOT_FILES}` : ""}
              </span>
            </div>
            <div className="table-wrap">
              <table className="pm-hot">
                <thead>
                  <tr>
                    <th>File</th>
                    <th className="num">Touches</th>
                    <th className="num">Reads</th>
                    <th className="num" title="Writes, edits, moves and deletes">
                      Changes
                    </th>
                    <th className="num" title="Top-level sessions; subagent work counts toward its session">
                      Sessions
                    </th>
                    <th className="num" title="Sessions and subagents">
                      Agents
                    </th>
                    <th className="num">Last touched</th>
                  </tr>
                </thead>
                <tbody>
                  {hot.map((x) => (
                    <tr key={x.path} className="row-click" aria-current={x.path === selected ? "true" : undefined}>
                      <td>
                        <span className="swatch" style={{ background: fillFor({ reads: x.reads, changes: x.changes, sources: x.sources }, mode) }} />
                        <Link className="row-link mono" href={href({ file: x.path })} scroll={false} title={x.path}>
                          {x.path.slice(prefix.length)}
                        </Link>
                      </td>
                      <td className="num">{integer(x.reads + x.changes)}</td>
                      <td className="num">{integer(x.reads)}</td>
                      <td className="num">{integer(x.changes)}</td>
                      <td className="num">{integer(x.sessions)}</td>
                      <td className="num">{integer(x.agents)}</td>
                      <td className="num muted">{ago(x.last)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
