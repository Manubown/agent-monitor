import path from "node:path";

/**
 * Paths as the analysis views compare them. Logs keep paths as the tool wrote them; on Windows that is `C:\…`
 * (sometimes `c:\…`), which `path.posix` treats as relative. Analysis turns Windows paths into a slash form with an
 * upper-case drive letter (`C:/Users/me/x`), so the same prefix checks, joins and tree segments work on every
 * platform. POSIX paths pass through unchanged: there a backslash is an ordinary file-name character.
 */

/** `C:\…`, `C:/…` or a UNC path `\\server\share\…`. */
export const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p);

/** Slash form of `p` when it is a Windows path; `windows` also converts relative paths (`src\a.ts`) of a Windows session. */
export function slashPath(p: string, windows: boolean = isWindowsPath(p)): string {
  if (!windows) return p;
  const s = p.replaceAll("\\", "/");
  return /^[a-z]:/.test(s) ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Absolute in slash form: `/…`, `C:/…` or `//server/…`. */
export const isAbsolutePath = (p: string): boolean => p.startsWith("/") || /^[A-Za-z]:\//.test(p);

/** Resolve `.`, `..` and repeated slashes; a drive (`C:/`) or UNC (`//`) prefix is kept and never climbed above. */
export function normalizePath(p: string): string {
  const root = /^(?:[A-Za-z]:\/|\/\/(?=[^/]))/.exec(p)?.[0];
  if (!root) return path.posix.normalize(p);
  return root + path.posix.normalize(`/${p.slice(root.length)}`).slice(1);
}

/** `p` resolved against `cwd`, both in slash form; a relative path stays as written when `cwd` is not absolute. */
export function resolvePath(p: string, cwd: string | null | undefined): string {
  if (isAbsolutePath(p)) return normalizePath(p);
  return cwd && isAbsolutePath(cwd) ? normalizePath(`${cwd}/${p}`) : p;
}

/**
 * A path from a tool call, in slash form and resolved against the session's working directory (as stored, any
 * platform). A relative `src\a.ts` counts as a Windows path when the session ran in a Windows directory; `~/…` is kept.
 */
export function sessionPath(p: string, cwd: string | null | undefined): string {
  const raw = slashPath(p, isWindowsPath(p) || (!!cwd && isWindowsPath(cwd)));
  return raw.startsWith("~/") ? raw : resolvePath(raw, cwd && slashPath(cwd));
}

/** Without a trailing slash, except for a root (`/`, `C:/`). */
const trimSlash = (p: string): string => (p.length > 1 && p.endsWith("/") && !/^[A-Za-z]:\/$/.test(p) ? p.slice(0, -1) : p);

/** One key per file however it was written: `~/x` and `<home>/x`, `x/` and `x`, composed and decomposed umlauts. */
export function fileKey(p: string, home: string): string {
  return trimSlash(p.startsWith("~/") && home ? normalizePath(`${slashPath(home)}/${p.slice(2)}`) : p).normalize("NFC");
}

/** A working directory or home as stored (any platform), comparable with `fileKey` results. */
export const dirKey = (dir: string): string => trimSlash(normalizePath(slashPath(dir))).normalize("NFC");
