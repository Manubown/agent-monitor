import { totalTokens, type TokenUsage } from "../../../src/core/types";
import type { Db } from "../../../src/store/db";
import { byModel, byProject, daily, type Filters, isSessionSort, listSessions, type SessionSort, type SessionSummary } from "../../../src/store/queries";
import { attachment, first, oneOf, paramsOf } from "../../lib/params";
import { filtersFrom, ready } from "../../lib/server";
import { type Cell, toCsv } from "./csv";
import { gourceExport } from "./gource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const iso = (ts: number | null | undefined): string | null => (ts === null || ts === undefined ? null : new Date(ts).toISOString());

/** Rows of one export plus its columns, in order; CSV and JSON share both. */
interface View<T> {
  rows(db: Db, f: Filters, sort: SessionSort): T[];
  columns: Record<string, (row: T) => Cell>;
}

const view = <T>(v: View<T>): View<unknown> => v as View<unknown>;

const tokenColumns = <T>(get: (row: T) => TokenUsage): View<T>["columns"] => ({
  inputTokens: (r) => get(r).input,
  outputTokens: (r) => get(r).output,
  cacheReadTokens: (r) => get(r).cacheRead,
  cacheWriteTokens: (r) => get(r).cacheWrite,
  reasoningTokens: (r) => get(r).reasoning,
  totalTokens: (r) => totalTokens(get(r)),
});

const VIEWS: Record<string, View<unknown>> = {
  // Every matching top-level session, subagent work rolled in, no paging, in the list's order.
  sessions: view({
    rows: (db, f, sort) => listSessions(db, f, { limit: -1, offset: 0 }, sort).rows,
    columns: {
      id: (s) => s.id,
      source: (s) => s.source,
      title: (s) => s.title,
      cwd: (s) => s.cwd,
      gitBranch: (s) => s.gitBranch,
      models: (s) => s.models.join(" "),
      tags: (s) => s.tags.join(" "),
      autoTags: (s) => s.autoTags.map((t) => t.tag).join(" "),
      startedAt: (s) => iso(s.startedAt),
      lastActiveAt: (s) => iso(Math.max(s.endedAt, s.total.lastActive)),
      prompts: (s) => s.userMessages,
      subagents: (s) => s.subagents,
      toolCalls: (s) => s.total.toolCalls,
      errors: (s) => s.total.errors,
      ...tokenColumns<SessionSummary>((s) => s.total),
      costUsd: (s) => s.total.cost,
      costSource: (s) => s.costSource,
    },
  }),
  daily: view({
    rows: daily,
    columns: {
      day: (d) => d.day,
      source: (d) => d.source,
      requests: (d) => d.requests,
      ...tokenColumns<TokenUsage>((d) => d),
      costUsd: (d) => d.cost,
    },
  }),
  models: view({
    rows: byModel,
    columns: {
      model: (m) => m.model,
      source: (m) => m.source,
      requests: (m) => m.requests,
      ...tokenColumns<TokenUsage>((m) => m),
      costUsd: (m) => m.cost,
      costSource: (m) => m.costSource,
    },
  }),
  projects: view({
    rows: byProject,
    columns: {
      cwd: (p) => p.cwd,
      sessions: (p) => p.sessions,
      requests: (p) => p.requests,
      ...tokenColumns<TokenUsage>((p) => p),
      costUsd: (p) => p.cost,
      lastActiveAt: (p) => iso(p.lastActive),
    },
  }),
};

const FORMATS = { csv: "text/csv; charset=utf-8", json: "application/json; charset=utf-8" } as const;

/** GET /api/export?view=sessions|daily|models|projects&format=csv|json plus the page filters (range, source, project, q, tag) and, for sessions, sort; view=gource: see gource.ts. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const params = paramsOf(url.searchParams);
  const requested = first(params.view) ?? "sessions";
  // Gource custom log of a session tree or a project (see gource.ts); not a table, so outside VIEWS.
  if (requested === "gource") return gourceExport(url, ready);
  // Own keys only: `view=constructor` must not find Object.prototype.constructor.
  const name = oneOf(VIEWS, requested);
  if (!name) return new Response(`Unknown view "${requested}"; use ${Object.keys(VIEWS).join(", ")} or gource.`, { status: 400 });
  const requestedFormat = first(params.format) ?? "csv";
  const format = oneOf(FORMATS, requestedFormat);
  if (!format) return new Response(`Unknown format "${requestedFormat}"; use csv or json.`, { status: 400 });

  const v = VIEWS[name];
  const f = filtersFrom(params);
  const sort = first(params.sort);
  const rows = v.rows(await ready(), f, isSessionSort(sort) ? sort : "recent");
  const columns = Object.entries(v.columns);
  const disposition = attachment(
    [
      "agent-monitor",
      name,
      f.range,
      f.source,
      f.cwd && (f.cwd.split(/[\\/]/).filter(Boolean).pop() ?? "project"),
      f.tag && `tag-${f.tag}`,
      f.q && `q-${f.q}`,
      new Date().toISOString().slice(0, 10),
    ],
    format,
  );

  const body =
    format === "json"
      ? JSON.stringify(
          rows.map((r) => Object.fromEntries(columns.map(([key, get]) => [key, get(r) ?? null]))),
          null,
          2,
        )
      : toCsv(
          columns.map(([key]) => key),
          rows.map((r) => columns.map(([, get]) => get(r))),
        );
  return new Response(body, {
    headers: {
      "Content-Type": FORMATS[format],
      "Content-Disposition": disposition,
      "Cache-Control": "no-store",
    },
  });
}
