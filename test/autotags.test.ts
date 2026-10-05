import { describe, expect, it } from "vitest";
import { type AutoTagInput, autoTags, deriveAutoTags } from "../src/core/autotags";
import { DEFAULT_PRICES } from "../src/core/pricing";
import type { AgentEvent, ParsedSession } from "../src/core/types";
import { writeSession } from "../src/ingest/sync";
import { parseQuery } from "../src/search/query";
import { resolveSessions, sessionInfo } from "../src/search/service";
import { openDb } from "../src/store/db";
import { allTags, getSession, listSessions } from "../src/store/queries";

const T = Date.UTC(2026, 9, 1, 12);

type Ev = Omit<AgentEvent, "ts"> & { ts?: number };

const call = (toolName: string, input: unknown): Ev => ({ kind: "tool_call", toolName, toolInput: JSON.stringify(input) });
const sh = (command: string | string[]): Ev => call("bash", { command });
const ok: Ev = { kind: "tool_result" };
const fail: Ev = { kind: "tool_result", isError: true };

/** Events one second apart unless they carry their own time. */
const events = (list: Ev[]): AgentEvent[] => list.map((e, i) => ({ ...e, ts: e.ts ?? T + i * 1000 }));

const derive = (list: Ev[], extra: Partial<AutoTagInput> = {}) => deriveAutoTags({ events: events(list), cwd: "/work/app", ...extra });
const tagsOf = (list: Ev[], extra: Partial<AutoTagInput> = {}) => autoTags({ events: events(list), cwd: "/work/app", ...extra });
const reason = (list: Ev[], tag: string, extra: Partial<AutoTagInput> = {}) => derive(list, extra).find((t) => t.tag === tag)?.reason;

describe("language tags", () => {
  it("tags languages of changed files, never of files only read", () => {
    const list = [
      call("Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }),
      call("Write", { file_path: "/work/app/src/b.tsx", content: "x" }),
      call("edit", { input: "[src/c.ts#ABCD]\nPUT 1.=1:\n+x" }),
      call("Read", { file_path: "tools/gen.py" }),
    ];
    expect(tagsOf(list)).toEqual(["typescript"]);
    expect(reason(list, "typescript")).toBe("changed 3 TypeScript files");
  });

  it("needs a minimum count or share, so a stray config edit does not tag", () => {
    const ts = ["a", "b", "c", "d", "e"].map((n) => call("Write", { file_path: `src/${n}.ts`, content: "x" }));
    expect(tagsOf([...ts, call("Edit", { file_path: "package.json" })])).toEqual(["typescript"]);
    // 1 of 2 changed files is a large enough share.
    const both = tagsOf([call("Edit", { file_path: "src/a.rs" }), call("Edit", { file_path: "Cargo.toml" })]);
    expect(both).toEqual(["config", "rust"]);
    expect(reason([call("Edit", { file_path: "src/a.rs" }), call("Edit", { file_path: "Cargo.toml" })], "rust")).toBe(
      "changed 1 Rust file (of 2 changed)",
    );
  });

  it("counts each file once and reads Codex patches", () => {
    const patch = "*** Begin Patch\n*** Add File: docs/guide.md\n+hi\n*** Update File: README.md\n@@\n-a\n+b\n*** End Patch";
    expect(tagsOf([call("apply_patch", { input: patch }), call("apply_patch", { input: patch })])).toEqual(["docs"]);
    expect(reason([call("apply_patch", { input: patch })], "docs")).toBe("changed 2 Markdown/docs files");
    expect(tagsOf([call("shell", { command: ["bash", "-lc", `apply_patch <<'EOF'\n${patch}\nEOF`] })])).toEqual(["docs"]);
  });
});

describe("shell activity tags", () => {
  it("tests: recognizes test runners behind wrappers and package scripts", () => {
    for (const cmd of ["pnpm vitest run test/a.test.ts", "cd app && cargo test -p core", "npm run test:unit", "python -m pytest -q", "npx jest", "go test ./..."]) {
      expect(tagsOf([sh(cmd)]), cmd).toEqual(["tests"]);
    }
    expect(tagsOf([call("shell", { command: ["bash", "-lc", "cargo test"] })])).toEqual(["tests"]);
    expect(tagsOf([call("exec_command", { cmd: "pytest" })])).toEqual(["tests"]);
    expect(reason([sh("pnpm test"), sh("pnpm test"), sh("cargo test")], "tests")).toBe("ran tests 3 times: pnpm test ×2, cargo test");
  });

  it("tests: ignores commands that only mention a runner", () => {
    for (const cmd of ["cat jest.config.js", "rg pytest src", "pnpm install", "echo vitest"]) expect(tagsOf([sh(cmd)]), cmd).not.toContain("tests");
  });

  it("git: commits, pushes and branch changes, not inspection", () => {
    expect(reason([sh("git add -A && git commit -m 'fix: x'"), sh("git -C /work/app push origin main")], "git")).toBe("git commit, git push");
    expect(tagsOf([sh("git branch feature/x")])).toEqual(["git"]);
    expect(tagsOf([sh("gh pr create --fill")])).toEqual(["git"]);
    for (const cmd of ["git status", "git --no-pager log -5", "git diff HEAD", "git branch --show-current", "git branch -a", "git stash list"]) {
      expect(tagsOf([sh(cmd)]), cmd).toEqual([]);
    }
  });

  it("deps: package additions and removals, not lockfile installs", () => {
    expect(reason([sh("pnpm add -D zod"), sh("cargo add serde --features derive"), sh("pip install requests")], "deps")).toBe(
      "changed dependencies: cargo add, pip install, pnpm add",
    );
    for (const cmd of ["pnpm install", "npm install", "npm ci", "cargo fetch"]) expect(tagsOf([sh(cmd)]), cmd).toEqual([]);
  });

  it("build: builds but not type checks", () => {
    expect(reason([sh("pnpm build"), sh("cargo build --release"), sh("tsc -p .")], "build")).toBe("ran 3 builds: cargo build, pnpm build, tsc");
    expect(tagsOf([sh("pnpm run build:native")])).toEqual(["build"]);
    for (const cmd of ["tsc --noEmit", "pnpm exec tsc --noEmit", "pnpm build-storybook", "make test"]) expect(tagsOf([sh(cmd)]), cmd).not.toContain("build");
  });
});

describe("other tags", () => {
  it("web: search and fetch tools and URL reads", () => {
    expect(reason([call("web_search", { query: "x" }), call("WebFetch", { url: "https://example.com" }), call("read", { path: "https://example.com/a" })], "web")).toBe(
      "3 web searches and fetches",
    );
    expect(tagsOf([call("read", { path: "src/a.ts" })])).toEqual([]);
  });

  it("refactor: three or more moves, or a refactor branch", () => {
    const mv = (from: string, to: string) => call("edit", { input: `[${from}#ABCD]\nMV ${to}` });
    expect(reason([mv("a.ts", "b.ts"), mv("c.ts", "d.ts"), sh("git mv e.ts f.ts")], "refactor")).toBe("moved or renamed 3 files");
    expect(tagsOf([mv("a.ts", "b.ts"), sh("git mv e.ts f.ts")])).not.toContain("refactor");
    expect(reason([], "refactor", { gitBranch: "refactor/store" })).toBe("on branch refactor/store");
    expect(tagsOf([], { gitBranch: "main" })).toEqual([]);
  });

  it("errors: failing tool calls above both thresholds, or API errors", () => {
    const results = (failures: number, total: number) => [...Array(failures).fill(fail), ...Array(total - failures).fill(ok)];
    expect(reason(results(3, 10), "errors")).toBe("3 of 10 tool calls failed");
    expect(tagsOf(results(3, 20))).toEqual([]); // 15%
    expect(tagsOf(results(2, 4))).toEqual([]); // too few
    expect(reason([{ kind: "error", text: "overloaded_error" }], "errors")).toBe("1 API error");
    expect(tagsOf([{ kind: "error", text: "Interrupted by user" }])).toEqual([]);
  });

  it("subagents: counts every spawned task", () => {
    expect(reason([call("task", { tasks: [{ task: "a" }, { task: "b" }] }), call("Task", { prompt: "c" })], "subagents")).toBe("spawned 3 subagents");
  });

  it("long: more than an hour of activity, idle gaps excluded", () => {
    const steady = Array.from({ length: 15 }, (_, i): Ev => ({ kind: "assistant", text: "x", ts: T + i * 5 * 60_000 })); // 70 min
    expect(reason(steady, "long")).toBe("1h 10m of activity");
    const idle = [0, 30, 200].map((m): Ev => ({ kind: "assistant", text: "x", ts: T + m * 60_000 }));
    expect(tagsOf(idle)).toEqual([]);
    // A tool or subagent running for 65 minutes is activity, not a pause.
    expect(tagsOf([{ ...sh("sleep 3900"), ts: T }, { ...ok, ts: T + 65 * 60_000 }])).toEqual(["long"]);
  });

  it("research: many lookups and no file changed", () => {
    const reads = Array.from({ length: 8 }, (_, i) => call("Read", { file_path: `src/f${i}.ts` }));
    const lookups = [...reads, call("Grep", { pattern: "x" }), sh("rg -n foo src")];
    expect(reason(lookups, "research")).toBe("10 reads, searches and fetches; no file changed");
    expect(tagsOf(lookups.slice(1))).toEqual([]);
    expect(tagsOf([...lookups, call("Edit", { file_path: "src/a.ts" })])).toEqual(["typescript"]);
  });

  it("returns sorted, unique tags", () => {
    const list = [sh("cargo test"), sh("cargo test"), sh("git commit -m x"), call("web_search", { query: "q" }), call("Edit", { file_path: "a.rs" })];
    expect(tagsOf(list)).toEqual(["git", "rust", "tests", "web"]);
  });
});

describe("stored auto tags", () => {
  const parsed = (list: Ev[]): ParsedSession => {
    const evs = events(list);
    return { source: "omp", nativeId: "s1", cwd: "/work/app", startedAt: T, endedAt: evs.at(-1)?.ts ?? T, events: evs, usage: [] };
  };

  it("are stored on write, recomputed on append, filterable and searchable", () => {
    const db = openDb(":memory:");
    const first = [{ kind: "user", text: "run the tests" } as Ev, sh("pnpm test"), ok];
    writeSession(db, "/logs/s1.jsonl", parsed(first), DEFAULT_PRICES);
    expect(getSession(db, "omp:s1")?.session.autoTags).toEqual([{ tag: "tests", reason: "ran tests 1 time: pnpm test" }]);

    // Appending events keeps the stored prefix and recomputes the tags over all events.
    writeSession(db, "/logs/s1.jsonl", parsed([...first, sh("git commit -m done"), ok]), DEFAULT_PRICES);
    expect(getSession(db, "omp:s1")?.session.eventCount).toBe(5);
    expect(getSession(db, "omp:s1")?.session.autoTags.map((t) => t.tag)).toEqual(["git", "tests"]);

    const page = { limit: 50, offset: 0 };
    expect(listSessions(db, { tag: "git" }, page).rows.map((r) => r.id)).toEqual(["omp:s1"]);
    expect(listSessions(db, { tag: "rust" }, page).total).toBe(0);
    expect(resolveSessions(db, parseQuery("#tests"))).toEqual(["omp:s1"]);
    expect(resolveSessions(db, parseQuery("tag:git"))).toEqual(["omp:s1"]);
    expect(allTags(db)).toEqual([
      { tag: "git", count: 1, auto: true },
      { tag: "tests", count: 1, auto: true },
    ]);

    // A manual tag equal to an automatic one shows once, as manual.
    db.prepare("INSERT INTO user.tags (session_id, tag, created_at) VALUES (?, ?, 0)").run("omp:s1", "tests");
    const s = getSession(db, "omp:s1")?.session;
    expect(s?.tags).toEqual(["tests"]);
    expect(s?.autoTags.map((t) => t.tag)).toEqual(["git"]);
    expect(sessionInfo(db, ["omp:s1"]).get("omp:s1")).toMatchObject({ tags: ["tests"], autoTags: [{ tag: "git", reason: "git commit" }] });
    expect(allTags(db)[0]).toEqual({ tag: "tests", count: 1, auto: false });

    // Replacing the session (rewritten log) drops tags that no longer apply.
    writeSession(db, "/logs/s1.jsonl", parsed([{ kind: "user", text: "hi" }]), DEFAULT_PRICES);
    expect(getSession(db, "omp:s1")?.session.autoTags).toEqual([]);
  });
});
