import Link from "next/link";
import type { Db } from "../../src/store/db";
import { isActive, listSessions } from "../../src/store/queries";
import { ago, project } from "../lib/format";
import { type PageFilters, queryOf } from "../lib/server";
import { Cost, PulseDot, SourceBadge, TagList } from "./ui";
import "../session-cards.css";

/**
 * Rows fetched for the widest row of cards. session-cards.css lays them out as one row of at least 230 px columns and
 * drops the cards that do not fit (`display: none`, so they leave the tab order too), so this is the most that can show.
 */
const CARDS = 5;

/**
 * The most recent session trees under the page's filters, as one row of cards: the overview's shortcut into the thing
 * the dashboard is about. Self-contained (it runs its own query from `db` and `filters`) so the page stays a layout.
 */
export function SessionCards({ db, filters, now }: { db: Db; filters: PageFilters; now: number }) {
  const sessions = listSessions(db, filters, { limit: CARDS, offset: 0 }).rows;
  if (sessions.length === 0) return null;
  // The page's whole scope, custom day window included, so "All sessions" opens the set the cards come from.
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(queryOf(filters))) if (v) qs.set(k, v);

  return (
    <section className="session-cards-section" aria-labelledby="recent-sessions">
      <div className="card-head">
        <h2 id="recent-sessions">Recent sessions</h2>
        <Link className="muted" href={`/sessions?${qs}`}>
          All sessions →
        </Link>
      </div>
      {/* `list-style: none` drops list semantics in Safari; the role keeps the card count announced. */}
      <ul className="session-cards" role="list">
        {sessions.map((s) => (
          <li key={s.id} className="card session-card row-click">
            <div className="session-card-head">
              {isActive(s.total.lastActive, now) && <PulseDot />}
              <SourceBadge source={s.source} />
              <span className="num session-card-cost">
                <Cost value={s.total.cost} source={s.costSource} />
              </span>
            </div>
            <Link className="row-link session-card-title" href={`/sessions/${encodeURIComponent(s.id)}`}>
              {s.title || s.nativeId}
            </Link>
            <span className="cell-sub session-card-meta" title={s.cwd ?? undefined}>
              {project(s.cwd)} · {ago(s.total.lastActive, now)}
              {s.subagents > 0 && ` · ${s.subagents} subagent${s.subagents === 1 ? "" : "s"}`}
            </span>
            <TagList tags={s.tags} autoTags={s.autoTags} />
          </li>
        ))}
      </ul>
    </section>
  );
}
