/**
 * The widget registry: one renderer per id of `specs.ts`. Every widget is a server component that runs its own
 * queries from `(db, filters)` in the context, so a hidden widget costs nothing — the page itself computes only what
 * the band, the filter bar and "Active now" need.
 *
 * `ctx.height` is the body height the slot's preset allows: the charts draw exactly that tall, and the tables get it
 * as a maximum through `--dash-h` in dashboard.css and scroll inside the card.
 */

import Link from "next/link";
import { HEATMAP_WEEKS } from "../../../src/core/heatmap";
import { totalTokens } from "../../../src/core/types";
import { activityHeatmap } from "../../../src/store/insights";
import { byModel, byProject, byTool } from "../../../src/store/queries";
import { ago, integer, tokens, usd } from "../../lib/format";
import { ActivityHeatmap } from "../insights/ActivityHeatmap";
import { projectMapHref } from "../projects/links";
import { SessionCards } from "../SessionCards";
import { StackedBarChart } from "../StackedBarChart";
import { Cost, ExportLinks, Meter, ProjectCell, SourceBadge, Tile } from "../ui";
import { linkTo, type WidgetContext } from "./context";
import type { WidgetId } from "./specs";

/** Projects listed before the table becomes a directory of its own. */
const PROJECTS = 10;
/** Tools listed; the tail is a long thin tail of one-off commands. */
const TOOLS = 12;

export const WIDGETS: Record<WidgetId, (ctx: WidgetContext) => React.ReactNode> = {
  sessions: (ctx) => <SessionCards db={ctx.db} filters={ctx.filters} now={ctx.now} />,
  summary: (ctx) => <Summary ctx={ctx} />,
  "cost-per-day": (ctx) => <CostPerDay ctx={ctx} />,
  "tokens-per-day": (ctx) => <TokensPerDay ctx={ctx} />,
  heatmap: (ctx) => <Heatmap ctx={ctx} />,
  "token-mix": (ctx) => <TokenMix ctx={ctx} />,
  tools: (ctx) => <Tools ctx={ctx} />,
  models: (ctx) => <Models ctx={ctx} />,
  projects: (ctx) => <Projects ctx={ctx} />,
};

function Summary({ ctx }: { ctx: WidgetContext }) {
  const o = ctx.overview();
  const contextTokens = o.input + o.cacheRead + o.cacheWrite;
  /** The sessions list under the same filters, sorted by the tile's measure. */
  const drill = (sort?: string) => linkTo("/sessions", { ...ctx.query, sort });

  return (
    <div className="tiles">
      <Tile
        hero
        label="Cost"
        value={usd(o.cost)}
        href={drill("cost")}
        note={
          <>
            {o.estimatedCost ? `${usd(o.estimatedCost)} estimated from list prices` : "as recorded by the tools"}
            {o.unpricedTokens > 0 && ` · ${tokens(o.unpricedTokens)} tokens unpriced`}
          </>
        }
      />
      <Tile label="Sessions" value={integer(o.sessions)} href={drill()} note={`+ ${integer(o.subagents)} subagent runs · ${integer(o.userMessages)} prompts`} />
      <Tile label="Tokens" value={tokens(totalTokens(o))} href={drill("tokens")} note={`${tokens(o.output)} output`} />
      <Tile
        label="Model requests"
        value={integer(o.requests)}
        href={drill("requests")}
        note={o.requests ? `${usd((o.cost ?? 0) / o.requests)} per request` : undefined}
      />
      <Tile label="Tool calls" value={integer(o.toolCalls)} href={drill("tools")} note={`${integer(o.errors)} errors`} />
      <Tile
        label="Cache hit rate"
        value={contextTokens ? `${Math.round((o.cacheRead / contextTokens) * 100)}%` : "—"}
        // Only a link while the token mix is on the dashboard; a hidden card has no anchor to jump to.
        href={ctx.shows("token-mix") ? "#token-mix" : undefined}
        note="of context tokens read from cache"
      />
    </div>
  );
}

function CostPerDay({ ctx }: { ctx: WidgetContext }) {
  const axis = ctx.dayAxis();
  return (
    <section className="card" aria-labelledby="cost-per-day">
      <div className="card-head">
        <h2 id="cost-per-day">Cost per day</h2>
        <span className="muted">by tool · open a day</span>
        <ExportLinks view="daily" filters={ctx.query} compact />
      </div>
      <StackedBarChart
        labels={axis.labels}
        ticks={axis.ticks}
        series={axis.series((r) => r.cost ?? 0)}
        hrefs={axis.hrefs}
        height={ctx.height}
        format="usd"
        ariaLabel="Cost per day by tool"
      />
    </section>
  );
}

function TokensPerDay({ ctx }: { ctx: WidgetContext }) {
  const axis = ctx.dayAxis();
  return (
    <section className="card" aria-labelledby="tokens-per-day">
      <div className="card-head">
        <h2 id="tokens-per-day">Tokens per day</h2>
        <span className="muted">by tool, all token types · open a day</span>
      </div>
      <StackedBarChart
        labels={axis.labels}
        ticks={axis.ticks}
        series={axis.series((r) => totalTokens(r))}
        hrefs={axis.hrefs}
        height={ctx.height}
        format="tokens"
        ariaLabel="Tokens per day by tool"
      />
    </section>
  );
}

function Heatmap({ ctx }: { ctx: WidgetContext }) {
  return (
    <ActivityHeatmap
      data={activityHeatmap(ctx.db, ctx.filters, ctx.until)}
      rangeNote={ctx.filters.from === undefined ? `last ${HEATMAP_WEEKS} weeks` : ctx.rangeLabel}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    />
  );
}

function TokenMix({ ctx }: { ctx: WidgetContext }) {
  const o = ctx.overview();
  const total = totalTokens(o);
  const mix = [
    { label: "Cache read", value: o.cacheRead, note: "re-sent context served from the prompt cache" },
    { label: "Cache write", value: o.cacheWrite, note: "context written to the cache" },
    { label: "Input (uncached)", value: o.input, note: "context billed at full input price" },
    { label: "Output", value: o.output, note: o.reasoning ? `${tokens(o.reasoning)} of it reasoning` : "replies, tool calls, thinking" },
  ];
  const max = Math.max(...mix.map((m) => m.value));

  return (
    <section className="card" id="token-mix" aria-labelledby="token-mix-title">
      <div className="card-head">
        <h2 id="token-mix-title">Token mix</h2>
        <span className="muted">{tokens(total)} total</span>
      </div>
      <div className="table-wrap">
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
                  <Meter value={m.value} max={max} />
                </td>
                <td className="num muted">{total ? `${((m.value / total) * 100).toFixed(1)}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Tools({ ctx }: { ctx: WidgetContext }) {
  const tools = byTool(ctx.db, ctx.filters).slice(0, TOOLS);
  const max = Math.max(1, ...tools.map((t) => t.calls));
  return (
    <section className="card" aria-labelledby="tools-used">
      <div className="card-head">
        <h2 id="tools-used">Tools used</h2>
        <span className="muted">{integer(ctx.overview().toolCalls)} calls</span>
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
                  <Meter value={t.calls} max={max} />
                </td>
                <td className={t.errors ? "num error-text" : "num muted"}>{t.errors ? `${t.errors} (${Math.round((t.errors / t.calls) * 100)}%)` : "0"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Models({ ctx }: { ctx: WidgetContext }) {
  const models = byModel(ctx.db, ctx.filters);
  return (
    <section className="card" aria-labelledby="models">
      <div className="card-head">
        <h2 id="models">Models</h2>
        <ExportLinks view="models" filters={ctx.query} compact />
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
  );
}

function Projects({ ctx }: { ctx: WidgetContext }) {
  const projects = byProject(ctx.db, ctx.filters).slice(0, PROJECTS);
  return (
    <section className="card" aria-labelledby="projects">
      <div className="card-head">
        <h2 id="projects">Projects</h2>
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
              <tr key={p.cwd ?? ""} className="row-click">
                <td>
                  <ProjectCell cwd={p.cwd} />
                  {p.cwd && (
                    <Link className="cell-sub" href={projectMapHref(p.cwd, { range: ctx.filters.range, source: ctx.filters.source })}>
                      File map →
                    </Link>
                  )}
                </td>
                <td className="num">{integer(p.sessions)}</td>
                <td className="num">{tokens(totalTokens(p))}</td>
                <td className="num">{usd(p.cost)}</td>
                <td className="num muted">{ago(p.lastActive, ctx.now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
