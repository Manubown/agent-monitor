import Link from "next/link";
import { sourceLabel } from "../../src/adapters";
import { BLOCK_MS, burnRate, type UsageBlock, usageBlocks } from "../../src/core/windows";
import { claudeUsage, filterOptions } from "../../src/store/queries";
import { FilterBar } from "../components/FilterBar";
import { StackedBarChart } from "../components/StackedBarChart";
import { Empty, PulseDot, Tile } from "../components/ui";
import { dateTime, duration, integer, localDay, project, tokens, usd } from "../lib/format";
import { oneOfList } from "../lib/params";
import { filtersFrom, queryOf, RANGES, ready, type SearchParams } from "../lib/server";

const DEFAULT_RANGE = "7d";
const RANGE_IDS = RANGES.map((r) => r.id);
/** Rows this far before the range are read so the first block in range starts where it really started. */
const LOOKBEHIND_MS = 24 * 3600_000;

const hm = (ts: number): string => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

const TOKEN_SERIES = [
  { key: "cacheRead", label: "Cache read", color: "var(--series-1)" },
  { key: "cacheWrite", label: "Cache write", color: "var(--series-2)" },
  { key: "input", label: "Input", color: "var(--series-3)" },
  { key: "output", label: "Output", color: "var(--series-4)" },
] as const;

function TopSessions({ block, limit }: { block: UsageBlock; limit: number }) {
  return (
    <>
      {block.sessions.slice(0, limit).map((s, i) => (
        <span key={s.sessionId}>
          {i > 0 && " · "}
          <Link className="row-link" href={`/sessions/${encodeURIComponent(s.sessionId)}`}>
            {s.title || s.sessionId}
          </Link>{" "}
          <span className="muted">{tokens(s.tokens)}</span>
        </span>
      ))}
    </>
  );
}

function ActiveBlock({ block, now }: { block: UsageBlock; now: number }) {
  const elapsed = now - block.start;
  const rate = burnRate(block, now);
  return (
    <section className="card" aria-labelledby="active-block">
      <div className="card-head">
        <h2 id="active-block" className="title-row">
          <PulseDot label="Active window" />
          Current window
        </h2>
        <span className="muted">
          {dateTime(block.start)} – {hm(block.end)}
        </span>
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-label="Time elapsed in the current 5-hour window"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((elapsed / BLOCK_MS) * 100)}
      >
        <span style={{ width: `${Math.min(100, (elapsed / BLOCK_MS) * 100)}%` }} />
      </div>
      <div className="progress-labels">
        <span>{duration(elapsed)} elapsed</span>
        <span>
          {duration(block.end - now)} left · resets at {hm(block.end)}
        </span>
      </div>
      <div className="tiles" style={{ marginTop: 16 }}>
        <Tile label="Tokens so far" value={tokens(block.totalTokens)} note={`${integer(block.requests)} requests · ${tokens(block.tokens.output)} output`} />
        <Tile label="API-equivalent cost" value={usd(block.cost)} note={block.unpricedRequests ? `${block.unpricedRequests} requests unpriced` : "at list prices"} />
        <Tile
          label="Burn rate"
          value={rate ? `${tokens(rate.tokensPerMinute)}/min` : "—"}
          note={rate ? (rate.costPerHour === null ? "cost unpriced" : `${usd(rate.costPerHour)} per hour`) : "needs more than one request"}
        />
        <Tile
          label="Projected at reset"
          value={rate ? tokens(rate.projectedTokens) : "—"}
          note={rate && rate.projectedCost !== null ? `${usd(rate.projectedCost)} if the current rate holds` : "if the current rate holds"}
        />
      </div>
      <p className="muted" style={{ margin: "12px 0 0", fontSize: 13 }}>
        Models: <span className="mono">{block.models.join(", ")}</span>
        <br />
        Sessions: <TopSessions block={block} limit={3} />
      </p>
    </section>
  );
}

export default async function UsagePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  // An unknown or empty range falls back to this page's default, not the global one.
  const f = filtersFrom({ ...params, range: oneOfList(RANGE_IDS, params.range) ?? DEFAULT_RANGE });
  const db = await ready();
  const now = Date.now();
  const rows = claudeUsage(db, { ...f, from: f.from === undefined ? undefined : f.from - LOOKBEHIND_MS });
  const periods = usageBlocks(rows, now).filter((p) => f.from === undefined || p.end > f.from);
  const blocks = periods.filter((p): p is UsageBlock => p.kind === "block");
  const active = blocks.find((b) => b.active);
  const options = filterOptions(db);
  const busiest = blocks.reduce((max, b) => Math.max(max, b.totalTokens), 0);
  const current = queryOf(f);
  /** A window drills into the sessions of the days it covers (a window can straddle midnight). */
  const blockHrefs = blocks.map((b) => {
    const qs = new URLSearchParams();
    const bounds = { from: localDay(b.start), to: localDay(Math.min(b.end - 1, now)) };
    for (const [k, v] of Object.entries({ ...current, ...bounds })) if (v) qs.set(k, v);
    return `/sessions?${qs}`;
  });

  return (
    <>
      <div className="page-head">
        <h1>Usage windows</h1>
        <span className="muted">Claude requests grouped into 5-hour windows, the unit Anthropic&apos;s subscription limits reset on.</span>
      </div>
      <FilterBar
        ranges={RANGES.map((r) => ({ value: r.id, label: r.label }))}
        sources={options.sources.map((s) => ({ value: s, label: sourceLabel(s) }))}
        projects={options.projects.map((p) => ({ value: p, label: project(p) }))}
        current={current}
      />
      <div className="note">
        <p>
          A window opens with the first Claude request (rounded down to the full hour, UTC) and lasts 5 hours; the next request after it ends opens a new
          one. Costs are API-equivalent list prices, not what a subscription charges.
        </p>
        <p>
          Subscription limits apply per Anthropic account across Claude Code, claude.ai and every other client signed in with Claude OAuth (omp, for
          example). This page only counts the logs on this machine, and the actual limits are not recorded in them, so treat it as a lower bound.
        </p>
      </div>

      {blocks.length === 0 ? (
        <section className="card">
          <Empty>No Claude requests in this range.</Empty>
        </section>
      ) : (
        <>
          {active ? (
            <ActiveBlock block={active} now={now} />
          ) : (
            <section className="card">
              <span className="muted">No window is open. The next Claude request starts a new 5-hour window.</span>
            </section>
          )}

          <div className="tiles">
            <Tile label="Windows" value={integer(blocks.length)} note="in range" />
            <Tile label="Busiest window" value={tokens(busiest)} note="tokens" />
            <Tile label="Average window" value={tokens(blocks.reduce((sum, b) => sum + b.totalTokens, 0) / blocks.length)} note="tokens" />
            <Tile label="API-equivalent cost" value={usd(blocks.reduce<number | null>((sum, b) => (b.cost === null ? sum : (sum ?? 0) + b.cost), null))} note="all windows in range" />
          </div>

          <section className="card">
            <div className="card-head">
              <h2>Tokens per window</h2>
              <span className="muted">all token types, oldest first · open the sessions of a window</span>
            </div>
            <StackedBarChart
              labels={blocks.map((b) => `${dateTime(b.start)} – ${hm(b.end)}${b.active ? " (active)" : ""}`)}
              ticks={blocks.map((b) => new Date(b.start).toLocaleDateString("en-GB", { day: "numeric", month: "short" }))}
              series={TOKEN_SERIES.map((s) => ({ ...s, values: blocks.map((b) => b.tokens[s.key]) }))}
              notes={blocks.map((b) => [`${integer(b.requests)} requests · ${usd(b.cost)}`, b.models.join(", ")])}
              hrefs={blockHrefs}
              format="tokens"
              ariaLabel="Tokens per 5-hour window by token type"
            />
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Windows</h2>
              <span className="muted">newest first</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Window</th>
                    <th>Status</th>
                    <th className="num">Requests</th>
                    <th className="num">Input</th>
                    <th className="num">Cache write</th>
                    <th className="num">Cache read</th>
                    <th className="num">Output</th>
                    <th className="num">Total</th>
                    <th className="num">Cost</th>
                    <th>Models</th>
                    <th>Top session</th>
                  </tr>
                </thead>
                <tbody>
                  {[...periods].reverse().map((p) =>
                    p.kind === "gap" ? (
                      <tr key={`gap-${p.start}`} className="gap-row">
                        <td colSpan={11}>Idle for {duration(p.end - p.start)}</td>
                      </tr>
                    ) : (
                      <tr key={p.start}>
                        <td className="num" style={{ textAlign: "left" }}>
                          {dateTime(p.start)} – {hm(p.end)}
                          <span className="cell-sub">
                            requests {hm(p.firstRequest)}–{hm(p.lastRequest)}
                          </span>
                        </td>
                        <td>{p.active ? <span className="badge badge-live">Active</span> : <span className="muted">Completed</span>}</td>
                        <td className="num">{integer(p.requests)}</td>
                        <td className="num">{tokens(p.tokens.input)}</td>
                        <td className="num">{tokens(p.tokens.cacheWrite)}</td>
                        <td className="num">{tokens(p.tokens.cacheRead)}</td>
                        <td className="num">{tokens(p.tokens.output)}</td>
                        <td className="num">{tokens(p.totalTokens)}</td>
                        <td className="num">
                          {usd(p.cost)}
                          {p.unpricedRequests > 0 && <span className="muted" title={`${p.unpricedRequests} requests unpriced`}>*</span>}
                        </td>
                        <td className="mono">{p.models.join(", ")}</td>
                        <td>
                          <TopSessions block={p} limit={1} />
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
