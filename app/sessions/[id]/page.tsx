import Link from "next/link";
import { notFound } from "next/navigation";
import { adapterById } from "../../../src/adapters";
import { totalTokens } from "../../../src/core/types";
import { sessionActivity } from "../../../src/store/activity";
import { dispatchPrompts } from "../../../src/store/dispatch";
import { sessionFlame } from "../../../src/store/flame";
import { sessionLoops } from "../../../src/store/loops";
import {
  allTags,
  DEFAULT_TIMELINE_KINDS,
  type EventRow,
  getSession,
  isActive,
  parseTimelineKinds,
  sessionEventTimeline,
  TIMELINE_KINDS,
  TIMELINE_PAGE,
  type TimelineKind,
  timelinePage,
} from "../../../src/store/queries";
import { sessionContext, sessionTurns } from "../../../src/store/turns";
import { CopyCommand, TagEditor, TimelineFilter } from "../../components/client";
import { FileHeat } from "../../components/FileHeat";
import { FlameGraph } from "../../components/graph/FlameGraph";
import { SessionActivity } from "../../components/graph/SessionActivity";
import { PixelBand } from "../../components/pixel/PixelBand";
import { Cost, Meter, PulseDot, SourceBadge, Tile } from "../../components/ui";
import { ContextCard } from "../../components/turns/ContextCard";
import { TurnsCard } from "../../components/turns/TurnsCard";
import { GourceLinks } from "../../components/projects/GourceLinks";
import { projectMapHref } from "../../components/projects/links";
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
  const { session: s, parent, root, children, timelineCounts, tools } = detail;
  const live = isActive(s.total.lastActive, Date.now());
  // Subagents cannot be resumed on their own; offer the top-level session they belong to.
  const resume = adapterById(root.source)?.resumeCommand?.({ nativeId: root.nativeId, cwd: root.cwd ?? undefined, filePath: root.filePath });

  const kinds = parseTimelineKinds(query.kinds);
  const at = seqParam(query.at);
  const win = timelinePage(db, s.id, { kinds, from: seqParam(query.from), to: seqParam(query.to), at });
  const events = win.events;
  /** Timeline URL; `at` stays so a search hit remains listed while paging or filtering around it. */
  const timelineHref = (shown: readonly TimelineKind[], p: { from?: number; to?: number | null; at?: number } = {}) => {
    const qs = new URLSearchParams();
    const isDefault = shown.length === DEFAULT_TIMELINE_KINDS.length && shown.every((k) => DEFAULT_TIMELINE_KINDS.includes(k));
    if (!isDefault) qs.set("kinds", shown.join(","));
    if (p.at !== undefined) qs.set("at", String(p.at));
    if (p.from !== undefined && (p.from > 0 || p.to != null)) qs.set("from", String(p.from));
    if (p.to != null) qs.set("to", String(p.to));
    return `/sessions/${encodeURIComponent(s.id)}${qs.size ? `?${qs}` : ""}`;
  };
  const pageHref = (from: number, to: number | null) => timelineHref(kinds, { from, to, at });
  const earlier = Math.min(TIMELINE_PAGE, win.from);
  const later = Math.min(TIMELINE_PAGE, win.total - win.to);
  const chipHrefs: Record<string, string> = {
    all: timelineHref(TIMELINE_KINDS.filter((k) => timelineCounts[k] > 0), { at }),
  };
  for (const k of TIMELINE_KINDS) {
    chipHrefs[k] = timelineHref(kinds.includes(k) ? kinds.filter((x) => x !== k) : TIMELINE_KINDS.filter((x) => x === k || kinds.includes(x)), { at });
  }

  const own = { input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite };
  const maxTool = Math.max(1, ...tools.map((t) => t.calls));
  const lastActive = Math.max(s.total.lastActive, s.endedAt);
  // What this subagent was told to do, and what each of its own subagents was told.
  const prompts = dispatchPrompts(db, [s.id, ...children.map((c) => c.id)]);
  const dispatch = prompts[s.id];
  const contextCache = s.input + s.cacheRead + s.cacheWrite;
  // Tool calls of the whole tree (this session and its subagents) for "What it did".
  const activity = s.total.toolCalls > 0 ? sessionActivity(db, s.id) : null;
  const timeline = sessionEventTimeline(db, s.id);
  // Model requests per agent of the tree (with compactions) and per-prompt turns for "Context per request" and "Turns".
  const context = sessionContext(db, s.id);
  const turns = sessionTurns(db, s.id);
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
            <dd className="mono">{s.cwd ? <Link href={projectMapHref(s.cwd)} title="File map of this project across sessions">{s.cwd}</Link> : "—"}</dd>
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
          {s.total.toolCalls > 0 && <GourceLinks params={{ session: s.id }} />}
        </div>
      </div>

      {dispatch && (
        <section className="card dispatch">
          <div className="card-head">
            <h2>Dispatch prompt</h2>
            <span className="muted">
              instructions this subagent received
              {parent && (
                <>
                  {" from "}
                  <Link href={`/sessions/${encodeURIComponent(parent.id)}`}>{parent.title || parent.id}</Link>
                </>
              )}
              {" · "}
              <Link href={`/sessions/${encodeURIComponent(s.id)}?at=${s.dispatchSeq}#e-${s.dispatchSeq}`}>show in timeline</Link>
            </span>
          </div>
          <pre className="ev-pre dispatch-prompt">{dispatch}</pre>
        </section>
      )}

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

      {context.length > 0 && <ContextCard agents={context} />}

      {turns.length > 0 && <TurnsCard sessionId={s.id} turns={turns} />}

      {activity && activity.actions.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>What it did</h2>
            <span className="muted">
              {integer(activity.actions.length)} tool calls
              {activity.agents.length > 1 ? ` across this session and ${activity.agents.length - 1} subagents` : ", this session"}
              {" · "}
              <Link href={`/sessions/${encodeURIComponent(s.id)}/graph`}>Open full map →</Link>
            </span>
          </div>
          <SessionActivity data={activity} />
        </section>
      )}

      {activity && activity.actions.length > 0 && (
        <section className="card" id="flame">
          <div className="card-head">
            <h2>Flame</h2>
            <span className="muted">
              {activity.agents.length > 1
                ? "each agent under its spawner, its tool calls below it; click an agent to zoom in"
                : "tool calls with their durations; click one to open it in the timeline"}
            </span>
          </div>
          <FlameGraph agents={activity.agents} actions={activity.actions} flame={sessionFlame(db, activity)} />
        </section>
      )}

      {activity && activity.actions.length > 0 && (
        <section className="card" id="file-heat">
          <div className="card-head">
            <h2>File heat</h2>
            <span className="muted">
              {integer(activity.files.length)} files touched, hottest first
              {activity.agents.length > 1 ? `, across this session and ${activity.agents.length - 1} subagents` : ", this session"}
            </span>
          </div>
          <FileHeat data={activity} loops={sessionLoops(db, activity)} />
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
                      {prompts[c.id] && (
                        <details className="dispatch-row">
                          <summary>{firstLine(prompts[c.id], 140)}</summary>
                          <pre className="ev-pre dispatch-prompt">{prompts[c.id]}</pre>
                        </details>
                      )}
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
        <TimelineFilter counts={timelineCounts} shown={kinds} hrefs={chipHrefs} />
        <div className="timeline">
          {win.from > 0 && (
            <div className="timeline-pager">
              <span className="muted">
                Events {integer(win.from + 1)}–{integer(win.to)} of {integer(win.total)} matching
              </span>
              <Link href={pageHref(win.from - earlier, win.tail ? null : win.to)} scroll={false}>
                Show {integer(earlier)} earlier
              </Link>
              <Link href={timelineHref(kinds, { from: 0, to: Math.min(win.total, TIMELINE_PAGE) })}>Jump to start</Link>
            </div>
          )}
          {events.length === 0 && (
            <p className="muted">{kinds.length ? "No events of the selected types." : "No event types selected."}</p>
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
              <Link href={timelineHref(kinds)}>Jump to latest</Link>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
