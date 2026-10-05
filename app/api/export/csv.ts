export type Cell = string | number | boolean | null | undefined;

/**
 * One CSV field per RFC 4180. Text starting with = + - @ is prefixed with a
 * single quote so spreadsheets do not evaluate it as a formula; numbers are
 * written as-is (a negative number is data, not a formula).
 */
export function csvField(value: Cell): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header row plus data rows, CRLF line ends (including after the last record). */
export function toCsv(header: readonly string[], rows: readonly (readonly Cell[])[]): string {
  return [header, ...rows].map((row) => `${row.map(csvField).join(",")}\r\n`).join("");
}
