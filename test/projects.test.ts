import { beforeEach, describe, expect, it } from "vitest";
import { nestedLayout, type Rect, squarify } from "../app/components/projects/treemap";
import { ancestors, buildTree, dominantSource, findDir, splitPath, type TreeNode, touches } from "../src/core/filetree";
import { dim, GOURCE_COLOURS, type GourceTouch, gourceLog } from "../src/core/gource";
import { type Db, openDb } from "../src/store/db";
import { listProjects, projectFile, projectGource, projectMap, sessionGource } from "../src/store/projects";

const T = Date.UTC(2026, 9, 1, 12);
const MIN = 60_000;
const HOME = "/home/me";

describe("buildTree", () => {
  const files: { path: string; reads: number; changes: number; sources: Record<string, number> }[] = [
    { path: "src/a.ts", reads: 3, changes: 1, sources: { omp: 4 } },
    { path: "src/lib/b.ts", reads: 0, changes: 2, sources: { codex: 2 } },
    { path: "README.md", reads: 1, changes: 0, sources: { omp: 1 } },
    { path: "src/unused.ts", reads: 0, changes: 0, sources: {} },
    { path: "~/.config/x.json", reads: 1, changes: 0, sources: { "claude-code": 1 } },
    { path: "/tmp/scratch/y.txt", reads: 0, changes: 1, sources: { omp: 1 } },
  ];
  const root = buildTree(files);

  it("sums every file into each directory above it and skips untouched files", () => {
    expect(root).toMatchObject({ reads: 5, changes: 4, files: 5, sources: { omp: 6, codex: 2, "claude-code": 1 } });
    const src = findDir(root, "src")!;
    expect(src).toMatchObject({ path: "src", reads: 3, changes: 3, files: 2, sources: { omp: 4, codex: 2 } });
    expect(findDir(root, "src/lib")).toMatchObject({ files: 1, changes: 2 });
    expect(src.children.map((c) => c.name)).toEqual(["a.ts", "lib"]);
    const leaf = src.children[0];
    expect(leaf).toMatchObject({ kind: "file", path: "src/a.ts", index: 0 });
  });

  it("keeps a directory's touches equal to the sum of its children's", () => {
    const check = (n: TreeNode): void => {
      if (n.kind !== "dir") return;
      expect(n.children.reduce((s, c) => s + touches(c), 0)).toBe(touches(n));
      n.children.forEach(check);
    };
    check(root);
  });

  it("roots home and absolute paths outside the project at ~ and /", () => {
    expect(root.children.map((c) => c.path).sort()).toEqual(["/", "README.md", "src", "~"]);
    expect(findDir(root, "/tmp/scratch")?.children[0].path).toBe("/tmp/scratch/y.txt");
    expect(findDir(root, "~/.config")?.files).toBe(1);
    expect(findDir(root, "nope")).toBeUndefined();
    expect(splitPath("/tmp/x")).toEqual(["/", "tmp", "x"]);
    expect(ancestors("/tmp/x").map((a) => a.path)).toEqual(["", "/", "/tmp", "/tmp/x"]);
    expect(ancestors("src/lib").map((a) => a.path)).toEqual(["", "src", "src/lib"]);
  });

  it("picks the dominant source, ties alphabetically", () => {
    expect(dominantSource({ reads: 0, changes: 0, sources: { omp: 2, codex: 3 } })).toBe("codex");
    expect(dominantSource({ reads: 0, changes: 0, sources: { omp: 2, codex: 2 } })).toBe("codex");
    expect(dominantSource({ reads: 0, changes: 0, sources: {} })).toBeUndefined();
  });
});

const area = (r: Rect) => r.w * r.h;
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const inside = (r: Rect, b: Rect, eps = 1e-6) => r.x >= b.x - eps && r.y >= b.y - eps && r.x + r.w <= b.x + b.w + eps && r.y + r.h <= b.y + b.h + eps;

describe("squarify", () => {
  const bounds = { x: 10, y: 20, w: 600, h: 400 };
  const cases: number[][] = [[6, 6, 4, 3, 2, 2, 1], [1], [100, 1, 1, 1], Array.from({ length: 200 }, (_, i) => ((i * 37) % 23) + 1), [5, 0, 3, -2, Number.NaN]];

  it.each(cases)("tiles the bounds with areas proportional to values, no overlap (%#)", (...values) => {
    const rects = squarify(values, bounds);
    expect(rects).toHaveLength(values.length);
    const positive = values.filter((v) => v > 0);
    const total = positive.reduce((s, v) => s + v, 0);
    values.forEach((v, i) => {
      if (v > 0) {
        expect(area(rects[i])).toBeCloseTo((v / total) * area(bounds), 6);
        expect(inside(rects[i], bounds)).toBe(true);
      } else expect(area(rects[i])).toBe(0);
    });
    expect(rects.reduce((s, r) => s + area(r), 0)).toBeCloseTo(area(bounds), 6);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i], rects[j])).toBeLessThan(1e-6);
  });

  it("keeps cells reasonably square", () => {
    const rects = squarify([1, 1, 1, 1], { x: 0, y: 0, w: 100, h: 100 });
    for (const r of rects) expect(Math.max(r.w / r.h, r.h / r.w)).toBeLessThanOrEqual(1.0001);
  });

  it("returns empty rects when nothing is positive", () => {
    expect(squarify([0, 0], bounds).every((r) => area(r) === 0)).toBe(true);
  });

  it("nests children inside their opened parent's inner area", () => {
    const tree = buildTree([
      { path: "a/x.ts", reads: 5, changes: 5, sources: {} },
      { path: "a/y.ts", reads: 3, changes: 0, sources: {} },
      { path: "a/b/z.ts", reads: 2, changes: 2, sources: {} },
      { path: "c.ts", reads: 4, changes: 0, sources: {} },
    ]);
    const o = { depth: 3, header: 18, pad: 3, minOpen: 40, minBox: 1 };
    const boxes = nestedLayout<TreeNode>(tree, { x: 0, y: 0, w: 1000, h: 560 }, o, touches, (n) => (n.kind === "dir" ? n.children : undefined));
    const byPath = new Map(boxes.map((b) => [b.node.path, b]));
    const a = byPath.get("a")!;
    expect(a.open).toBe(true);
    const inner = { x: a.rect.x + o.pad, y: a.rect.y + o.header, w: a.rect.w - 2 * o.pad, h: a.rect.h - o.header - o.pad };
    for (const p of ["a/x.ts", "a/y.ts", "a/b"]) expect(inside(byPath.get(p)!.rect, inner)).toBe(true);
    expect(inside(byPath.get("a/b/z.ts")!.rect, byPath.get("a/b")!.rect)).toBe(true);
    // Top level: proportional to touches (a: 17, c: 4).
    expect(area(a.rect) / area(byPath.get("c.ts")!.rect)).toBeCloseTo(17 / 4, 6);
  });
});

describe("gourceLog", () => {
  const t = (ts: number, kind: GourceTouch["kind"], path: string, user = "fix tests", source = "omp"): GourceTouch => ({ ts, kind, path, user, source });

  it("writes unix seconds, sorted ascending, with A for the first change and M after", () => {
    const log = gourceLog([t(T + 5_000, "edit", "src/a.ts"), t(T + 1_500, "write", "src/a.ts"), t(T + 9_000, "write", "src/b.ts", "other", "codex")]);
    const s = Math.floor(T / 1000);
    expect(log).toBe(
      [`${s + 1}|fix tests|A|src/a.ts|${GOURCE_COLOURS.omp}`, `${s + 5}|fix tests|M|src/a.ts|${GOURCE_COLOURS.omp}`, `${s + 9}|other|A|src/b.ts|${GOURCE_COLOURS.codex}`, ""].join("\n"),
    );
  });

  it("keeps input order for equal timestamps", () => {
    const lines = gourceLog([t(T, "write", "x"), t(T, "edit", "x"), t(T, "delete", "x")]).trim().split("\n");
    expect(lines.map((l) => l.split("|")[2])).toEqual(["A", "M", "D"]);
  });

  it("deletes and moves: D on the source, A on the target, A again after a delete", () => {
    const lines = gourceLog([t(T, "edit", "a"), t(T + 1000, "move-from", "a"), t(T + 1000, "move-to", "b"), t(T + 2000, "delete", "b"), t(T + 3000, "edit", "b")])
      .trim()
      .split("\n");
    expect(lines.map((l) => `${l.split("|")[2]} ${l.split("|")[3]}`)).toEqual(["A a", "D a", "A b", "D b", "A b"]);
  });

  it("leaves reads out unless asked, then logs them as dimmed M", () => {
    const touches = [t(T, "read", "a"), t(T + 1000, "edit", "a")];
    expect(gourceLog(touches)).toBe(`${Math.floor(T / 1000) + 1}|fix tests|A|a|${GOURCE_COLOURS.omp}\n`);
    const withReads = gourceLog(touches, { reads: true }).trim().split("\n");
    expect(withReads[0]).toBe(`${Math.floor(T / 1000)}|fix tests|M|a|${dim(GOURCE_COLOURS.omp)}`);
    expect(dim("FF8040")).toBe("7F4020");
  });

  it("keeps every line at five fields: no | or newline inside paths or names", () => {
    const line = gourceLog([t(T, "write", "odd|name\nfile.ts", "a|b\nc", "unknown-tool")]).trim();
    expect(line.split("\n")).toHaveLength(1);
    const fields = line.split("|");
    expect(fields).toHaveLength(5);
    expect(fields[1]).toBe("a¦b c");
    expect(fields[3]).toBe("odd¦name file.ts");
    expect(fields[4]).toMatch(/^[0-9A-F]{6}$/);
  });

  it("is empty without touches", () => {
    expect(gourceLog([])).toBe("");
  });
});

function insertSession(db: Db, id: string, opts: { parentId?: string; title?: string; cwd?: string | null; startedAt?: number; endedAt?: number } = {}): void {
  const [source, nativeId] = id.split(":");
  db.prepare(
    `INSERT INTO sessions (id, source, native_id, parent_id, file_path, title, cwd, git_branch, agent_version, models,
       started_at, ended_at, event_count, user_messages, tool_calls, tool_errors, errors, requests,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, cost_source, events_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, '[]', ?, ?, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 'none', '')`,
  ).run(
    id,
    source,
    nativeId,
    opts.parentId ?? null,
    `/logs/${nativeId}.jsonl`,
    opts.title ?? nativeId,
    opts.cwd === undefined ? "/work/proj" : opts.cwd,
    opts.startedAt ?? T,
    opts.endedAt ?? opts.startedAt ?? T,
  );
}

function insertCalls(db: Db, sessionId: string, calls: { ts: number; tool: string; input: unknown }[]): void {
  const stmt = db.prepare("INSERT INTO events (session_id, seq, ts, kind, tool_name, tool_call_id, tool_input) VALUES (?, ?, ?, 'tool_call', ?, ?, ?)");
  calls.forEach((c, seq) => stmt.run(sessionId, seq, c.ts, c.tool, `c${seq}`, typeof c.input === "string" ? c.input : JSON.stringify(c.input)));
}

describe("project store", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
    insertSession(db, "omp:root", { title: "Build feature", endedAt: T + 60 * MIN });
    insertSession(db, "omp:sub", { parentId: "omp:root", title: "Explore", startedAt: T + MIN, endedAt: T + 10 * MIN });
    insertSession(db, "claude-code:c1", { title: "Fix bug", startedAt: T + 2 * 86400_000 });
    insertSession(db, "omp:elsewhere", { cwd: "/work/other" });
    insertCalls(db, "omp:root", [
      { ts: T, tool: "read", input: { path: "src/a.ts:10-20" } },
      { ts: T + MIN, tool: "edit", input: { input: "[src/a.ts#ABCD]\nPUT 1.=1:\n+x\n[src/old.ts#1234]\nMV src/new.ts" } },
      { ts: T + 2 * MIN, tool: "bash", input: { command: "ls" } },
      { ts: T + 3 * MIN, tool: "grep", input: { path: "src" } },
      { ts: T + 4 * MIN, tool: "read", input: { path: "~/notes.md" } },
      { ts: T + 5 * MIN, tool: "read", input: { path: "/work/proj" } },
    ]);
    insertCalls(db, "omp:sub", [{ ts: T + 2 * MIN, tool: "read", input: { path: "/work/proj/src/a.ts" } }]);
    insertCalls(db, "claude-code:c1", [
      { ts: T + 2 * 86400_000, tool: "Write", input: { file_path: "/work/proj/src/a.ts", content: "y" } },
      { ts: T + 2 * 86400_000 + MIN, tool: "Bash", input: { command: "rm x" } },
    ]);
    insertCalls(db, "omp:elsewhere", [{ ts: T, tool: "write", input: { path: "z.ts" } }]);
  });

  it("aggregates file touches across sessions and subagents of the project", () => {
    const map = projectMap(db, "/work/proj", {}, HOME);
    const byPath = Object.fromEntries(map.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(["src/a.ts", "src/new.ts", "src/old.ts", "~/notes.md"]);
    expect(byPath["src/a.ts"]).toMatchObject({ reads: 2, edits: 1, writes: 1, changes: 2, sessions: 2, agents: 3, sources: { omp: 3, "claude-code": 1 } });
    expect(byPath["src/old.ts"]).toMatchObject({ moves: 1, changes: 1 });
    expect(map.files[0].path).toBe("src/a.ts");
    expect(map).toMatchObject({ sessions: 2, agents: 3, reads: 3, changes: 4 });
  });

  it("applies time and source filters on top of the cached log", () => {
    expect(projectMap(db, "/work/proj", { from: T + 86400_000 }, HOME).files.map((f) => f.path)).toEqual(["src/a.ts"]);
    const codexOnly = projectMap(db, "/work/proj", { source: "claude-code" }, HOME);
    expect(codexOnly.files).toHaveLength(1);
    expect(codexOnly.files[0]).toMatchObject({ writes: 1, reads: 0 });
  });

  it("lists every call of one file, newest first, with per-agent counts", () => {
    const d = projectFile(db, "/work/proj", {}, "src/a.ts", HOME)!;
    expect(d.abs).toBe("/work/proj/src/a.ts");
    expect(d.calls.map((c) => [c.sessionId, c.seq, c.kind])).toEqual([
      ["claude-code:c1", 0, "write"],
      ["omp:sub", 0, "read"],
      ["omp:root", 1, "edit"],
      ["omp:root", 0, "read"],
    ]);
    const sub = d.agents.find((a) => a.sessionId === "omp:sub")!;
    expect(sub).toMatchObject({ subagent: true, rootId: "omp:root", reads: 1 });
    expect(projectFile(db, "/work/proj", {}, "nope.ts", HOME)).toBeNull();
  });

  it("summarises projects with files changed", () => {
    const rows = listProjects(db, {}, HOME);
    const proj = rows.find((r) => r.cwd === "/work/proj")!;
    expect(proj).toMatchObject({ sessions: 2, agents: 3, sources: ["claude-code", "omp"], filesChanged: 3, filesTouched: 4 });
    expect(rows.map((r) => r.cwd).sort()).toEqual(["/work/other", "/work/proj"]);
  });

  it("exports Gource touches for a project and for a session tree", () => {
    const project = gourceLog(projectGource(db, "/work/proj", {}, HOME)).trim().split("\n");
    expect(project.map((l) => l.split("|").slice(1, 4).join(" "))).toEqual(["Build feature A src/a.ts", "Build feature D src/old.ts", "Build feature A src/new.ts", "Fix bug M src/a.ts"]);
    const tree = sessionGource(db, "omp:root", HOME)!;
    expect(new Set(tree.map((x) => x.user))).toEqual(new Set(["Build feature", "Explore"]));
    expect(tree.every((x) => x.source === "omp")).toBe(true);
    expect(sessionGource(db, "omp:missing", HOME)).toBeNull();
  });
});
