/** Map page of a project. The working directory travels as a query parameter, so any path (spaces, `#`, `?`, `%`) round-trips. */
export function projectMapHref(cwd: string, params: Record<string, string | undefined> = {}): string {
  const qs = new URLSearchParams({ project: cwd });
  for (const [k, v] of Object.entries(params)) if (v && k !== "project") qs.set(k, v);
  return `/projects/map?${qs}`;
}

/** Gource log download: a session tree (`session`), or a project (`project` plus page filters). */
export function gourceHref(params: Record<string, string | undefined>, reads = false): string {
  const qs = new URLSearchParams({ view: "gource" });
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  if (reads) qs.set("reads", "1");
  return `/api/export?${qs}`;
}

export const GOURCE_HINT = "Gource custom log (unix time|agent|A/M/D|file|colour). Play it with: gource --log-format custom file.log";
