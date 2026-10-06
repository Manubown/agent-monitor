/**
 * Query parameter parsing for pages and route handlers. Pure (no database, no Next.js imports) so it can be tested
 * directly. A parameter is whatever Next.js hands a page: missing, one string, or an array when the key repeats.
 */

export type Param = string | string[] | undefined;
export type Params = Record<string, Param>;

/** The first value of a parameter; empty strings count as missing (same rule as `filtersFrom`). */
export const first = (v: Param): string | undefined => (Array.isArray(v) ? v[0] : v) || undefined;

/**
 * A whole number >= 0 written in plain digits (a sequence number, a window bound). Anything else (missing, empty,
 * `-1`, `1.5`, `1e3`, `0x10`, ` 2`, `abc`, beyond `Number.MAX_SAFE_INTEGER`) is undefined, which callers read as the
 * default, so only what the UI itself writes is accepted.
 */
export function nonNegativeInt(v: Param): number | undefined {
  const s = first(v);
  if (s === undefined || !/^[0-9]+$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * A whole number >= 1 (a page number, a count), clamped to `max`. Anything else (missing, `0`, `1.01`, `-3`, `1e3`,
 * `0x10`, ` 2`, `abc`) is the fallback; same digits-only rule as `nonNegativeInt`.
 */
export function positiveInt(v: Param, fallback = 1, max = Number.MAX_SAFE_INTEGER): number {
  const n = nonNegativeInt(v);
  if (n === undefined || n < 1) return fallback;
  return Math.min(n, max);
}

/**
 * The parameter if it is one of the table's own keys, else undefined. `Object.hasOwn` rather than `key in table` or
 * `table[key]`, so `constructor`, `__proto__` or `toString` never resolve to Object.prototype members.
 */
export function oneOf<K extends string>(table: Readonly<Record<K, unknown>>, v: Param): K | undefined {
  const s = first(v);
  return s !== undefined && Object.hasOwn(table, s) ? (s as K) : undefined;
}

/** One of `values`, else undefined; for lists of allowed ids such as `RANGES`. */
export function oneOfList<T extends string>(values: readonly T[], v: Param): T | undefined {
  const s = first(v);
  return s !== undefined && (values as readonly string[]).includes(s) ? (s as T) : undefined;
}

/** Lowercase words joined by `-`, at most `max` characters: a readable piece of a file name. */
export function slug(s: string, max = 40): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/** Longest download name; keeps the `Content-Disposition` header and the saved file name short. */
const MAX_FILENAME = 100;

/**
 * A download file name from parts (falsy parts are skipped) and an extension. Every part is slugged, so the result
 * only holds `[a-z0-9.-]` and can go into a quoted `Content-Disposition` filename without escaping. The stem is cut to
 * keep the whole name within `MAX_FILENAME` characters.
 */
export function downloadName(parts: (string | false | null | undefined)[], ext: string): string {
  const extension = slug(ext, 10) || "txt";
  const stem =
    parts
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .map((p) => slug(p))
      .filter(Boolean)
      .join("-")
      .slice(0, MAX_FILENAME - extension.length - 1)
      .replace(/-+$/, "") || "download";
  return `${stem}.${extension}`;
}

/** `Content-Disposition` for a download; the name is re-slugged so no caller can put quotes or line breaks into it. */
export function attachment(parts: (string | false | null | undefined)[], ext: string): string {
  return `attachment; filename="${downloadName(parts, ext)}"`;
}

/** A URL's query as page-style params: a repeated key becomes an array (first value wins in `first`), as for pages. */
export function paramsOf(search: URLSearchParams): Params {
  const out: Params = {};
  for (const key of new Set(search.keys())) {
    const all = search.getAll(key);
    // defineProperty, not assignment: a `__proto__` key stays an ordinary own property.
    Object.defineProperty(out, key, { value: all.length === 1 ? all[0] : all, enumerable: true, writable: true, configurable: true });
  }
  return out;
}
