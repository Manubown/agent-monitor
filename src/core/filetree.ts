/**
 * Directory tree of touched files, with every directory carrying the sums of
 * everything below it. Paths are display paths: relative inside the project,
 * `~/…` under the home directory, absolute elsewhere.
 */

export interface TreeCounts {
  reads: number;
  /** Writes, edits, deletes and moves. */
  changes: number;
  /** Per source (agent tool): reads + changes. */
  sources: Record<string, number>;
}

export interface TreeFile extends TreeCounts {
  kind: "file";
  name: string;
  path: string;
  /** Index into the input list. */
  index: number;
}

export interface TreeDir extends TreeCounts {
  kind: "dir";
  /** "" for the root. */
  name: string;
  /** "" for the root; `/` for the filesystem root of outside files. */
  path: string;
  /** Files anywhere below. */
  files: number;
  children: TreeNode[];
}

export type TreeNode = TreeFile | TreeDir;

export const touches = (c: TreeCounts): number => c.reads + c.changes;

/** Segments of a display path; an absolute path starts with the segment `/`, a Windows one with its drive (`C:`). */
export function splitPath(p: string): string[] {
  const parts = p.split("/").filter((s) => s && s !== ".");
  return p.startsWith("/") ? ["/", ...parts] : parts;
}

/** Path of `name` inside directory `parent`. */
export const joinPath = (parent: string, name: string): string => (parent === "" ? name : parent === "/" ? `/${name}` : `${parent}/${name}`);

function add(into: TreeCounts, c: TreeCounts): void {
  into.reads += c.reads;
  into.changes += c.changes;
  for (const [s, n] of Object.entries(c.sources)) into.sources[s] = (into.sources[s] ?? 0) + n;
}

/** Children sorted by touches (largest first), then name. */
const order = (a: TreeNode, b: TreeNode): number => touches(b) - touches(a) || a.name.localeCompare(b.name);

/** The tree of `files`; files with no touches are left out. A path naming both a file and a directory keeps both. */
export function buildTree(files: readonly ({ path: string } & TreeCounts)[]): TreeDir {
  const root: TreeDir = { kind: "dir", name: "", path: "", reads: 0, changes: 0, sources: {}, files: 0, children: [] };
  const dirs = new Map<string, TreeDir>([["", root]]);
  files.forEach((f, index) => {
    if (touches(f) <= 0) return;
    const parts = splitPath(f.path);
    if (!parts.length) return;
    let dir = root;
    const chain = [root];
    for (const name of parts.slice(0, -1)) {
      const p = joinPath(dir.path, name);
      let next = dirs.get(p);
      if (!next) {
        next = { kind: "dir", name, path: p, reads: 0, changes: 0, sources: {}, files: 0, children: [] };
        dirs.set(p, next);
        dir.children.push(next);
      }
      dir = next;
      chain.push(dir);
    }
    const name = parts.at(-1)!;
    dir.children.push({ kind: "file", name, path: joinPath(dir.path, name), index, reads: f.reads, changes: f.changes, sources: { ...f.sources } });
    for (const d of chain) {
      add(d, f);
      d.files++;
    }
  });
  const sort = (d: TreeDir) => {
    d.children.sort(order);
    for (const c of d.children) if (c.kind === "dir") sort(c);
  };
  sort(root);
  return root;
}

/** The directory at `path`, or undefined. */
export function findDir(root: TreeDir, path: string): TreeDir | undefined {
  let dir = root;
  for (const name of splitPath(path)) {
    const next = dir.children.find((c): c is TreeDir => c.kind === "dir" && c.name === name);
    if (!next) return undefined;
    dir = next;
  }
  return dir;
}

/** Breadcrumb of `path`: the root, then every directory down to it. */
export function ancestors(path: string): { name: string; path: string }[] {
  const out = [{ name: "", path: "" }];
  for (const name of splitPath(path)) out.push({ name, path: joinPath(out.at(-1)!.path, name) });
  return out;
}

/** Source with the most touches; ties go to the alphabetically first. */
export function dominantSource(c: TreeCounts): string | undefined {
  let best: string | undefined;
  for (const [s, n] of Object.entries(c.sources)) if (best === undefined || n > c.sources[best] || (n === c.sources[best] && s < best)) best = s;
  return best;
}
