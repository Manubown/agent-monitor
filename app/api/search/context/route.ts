import { parseQuery } from "../../../../src/search/query";
import { context } from "../../../../src/search/service";
import { sourceColor } from "../../../components/ui";
import { getDb, ready } from "../../../lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/search/context?session=&seq=&q= -> events around a hit; `q` steers where long texts are clipped. */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const session = params.get("session");
  const seq = Number(params.get("seq") || Number.NaN);
  if (!session || !Number.isInteger(seq)) return Response.json({ error: "session and seq are required" }, { status: 400 });
  await ready();
  const terms = parseQuery(params.get("q") ?? "").must.map((c) => c.text);
  const result = context(getDb(), session, seq, 4, terms);
  if (!result) return Response.json({ error: "session not found" }, { status: 404 });
  return Response.json({ ...result, session: { ...result.session, color: sourceColor(result.session.source) } });
}
