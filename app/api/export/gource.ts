import { type GourceTouch, gourceLog } from "../../../src/core/gource";
import type { Db } from "../../../src/store/db";
import { projectGource, sessionGource } from "../../../src/store/projects";
import { filtersFrom, type SearchParams } from "../../lib/server";

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/**
 * GET /api/export?view=gource&session=<id> (the session and its subagents) or &project=<cwd> (with the page filters:
 * range, source, q, tag). `&reads=1` adds reads as dimmed modifications. Play with `gource --log-format custom file.log`.
 */
export function gourceExport(db: Db, url: URL): Response {
  const params: SearchParams = Object.fromEntries(url.searchParams);
  const session = url.searchParams.get("session");
  const project = url.searchParams.get("project");
  const reads = url.searchParams.get("reads") === "1";
  let touches: GourceTouch[] | null;
  let name: string;
  if (session) {
    touches = sessionGource(db, session);
    if (!touches) return new Response(`Unknown session "${session}".`, { status: 404 });
    name = slug(session.split(":").pop() ?? session);
  } else if (project) {
    const f = filtersFrom(params);
    touches = projectGource(db, project, f);
    name = [slug(project.split(/[\\/]/).filter(Boolean).pop() ?? "project"), f.range, f.source].filter(Boolean).join("-");
  } else {
    return new Response("Gource export needs session=<id> or project=<working directory>.", { status: 400 });
  }
  const filename = ["agent-monitor", "gource", name, reads && "reads", new Date().toISOString().slice(0, 10)].filter(Boolean).join("-");
  return new Response(gourceLog(touches, { reads }), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}.log"`,
      "Cache-Control": "no-store",
    },
  });
}
