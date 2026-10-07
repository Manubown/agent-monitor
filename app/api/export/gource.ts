import { type GourceTouch, gourceLog } from "../../../src/core/gource";
import type { Db } from "../../../src/store/db";
import { projectGource, sessionGource } from "../../../src/store/projects";
import { attachment, first, paramsOf } from "../../lib/params";
import { filtersFrom } from "../../lib/server";

/**
 * GET /api/export?view=gource&session=<id> (the session and its subagents) or &project=<cwd> (with the page filters:
 * range, source, q, tag). `&reads=1` adds reads as dimmed modifications. Play with `gource --log-format custom file.log`.
 * The database is opened only once the request is known to be valid.
 */
export async function gourceExport(url: URL, open: () => Promise<Db>): Promise<Response> {
  const params = paramsOf(url.searchParams);
  const session = first(params.session);
  const project = first(params.project);
  const reads = first(params.reads) === "1";
  let touches: GourceTouch[] | null;
  let name: (string | undefined)[];
  if (session) {
    touches = sessionGource(await open(), session);
    if (!touches) return new Response(`Unknown session "${session}".`, { status: 404 });
    name = [session.split(":").pop() || session];
  } else if (project) {
    const f = filtersFrom(params);
    touches = projectGource(await open(), project, f);
    name = [project.split(/[\\/]/).filter(Boolean).pop() ?? "project", f.days ? [f.days.from, f.days.to].filter(Boolean).join("-to-") : f.range, f.source];
  } else {
    return new Response("Gource export needs session=<id> or project=<working directory>.", { status: 400 });
  }
  return new Response(gourceLog(touches, { reads }), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": attachment(["agent-monitor", "gource", ...name, reads && "reads", new Date().toISOString().slice(0, 10)], "log"),
      "Cache-Control": "no-store",
    },
  });
}
