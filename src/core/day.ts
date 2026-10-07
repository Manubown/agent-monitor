/**
 * Local calendar days: the days `date(…, 'localtime')` and `localDay` produce, and where they start and end in the
 * process time zone. Pure, so the URL parsing, the queries and the day panel all cut the day at the same instant.
 */

/** A day as written in URLs and stored by SQLite: YYYY-MM-DD. */
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Whether `s` is a real calendar day written as YYYY-MM-DD. Rejects anything the UI never writes: other shapes,
 * missing padding, `2026-13-01`, `2026-02-30` and years before 1000 (`new Date(26, …)` would mean 1926).
 */
export function isDay(s: string | null | undefined): s is string {
  const m = s ? DAY.exec(s) : null;
  if (!m) return false;
  const [y, month, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, month - 1, d);
  return date.getFullYear() === y && date.getMonth() === month - 1 && date.getDate() === d;
}

/**
 * First instant of the day in local time (epoch ms). Where a DST change skips midnight the day starts at the first
 * local time that exists, which is what `Date` returns.
 */
export function dayStart(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** First instant of the next day, the exclusive upper bound: 23, 24 or 25 hours after `dayStart` across DST changes. */
export function dayEnd(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d + 1).getTime();
}
