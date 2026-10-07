import Link from "next/link";
import { dayActivity } from "../../src/store/day";
import type { Db } from "../../src/store/db";
import { clock, integer, project, tokens } from "../lib/format";
import { type PageFilters, queryOf } from "../lib/server";
import { Cost, Empty, SourceBadge, TagList } from "./ui";
import "../day.css";

/** Sessions listed before the "all sessions" link takes over. */
const LIMIT = 8;

/** "Mon 6 Oct 2026": the panel's heading. */
const dayTitle = (day: string): string =>
  new Date(`${day}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

/**
 * "What was done on this day": the sessions active on one local day with that day's prompts, tools, files, tokens
 * and cost. Opened from a column of the per-day charts (`?day=YYYY-MM-DD`), so it keeps every other filter and the
 * `href`s it hands out carry them on.
 *
 * `filters` are the page's filters; the panel scopes them to the day itself, which is also what the "all sessions"
 * link does through the custom `from`/`to` of the sessions list.
 */
export function DayPanel({ db, filters, day }: { db: Db; filters: PageFilters; day: string }) {
  const a = dayActivity(db, filters, day, LIMIT);
  const current = queryOf(filters);
  const href = (path: string, query: Record<string, string | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) qs.set(k, v);
    const s = qs.toString();
    return s ? `${path}?${s}` : path;
  };
  // No anchor: the panel is gone after this, and `scroll={false}` keeps the charts in view.
  const closeHref = href("/", { ...current, day: undefined });
  // The same window the panel counted, so the list shows exactly those sessions.
  const allHref = href("/sessions", { ...current, from: day, to: day });
  const more = a.total - a.sessions.length;

  return (
    <section className="card day-panel" id="day-panel" aria-labelledby="day-panel-title">
      <div className="card-head">
        <h2 id="day-panel-title">{dayTitle(day)}</h2>
        <span className="muted">
          {integer(a.total)} {a.total === 1 ? "session" : "sessions"} · {integer(a.prompts)} {a.prompts === 1 ? "prompt" : "prompts"} ·{" "}
          {integer(a.requests)} requests · {tokens(a.tokens)} tokens · <Cost value={a.cost} source={a.costSource} />
        </span>
        <Link className="btn" href={closeHref} scroll={false}>
          Close
        </Link>
      </div>
      {a.sessions.length === 0 ? (
        <Empty>No session was active on this day with these filters.</Empty>
      ) : (
        <div className="day-list">
          {a.sessions.map((s) => (
            <div key={s.id} className="day-row row-click">
              <div className="day-main">
                <div className="day-title">
                  <Link className="row-link" href={`/sessions/${encodeURIComponent(s.id)}`}>
                    {s.title}
                  </Link>
                  <SourceBadge source={s.source} />
                  <span className="muted">
                    {clock(s.start).slice(0, 5)}–{clock(s.end).slice(0, 5)}
                  </span>
                  <TagList tags={s.tags} autoTags={s.autoTags} />
                </div>
                <span className="cell-sub">
                  {project(s.cwd)}
                  {s.subagents > 0 && ` · ${integer(s.subagents)} subagent${s.subagents === 1 ? "" : "s"} active`}
                  {s.toolCalls > 0 && ` · ${integer(s.toolCalls)} tool calls`}
                  {s.tools.length > 0 && ` (${s.tools.map((t) => `${t.tool} ${integer(t.calls)}`).join(", ")})`}
                </span>
                {s.prompts.length > 0 && (
                  <ol className="day-prompts">
                    {s.prompts.map((p) => (
                      <li key={p.seq}>
                        <Link href={`/sessions/${encodeURIComponent(s.id)}?at=${p.seq}#e-${p.seq}`} title={p.text}>
                          {p.text || "(empty prompt)"}
                        </Link>
                      </li>
                    ))}
                    {s.promptCount > s.prompts.length && <li className="muted">+ {integer(s.promptCount - s.prompts.length)} more prompts</li>}
                  </ol>
                )}
                {s.fileCount > 0 && (
                  <span className="day-files cell-sub">
                    {integer(s.fileCount)} {s.fileCount === 1 ? "file" : "files"} changed:{" "}
                    <span className="mono">{s.files.join(" · ")}</span>
                    {s.fileCount > s.files.length && ` · + ${integer(s.fileCount - s.files.length)} more`}
                  </span>
                )}
              </div>
              <span className="num day-cost">
                {tokens(s.tokens)} tokens
                <span className="cell-sub">
                  <Cost value={s.cost} source={s.costSource} /> · {integer(s.requests)} requests
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="day-foot">
        <Link className="row-link" href={allHref}>
          All {integer(a.total)} {a.total === 1 ? "session" : "sessions"} on this day →
        </Link>
        {more > 0 && (
          <span className="muted">
            {integer(more)} more than listed here
          </span>
        )}
      </div>
    </section>
  );
}
