import Link from "next/link";
import { notFound } from "next/navigation";
import { sessionActivity } from "../../../../src/store/activity";
import { getSession } from "../../../../src/store/queries";
import { ResourceMap } from "../../../components/graph/ResourceMap";
import { parseMapFilters } from "../../../components/graph/resourceMap";
import { integer } from "../../../lib/format";
import { ready, type SearchParams } from "../../../lib/server";

export default async function SessionGraphPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const { id } = await params;
  const db = await ready();
  const detail = getSession(db, decodeURIComponent(id));
  if (!detail) notFound();
  const { session: s, parent } = detail;
  const activity = sessionActivity(db, s.id);
  if (!activity) notFound();
  const title = s.title || s.nativeId;
  const sessionHref = `/sessions/${encodeURIComponent(s.id)}`;

  return (
    <>
      <div className="page-head rm-page-head">
        <div>
          <div className="crumbs">
            <Link href="/sessions">Sessions</Link>
            {parent && (
              <>
                {" / "}
                <Link href={`/sessions/${encodeURIComponent(parent.id)}`}>{parent.title || parent.id}</Link>
              </>
            )}
            {" / "}
            <Link href={sessionHref}>{title}</Link>
          </div>
          <h1 title={title}>Resource map</h1>
          <p className="muted">
            {integer(activity.actions.length)} tool calls
            {activity.agents.length > 1 ? ` across this session and ${activity.agents.length - 1} subagents` : ", this session"} · {integer(activity.files.length)} files ·{" "}
            {integer(activity.resources.length)} other resources
          </p>
        </div>
        <Link href={sessionHref} className="btn">
          ← Back to session
        </Link>
      </div>
      <section className="card">
        {activity.actions.length ? (
          <ResourceMap data={activity} initial={parseMapFilters(await searchParams)} />
        ) : (
          <p className="muted">No tool calls recorded.</p>
        )}
      </section>
    </>
  );
}
