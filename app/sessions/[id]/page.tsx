import Link from "next/link";
import { notFound } from "next/navigation";
import { adapterById } from "../../../src/adapters";
import { totalTokens } from "../../../src/core/types";
import { sessionActivity } from "../../../src/store/activity";
import { allTags, type EventRow, getSession, isActive, sessionEvents, sessionEventTimeline, TIMELINE_PAGE, timelineWindow } from "../../../src/store/queries";
import { CopyCommand, TagEditor, TimelineFilter } from "../../components/client";
import { SessionActivity } from "../../components/graph/SessionActivity";
import { PixelBand } from "../../components/pixel/PixelBand";
import { StackedBarChart } from "../../components/StackedBarChart";
import { Cost, Meter, PulseDot, SourceBadge, Tile } from "../../components/ui";
import { clock, dateTime, duration, integer, per, tokens, usd } from "../../lib/format";
import { ready, type SearchParams } from "../../lib/server";

const KIND_LABEL: Record<string, string> = {
  user: "Prompt",
  assistant: "Reply",
  thinking: "Thinking",
  tool_call: "Tool call",
  tool_result: "Result",
  system: "System",
  error: "Error",
};

const KIND_COLOR: Record<string, string> = {
  user: "var(--kind-user)",
  assistant: "var(--kind-assistant)",
  thinking: "var(--kind-thinking)",
  tool_call: "var(--kind-tool)",
  tool_result: "var(--kind-tool)",
  system: "var(--kind-system)",
  error: "var(--kind-error)",
};

/** Pretty-print JSON tool input; fall back to the raw string. */
const prettyInput = (input: string | null): string => {
  if (!input) return "";
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
};

/** One-line preview of a tool call's arguments. */
const inputPreview = (input: string | null): string => {
  if (!input) return "";
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === "object") {
      const values = Object.values(parsed as Record<string, unknown>).filter((v) => typeof v === "string" || typeof v === "number");
      return values.join(" · ").replace(/\s+/g, " ").slice(0, 160);
    }
  } catch {
    // Not JSON.
  }
  return input.replace(/\s+/g, " ").slice(0, 160);
};

const firstLine = (text: string | null, max = 160) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function EventBody({ e }: { e: EventRow }) {
  switch (e.kind) {
    case "user":
    case "assistant":
    case "error":
      return <pre className="ev-text">{e.text}</pre>;
    case "tool_call":
      return (
        <details>
          <summary>
            <span className="tool-name">{e.toolName ?? "tool"}</span> <span className="secondary">{inputPreview(e.toolInput)}</span>
          </summary>
          <pre className="ev-pre mono">{prettyInput(e.toolInput)}</pre>
        </details>
      );
    case "tool_result":
      return (
        <details>
          <summary className={e.isError ? "error-text" : "secondary"}>
            {e.toolName && <span className="tool-name">{e.toolName} </span>}
            {e.isError ? "failed: " : ""}
            {firstLine(e.text) || "(empty)"}
          </summary>
          <pre className="ev-pre mono">{e.text}</pre>
        </details>
      );
    default:
      return (
        <details>
          <summary className="secondary">{firstLine(e.text) || "(empty)"}</summary>
          <pre className="ev-pre">{e.text}</pre>
        </details>
      );
  }
}

/** Non-negative integer query parameter, or undefined. */
const seqParam = (v: string | string[] | undefined): number | undefined => {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return v !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
};

export default async function SessionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const { id } = await params;
  const query = await searchParams;
  const db = await ready();
  const detail = getSession(db, decodeURIComponent(id));
  if (!detail) notFound();
  const { session: s, parent, root, children, kindCounts, usage, tools } = detail;
  const live = isActive(s.total.lastActive, Date.now());
  // Subagents cannot be resumed on their own; offer the top-level session they belong to.
  const resume = adapterById(root.source)?.resumeCommand?.({ nativeId: root.nativeId, cwd: root.cwd ?? undefined, filePath: root.filePath });

  const win = timelineWindow(s.eventCount, { from: seqParam(query.from), to: seqParam(query.to), at: seqParam(query.at) });
  const events = sessionEvents(db, s.id, win.from, win.to);
  const pageHref = (from: number, to: number | null) => {
    const qs = new URLSearchParams();
    if (from > 0 || to !== null) qs.set("from", String(from));
    if (to !== null) qs.set("to", String(to));
    return `/sessions/${encodeURIComponent(s.id)}${qs.size ? `?${qs}` : ""}`;
  };
  const earlier = Math.min(TIMELINE_PAGE, win.from);
  const later = Math.min(TIMELINE_PAGE, win.total - win.to);

  const own = { input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite };
  // Chip keys of the timeline filter: tool calls and their results share one "tools" chip counted by calls.
  const counts: Record<string, number> = {};
  for (const [kind, n] of Object.entries(kindCounts)) {
    if (kind === "tool_result") continue;
    const key = kind === "tool_call" ? "tools" : kind;
    counts[key] = (counts[key] ?? 0) + n;
  }
  const maxTool = Math.max(1, ...tools.map((t) => t.calls));
  const lastActive = Math.max(s.total.lastActive, s.endedAt);
  const contextCache = s.input + s.cacheRead + s.cacheWrite;
  // Tool calls of the whole tree (this session and its subagents) for "What it did".
  const activity = s.total.toolCalls > 0 ? sessionActivity(db, s.id) : null;
  const timeline = sessionEventTimeline(db, s.id);
  const treeEvents = timeline ? timeline.counts.reduce((a, b) => a + b, 0) : 0;

  return (
    <>
      <PixelBand
        className="band-session"
        counts={timeline?.counts ?? []}
        legend={
          timeline
            ? `skyline = events per ${per(timeline.binMs)} over this session${s.subagents ? `, ${s.subagents} subagent ${s.subagents === 1 ? "run" : "runs"} included` : ""}`
            : "no events yet"
        }
      >
        <div className="band-title" data-quiet>
          <div className="crumbs">
            <Link href="/sessions">Sessions</Link>
            {parent && (
              <>
                {" / "}
                <Link href={`/sessions/${encodeURIComponent(parent.id)}`}>{parent.title || parent.id}</Link>
              </>
            )}
          </div>
          <div className="title-row">
            <h1 title={s.title || s.nativeId}>{s.title || s.nativeId}</h1>
            {live && (
              <span className="badge badge-live" title="Activity in the last 2 minutes">
                <PulseDot label="Live" />
                Live
              </span>
            )}
          </div>
        </div>
        <div className="band-stat" data-quiet>
          <span className="band-figure">{usd(s.total.cost)}</span>
          <span>
            {integer(treeEvents)} events · {duration(lastActive - s.startedAt)}
          </span>
        </div>
      </PixelBand>
      <div className="page-head">
        <dl className="meta">
          <div>
            <SourceBadge source={s.source} />
          </div>
          <div>
            <dt>Model</dt>
            <dd className="mono">{s.models.join(", ") || "—"}</dd>
          </div>
          <div>
            <dt>Directory</dt>
            <dd className="mono">{s.cwd ?? "—"}</dd>
          </div>
          {s.gitBranch && (
            <div>
              <dt>Branch</dt>
              <dd className="mono">{s.gitBranch}</dd>
            </div>
          )}
          <div>
            <dt>Started</dt>
            <dd>{dateTime(s.startedAt)}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>{duration(lastActive - s.startedAt)}</dd>
          </div>
          {s.agentVersion && (
            <div>
              <dt>Version</dt>
              <dd>{s.agentVersion}</dd>
            </div>
          )}
          <div>
            <dt>Id</dt>
            <dd className="mono">{s.nativeId}</dd>
          </div>
        </dl>
        <div className="head-actions">
          <TagEditor sessionId={s.id} tags={s.tags} autoTags={s.autoTags} suggestions={allTags(db)} />
          {resume && (
            <span className="title-row">
              {root.id !== s.id && <span className="muted">Resume via parent session</span>}
              <CopyCommand command={resume} label={root.id === s.id ? "Copy resume command" : "Copy the parent session's resume command"} />
            </span>
          )}
        </div>
      </div>

      <div className="tiles">
        <Tile
          hero
          label="Cost"
          value={usd(s.total.cost)}
          note={s.subagents ? `${usd(s.cost)} this session · ${usd((s.total.cost ?? 0) - (s.cost ?? 0))} subagents` : s.costSource === "estimated" ? "estimated from list prices" : undefined}
        />
        <Tile label="Tokens" value={tokens(totalTokens(s.total))} note={`${tokens(s.total.output)} output`} />
        <Tile label="Model requests" value={integer(s.requests)} note={s.subagents ? `this session; ${s.subagents} subagent runs` : undefined} />
        <Tile label="Tool calls" value={integer(s.total.toolCalls)} href="#tools" note={`${integer(s.total.errors)} errors`} />
        <Tile label="Cache hit rate" value={contextCache ? `${Math.round((s.cacheRead / contextCache) * 100)}%` : "—"} note="this session" />
      </div>

      {usage.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Context per request</h2>
            <span className="muted">input + cache tokens sent with each model call, this session</span>
          </div>
          <StackedBarChart
            labels={usage.map((u, i) => `Request ${i + 1} · ${clock(u.ts)}`)}
            ticks={usage.map((_, i) => String(i + 1))}
            series={[{ key: "context", label: "Context tokens", color: "var(--series-1)", values: usage.map((u) => u.input + u.cacheRead + u.cacheWrite) }]}
            notes={usage.map((u) => [`${tokens(u.output)} output · ${usd(u.cost)}${u.costSource === "estimated" ? " est." : ""}`, u.model])}
            format="tokens"
            height={180}
            ariaLabel="Context tokens per model request"
          />
        </section>
      )}

      {activity && activity.actions.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>What it did</h2>
            <span className="muted">
              {integer(activity.actions.length)} tool calls
              {activity.agents.length > 1 ? ` across this session and ${activity.agents.length - 1} subagents` : ", this session"}
            </span>
          </div>
          <SessionActivity data={activity} />
        </section>
      )}

      <div className="grid-2">
        <section className="card">
          <div className="card-head">
            <h2>Tokens</h2>
            <span className="muted">this session</span>
          </div>
          <table>
            <tbody>
              {[
                ["Cache read", own.cacheRead],
                ["Cache write", own.cacheWrite],
                ["Input (uncached)", own.input],
                ["Output", own.output],
              ].map(([label, value]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="num">
                    {tokens(Number(value))}
                    <Meter value={Number(value)} max={Math.max(own.cacheRead, own.cacheWrite, own.input, own.output)} />
                  </td>
                </tr>
              ))}
              <tr>
                <td>Cost</td>
                <td className="num">
                  <Cost value={s.cost} source={s.costSource} />
                </td>
              </tr>
            </tbody>
          </table>
        </section>
        <section className="card" id="tools">
          <div className="card-head">
            <h2>Tools used</h2>
            <span className="muted">this session</span>
          </div>
          {tools.length === 0 ? (
            <span className="muted">No tool calls.</span>
          ) : (
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
                    <td className={t.errors ? "num error-text" : "num muted"}>{t.errors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {children.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Subagents</h2>
            <span className="muted">{children.length} runs</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Model</th>
                  <th className="num">Duration</th>
                  <th className="num">Requests</th>
                  <th className="num">Tool calls</th>
                  <th className="num">Tokens</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {children.map((c) => (
                  <tr key={c.id} className="row-click">
                    <td>
                      <Link className="row-link" href={`/sessions/${encodeURIComponent(c.id)}`}>
                        {c.title || c.nativeId}
                      </Link>
                    </td>
                    <td className="mono">{c.models[0] ?? "—"}</td>
                    <td className="num">{duration(c.endedAt - c.startedAt)}</td>
                    <td className="num">{integer(c.requests)}</td>
                    <td className="num">{integer(c.toolCalls)}</td>
                    <td className="num">{tokens(totalTokens(c))}</td>
                    <td className="num">
                      <Cost value={c.cost} source={c.costSource} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Timeline</h2>
          <span className="muted mono" title="Source log file">
            {s.filePath}
          </span>
        </div>
        <TimelineFilter counts={counts}>
          {win.from > 0 && (
            <div className="timeline-pager">
              <span className="muted">
                Events {integer(win.from + 1)}–{integer(win.to)} of {integer(win.total)}
              </span>
              <Link href={pageHref(win.from - earlier, win.tail ? null : win.to)} scroll={false}>
                Show {integer(earlier)} earlier
              </Link>
              <Link href={pageHref(0, Math.min(win.total, TIMELINE_PAGE))}>Jump to start</Link>
            </div>
          )}
          {events.map((e) => (
            <div key={e.seq} id={`e-${e.seq}`} className={e.kind === "error" ? "ev ev-error" : "ev"} data-kind={e.kind}>
              <span className="ev-time">{clock(e.ts)}</span>
              <span className="ev-kind">
                <span className="ev-dot" style={{ background: e.isError ? "var(--kind-error)" : KIND_COLOR[e.kind] }} />
                {KIND_LABEL[e.kind] ?? e.kind}
              </span>
              <div className="ev-body">
                <EventBody e={e} />
              </div>
            </div>
          ))}
          {win.to < win.total && (
            <div className="timeline-pager">
              <span className="muted">
                {integer(win.total - win.to)} newer {win.total - win.to === 1 ? "event" : "events"}
              </span>
              <Link href={pageHref(win.from, win.to + later >= win.total ? null : win.to + later)} scroll={false}>
                Show {integer(later)} later
              </Link>
              <Link href={`/sessions/${encodeURIComponent(s.id)}`}>Jump to latest</Link>
            </div>
          )}
        </TimelineFilter>
      </section>
    </>
  );
}
