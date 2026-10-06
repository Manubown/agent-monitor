/**
 * Gource custom log format (https://github.com/acaudwell/Gource/wiki/Custom-Log-Format):
 * `timestamp|username|type|file|colour`, unix seconds, A(dded)/M(odified)/D(eleted), colour as RRGGBB.
 * Watch with `gource --log-format custom file.log`.
 */

/** What one tool call did to one file. A move is two touches: `move-from` on the old path, `move-to` on the new one. */
export type TouchKind = "read" | "write" | "edit" | "delete" | "move-from" | "move-to";

export interface GourceTouch {
  /** Epoch ms. */
  ts: number;
  user: string;
  kind: TouchKind;
  path: string;
  /** Agent tool (adapter id); picks the colour. */
  source: string;
}

/** File colour per agent tool. Data for the exported log only; the dashboard itself colours with CSS tokens. */
export const GOURCE_COLOURS: Record<string, string> = {
  omp: "4C9AFF",
  "claude-code": "E8875B",
  codex: "3FBF7F",
};

const FALLBACK_COLOUR = "B0B0B0";

/** Half-brightness version of an RRGGBB colour: reads, so changes stand out. */
export function dim(colour: string): string {
  const n = Number.parseInt(colour, 16);
  const half = (shift: number) => (((n >> shift) & 0xff) >> 1).toString(16).padStart(2, "0");
  return `${half(16)}${half(8)}${half(0)}`.toUpperCase();
}

/** Gource splits on `|` and reads one entry per line: neither may appear inside a field. */
export const gourceField = (s: string): string => s.replace(/\|/g, "¦").replace(/[\r\n]+/g, " ").trim();

/**
 * The log, ascending by time (ties keep input order). A file's first change (or its first change after a delete) is
 * `A`, later writes and edits `M`, deletes and move sources `D`, move targets `A`. Reads are left out unless `reads`,
 * then logged as `M` in a dimmed colour.
 */
export function gourceLog(touches: readonly GourceTouch[], options: { reads?: boolean } = {}): string {
  const sorted = touches
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.ts - b.t.ts || a.i - b.i)
    .map((x) => x.t);
  const present = new Set<string>();
  const lines: string[] = [];
  for (const t of sorted) {
    let type: "A" | "M" | "D" = "M";
    switch (t.kind) {
      case "read":
        if (!options.reads) continue;
        break;
      case "write":
      case "edit":
      case "move-to":
        type = present.has(t.path) ? "M" : "A";
        present.add(t.path);
        break;
      case "delete":
      case "move-from":
        type = "D";
        present.delete(t.path);
        break;
    }
    const path = gourceField(t.path);
    if (!path) continue;
    const colour = GOURCE_COLOURS[t.source] ?? FALLBACK_COLOUR;
    lines.push(`${Math.floor(t.ts / 1000)}|${gourceField(t.user) || "agent"}|${type}|${path}|${t.kind === "read" ? dim(colour) : colour}`);
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}
