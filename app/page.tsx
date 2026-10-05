import Link from "next/link";
import { adapters, sourceLabel } from "../src/adapters";
import { totalTokens } from "../src/core/types";
import { type ActiveSession, activeSessions, byModel, byProject, byTool, daily, filterOptions, listSessions, overview } from "../src/store/queries";
import { FilterBar } from "./components/FilterBar";
import { type ChartSeries, StackedBarChart } from "./components/StackedBarChart";
import { Cost, Empty, ExportLinks, Meter, ProjectCell, PulseDot, SourceBadge, sourceColor, Tile } from "./components/ui";
import { ago, dayRange, duration, integer, localDay, project, shortDay, tokens, usd } from "./lib/format";
import { filtersFrom, RANGES, ready, type SearchParams } from "./lib/server";

const EVENT_LABEL: Record<string, string> = {
  user: "Prompt",
  assistant: "Reply",
  thinking: "Thinking",
  system: "System",
  error: "Error",
};

/** "Bash · 12 s ago": what the session did last. */
function lastEventLabel(e: ActiveSession["lastEvent"], now: number): string {
  if (!e) return "no events yet";
  const what =
    e.kind === "tool_call" ? (e.toolName ?? "Tool call") : e.kind === "tool_result" ? `${e.toolName ?? "Tool"} result` : (EVENT_LABEL[e.kind] ?? e.kind);
  const seconds = Math.max(0, Math.round((now - e.ts) / 1000));
  return `${what} · ${seconds < 60 ? `${seconds} s ago` : ago(e.ts, now)}`;
}

export default async function OverviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const f = filtersFrom(params);
  const db = await ready();
  const o = overview(db, f);
  const days = daily(db, f);
  const models = byModel(db, f);
  const projects = byProject(db, f).slice(0, 10);
  const tools = byTool(db, f).slice(0, 12);
  const recent = listSessions(db, f, { limit: 6, offset: 0 }).rows;
  const options = filterOptions(db);
  const now = Date.now();
  const active = activeSessions(db, now);
  const current = { range: f.range, source: f.source, project: f.cwd, tag: f.tag };

  // Continuous day axis so idle days show as gaps rather than disappearing.
  const firstDay = f.from ? localDay(f.from) : days[0]?.day;
  const dayList = firstDay ? dayRange(firstDay, localDay(Date.now())) : [];
  const present = new Set(days.map((d) => d.source));
  const sources = [...adapters.map((a) => a.id), ...[...present].filter((s) => !adapters.some((a) => a.id === s))].filter((s) => present.has(s));
  const seriesFor = (value: (row: (typeof days)[number]) => number): ChartSeries[] =>
    sources.map((source) => ({
      key: source,
      label: sourceLabel(source),
      color: sourceColor(source),
      values: dayList.map((day) => {
        const row = days.find((d) => d.day === day && d.source === source);
        return row ? value(row) : 0;
      }),
    }));
  const fullDays = dayList.map((d) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }));

  const tokenTotal = totalTokens(o);
  const contextTokens = o.input + o.cacheRead + o.cacheWrite;
  const mix = [
    { label: "Cache read", value: o.cacheRead, note: "re-sent context served from the prompt cache" },
    { label: "Cache write", value: o.cacheWrite, note: "context written to the cache" },
    { label: "Input (uncached)", value: o.input, note: "context billed at full input price" },
    { label: "Output", value: o.output, note: o.reasoning ? `${tokens(o.reasoning)} of it reasoning` : "replies, tool calls, thinking" },
  ];
  const maxMix = Math.max(...mix.map((m) => m.value));
  const maxTool = Math.max(1, ...tools.map((t) => t.calls));

  return (
    <>
      <div className="page-head">
        <h1>Overview</h1>
        <span className="muted">What your coding agents did and what it cost.</span>
      </div>
      {active.length > 0 && (
        <section className="card" aria-labelledby="active-now">
          <div className="card-head">
            <h2 id="active-now">Active now</h2>
            <span className="muted">activity in the last 2 minutes, all tools and projects</span>
          </div>
          <div className="active-list">
            {active.map((s) => (
              <div key={s.id} className="active-row">
                <PulseDot />
                <div>
                  <div className="active-title">
                    <Link className="row-link" href={`/sessions/${encodeURIComponent(s.id)}`}>
                      {s.title || s.nativeId}
                    </Link>
                    <SourceBadge source={s.source} />
                    {s.currentModel && <span className="mono muted">{s.currentModel}</span>}
                  </div>
                  <span className="cell-sub">
                    {lastEventLabel(s.lastEvent, now)} · {project(s.cwd)}
                    {s.subagents > 0 && ` · ${s.subagents} subagent${s.subagents === 1 ? "" : "s"}`}
                  </span>
                </div>
                <span className="num">
                  {tokens(totalTokens(s.total))} tokens · <Cost value={s.total.cost} source={s.costSource} />
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      <FilterBar
        ranges={RANGES.map((r) => ({ value: r.id, label: r.label }))}
        sources={options.sources.map((s) => ({ value: s, label: sourceLabel(s) }))}
        projects={options.projects.map((p) => ({ value: p, label: project(p) }))}
        current={current}
      />

      {o.requests === 0 && o.sessions === 0 ? (
        <div className="card">
          <Empty>
            No agent activity in this range. Logs are read from each tool&apos;s session folder; run{" "}
            <code>pnpm sources</code> to see where agent-monitor looks.
          </Empty>
        </div>
      ) : (
        <>
          <div className="tiles">
            <Tile
              hero
              label="Cost"
              value={usd(o.cost)}
              note={
                <>
                  {o.estimatedCost ? `${usd(o.estimatedCost)} estimated from list prices` : "as recorded by the tools"}
                  {o.unpricedTokens > 0 && ` · ${tokens(o.unpricedTokens)} tokens unpriced`}
                </>
              }
            />
            <Tile label="Sessions" value={integer(o.sessions)} note={`+ ${integer(o.subagents)} subagent runs · ${integer(o.userMessages)} prompts`} />
            <Tile label="Tokens" value={tokens(tokenTotal)} note={`${tokens(o.output)} output`} />
            <Tile label="Model requests" value={integer(o.requests)} note={o.requests ? `${usd((o.cost ?? 0) / o.requests)} per request` : undefined} />
            <Tile label="Tool calls" value={integer(o.toolCalls)} note={`${integer(o.errors)} errors`} />
            <Tile label="Cache hit rate" value={contextTokens ? `${Math.round((o.cacheRead / contextTokens) * 100)}%` : "—"} note="of context tokens read from cache" />
          </div>

          <div className="grid-2">
            <section className="card">
              <div className="card-head">
                <h2>Cost per day</h2>
                <span className="muted">by tool</span>
                <ExportLinks view="daily" filters={current} compact />
              </div>
              <StackedBarChart labels={fullDays} ticks={dayList.map(shortDay)} series={seriesFor((r) => r.cost ?? 0)} format="usd" ariaLabel="Cost per day by tool" />
            </section>
            <section className="card">
              <div className="card-head">
                <h2>Tokens per day</h2>
                <span className="muted">by tool, all token types</span>
              </div>
              <StackedBarChart labels={fullDays} ticks={dayList.map(shortDay)} series={seriesFor((r) => totalTokens(r))} format="tokens" ariaLabel="Tokens per day by tool" />
            </section>
          </div>

          <div className="grid-2">
            <section className="card">
              <div className="card-head">
                <h2>Token mix</h2>
                <span className="muted">{tokens(tokenTotal)} total</span>
              </div>
              <table>
                <tbody>
                  {mix.map((m) => (
                    <tr key={m.label}>
                      <td>
                        {m.label}
                        <span className="cell-sub">{m.note}</span>
                      </td>
                      <td className="num">
                        {tokens(m.value)}
                        <Meter value={m.value} max={maxMix} />
                      </td>
                      <td className="num muted">{tokenTotal ? `${((m.value / tokenTotal) * 100).toFixed(1)}%` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="card">
              <div className="card-head">
                <h2>Tools used</h2>
                <span className="muted">{integer(o.toolCalls)} calls</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Tool</th>
                      <th className="num">Calls</th>
                      <th className="num">Failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tools.map((t) => (
                      <tr key={t.tool}>
                        <td className="tool-name">{t.tool}</td>
                        <td className="num">
                          {integer(t.calls)}
                          <Meter value={t.calls} max={maxTool} />
                        </td>
                        <td className={t.errors ? "num error-text" : "num muted"}>{t.errors ? `${t.errors} (${Math.round((t.errors / t.calls) * 100)}%)` : "0"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <section className="card">
            <div className="card-head">
              <h2>Models</h2>
              <ExportLinks view="models" filters={current} compact />
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Tool</th>
                    <th className="num">Requests</th>
                    <th className="num">Input</th>
                    <th className="num">Cache write</th>
                    <th className="num">Cache read</th>
                    <th className="num">Output</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={`${m.source}:${m.model}`}>
                      <td className="mono">{m.model}</td>
                      <td>
                        <SourceBadge source={m.source} />
                      </td>
                      <td className="num">{integer(m.requests)}</td>
                      <td className="num">{tokens(m.input)}</td>
                      <td className="num">{tokens(m.cacheWrite)}</td>
                      <td className="num">{tokens(m.cacheRead)}</td>
                      <td className="num">{tokens(m.output)}</td>
                      <td className="num">
                        <Cost value={m.cost} source={m.costSource} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid-2">
            <section className="card">
              <div className="card-head">
                <h2>Projects</h2>
                <span className="muted">by working directory</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th className="num">Sessions</th>
                      <th className="num">Tokens</th>
                      <th className="num">Cost</th>
                      <th className="num">Last active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((p) => (
                      <tr key={p.cwd ?? ""}>
                        <td>
                          <ProjectCell cwd={p.cwd} />
                        </td>
                        <td className="num">{integer(p.sessions)}</td>
                        <td className="num">{tokens(totalTokens(p))}</td>
                        <td className="num">{usd(p.cost)}</td>
                        <td className="num muted">{ago(p.lastActive)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="card">
              <div className="card-head">
                <h2>Recent sessions</h2>
                <Link className="muted" href="/sessions">
                  All sessions →
                </Link>
              </div>
              <div className="table-wrap">
                <table>
                  <tbody>
                    {recent.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <Link className="row-link" href={`/sessions/${encodeURIComponent(s.id)}`}>
                            {s.title || s.nativeId}
                          </Link>
                          <span className="cell-sub">
                            {project(s.cwd)} · {ago(s.total.lastActive)} · {duration(s.endedAt - s.startedAt)}
                            {s.subagents > 0 && ` · ${s.subagents} subagents`}
                          </span>
                        </td>
                        <td>
                          <SourceBadge source={s.source} />
                        </td>
                        <td className="num">{usd(s.total.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </>
      )}
    </>
  );
}
