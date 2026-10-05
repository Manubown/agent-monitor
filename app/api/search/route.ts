import { facets, search } from "../../../src/search/service";
import { sourceColor } from "../../components/ui";
import { getDb, getIndex, ready } from "../../lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/search?q=&sort=relevance|newest  -> grouped hits
 * GET /api/search?facets=1                  -> known values for operator autocomplete
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  await ready();
  const db = getDb();
  if (params.get("facets")) {
    const f = facets(db);
    return Response.json({ ...f, sources: f.sources.map((s) => ({ ...s, color: sourceColor(s.id) })) });
  }
  // Not trimmed: a trailing space ends the last word (no prefix matching).
  const q = params.get("q") ?? "";
  const sortParam = params.get("sort");
  const sort = sortParam === "newest" || sortParam === "new" ? "newest" : "relevance";
  try {
    const result = search(db, getIndex(), q, { sort });
    return Response.json({
      ...result,
      groups: result.groups.map((g) => ({ ...g, session: { ...g.session, color: sourceColor(g.session.source) } })),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
