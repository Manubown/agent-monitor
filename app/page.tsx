import Link from "next/link";
import { sourceLabel } from "../src/adapters";
import { totalTokens } from "../src/core/types";
import { loadLayout } from "../src/store/dashboard";
import { type ActiveSession, activeSessions, eventTimeline, filterOptions } from "../src/store/queries";
import { linkTo, widgetContext } from "./components/dashboard/context";
import { Dashboard, DashboardBar } from "./components/dashboard/Dashboard";
import { WIDGET_SPECS } from "./components/dashboard/specs";
import { FilterBar } from "./components/FilterBar";
import { NoActivity } from "./components/NoActivity";
import { PixelBand } from "./components/pixel/PixelBand";
import { Cost, PulseDot, SourceBadge, TagList } from "./components/ui";
import { ago, dayRangeLabel, integer, per, project, tokens, usd } from "./lib/format";
import { dayParam, first } from "./lib/params";
import { filtersFrom, queryOf, RANGES, ready, type SearchParams } from "./lib/server";

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

/**
 * The overview is a dashboard: the band, "Active now" (live and unfiltered) and the filter bar are fixed, everything
 * below them is the stored widget layout (`src/core/dashboard.ts`, `app/components/dashboard/`). The page itself
 * runs only the queries those fixed parts need; each widget runs its own, so a hidden widget costs nothing.
 */
export default async function OverviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const f = filtersFrom(params);
  const db = await ready();
  const now = Date.now();
  // A custom window ends where it ends, not today: the skyline, the heatmap and the day axis stop there.
  const until = f.to === undefined ? now : Math.min(f.to - 1, now);
  const active = activeSessions(db, now);
  const timeline = eventTimeline(db, f, until);
  const options = filterOptions(db);
  const range = RANGES.find((r) => r.id === f.range);
  const rangeLabel = f.days ? dayRangeLabel(f.days.from, f.days.to) : !range || range.id === "all" ? "all time" : `last ${range.label}`;
  const peak = Math.max(0, ...timeline.counts);
  const customize = first(params.customize) === "1";
  // `q` has no box on this page, but a link can carry it (the data below is filtered by it), so every link keeps it.
  const current = queryOf(f);
  const layout = loadLayout(db, WIDGET_SPECS);
  const ctx = widgetContext({ db, filters: f, now, until, rangeLabel, day: dayParam(params.day) ?? null, query: current, customize, layout });
  // The band needs the totals anyway; the summary and token-mix widgets share this one read.
  const o = ctx.overview();

  return (
    <>
      <PixelBand
        counts={timeline.counts}
        legend={`skyline = agent events per ${per(timeline.binMs)}, ${rangeLabel}${peak ? ` · peak ${integer(peak)}` : ""}`}
      >
        <div className="band-title" data-quiet>
          <h1>Overview</h1>
          <span className="band-sub">What your coding agents did and what it cost.</span>
        </div>
        <div className="band-stat" data-quiet>
          <span className="band-figure">{usd(o.cost)}</span>
          <span>
            {rangeLabel} · {active.length} {active.length === 1 ? "session" : "sessions"} active now
          </span>
        </div>
      </PixelBand>
      {active.length > 0 && (
        <section className="card" aria-labelledby="active-now">
          <div className="card-head">
            <h2 id="active-now">Active now</h2>
            <span className="muted">activity in the last 2 minutes, all tools and projects</span>
          </div>
          <div className="active-list">
            {active.map((s) => (
              <div key={s.id} className="active-row row-click">
                <PulseDot />
                <div>
                  <div className="active-title">
                    <Link className="row-link" href={`/sessions/${encodeURIComponent(s.id)}`}>
                      {s.title || s.nativeId}
                    </Link>
                    <SourceBadge source={s.source} />
                    {s.currentModel && <span className="mono muted">{s.currentModel}</span>}
                    <TagList tags={s.tags} autoTags={s.autoTags} />
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
        // The customize mode is part of the page's state, so changing a filter stays in it.
        current={{ ...current, customize: customize ? "1" : undefined }}
        // Only shown when a search is already applied, so it can be seen and cleared.
        search={Boolean(f.q)}
      />

      {o.requests === 0 && o.sessions === 0 ? (
        <NoActivity
          db={db}
          subject="agent activity"
          range={f.days ? "custom" : f.range}
          filtered={Boolean(f.source || f.cwd || f.tag || f.q || f.days)}
          query={f.q}
          allTimeHref={linkTo("/", { ...current, range: "all", from: undefined, to: undefined })}
          clearHref={linkTo("/", { range: "all" })}
        />
      ) : (
        <>
          <DashboardBar ctx={ctx} layout={layout} customize={customize} />
          <Dashboard ctx={ctx} layout={layout} customize={customize} />
        </>
      )}
    </>
  );
}
