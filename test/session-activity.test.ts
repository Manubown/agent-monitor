import { beforeEach, describe, expect, it } from "vitest";
import { invertTime, mapQuery, parseMapFilters, passes } from "../app/components/graph/mapFilters";
import { activeSpans, timeScale, timeTicks } from "../app/components/graph/timeScale";
import { commandHeads, urlResource } from "../src/core/resources";
import { type Db, openDb } from "../src/store/db";
import { categorize, clip, displayPath, sessionActivity } from "../src/store/activity";

const T = Date.UTC(2026, 9, 1, 12);
const MIN = 60_000;

function insertSession(db: Db, id: string, opts: { parentId?: string; title?: string; cwd?: string; startedAt?: number; file?: string } = {}): void {
  const [source, nativeId] = id.split(":");
  db.prepare(
    `INSERT INTO sessions (id, source, native_id, parent_id, file_path, title, cwd, git_branch, agent_version, models,
       started_at, ended_at, event_count, user_messages, tool_calls, tool_errors, errors, requests,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, cost_source, events_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, '[]', ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 'none', '')`,
  ).run(
    id,
    source,
    nativeId,
    opts.parentId ?? null,
    opts.file ?? `/logs/${nativeId}.jsonl`,
    opts.title ?? nativeId,
    opts.cwd ?? "/work/proj",
    opts.startedAt ?? T,
    opts.startedAt ?? T,
  );
}

interface Ev {
  ts: number;
  kind: string;
  tool?: string;
  callId?: string;
  input?: unknown;
  text?: string;
  error?: boolean;
}

function insertEvents(db: Db, sessionId: string, events: Ev[]): void {
  const stmt = db.prepare(
    "INSERT INTO events (session_id, seq, ts, kind, text, tool_name, tool_call_id, tool_input, is_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  events.forEach((e, seq) =>
    stmt.run(
      sessionId,
      seq,
      e.ts,
      e.kind,
      e.text ?? null,
      e.tool ?? null,
      e.callId ?? null,
      e.input === undefined ? null : JSON.stringify(e.input),
      e.error ? 1 : 0,
    ),
  );
}

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("sessionActivity", () => {
  it("returns null for an unknown session", () => {
    expect(sessionActivity(db, "omp:nope", "/home/me")).toBeNull();
  });

  it("includes the whole subagent tree, spawner first, with spawn links", () => {
    insertSession(db, "omp:root", { title: "Root" });
    insertSession(db, "omp:b", { parentId: "omp:root", startedAt: T + 2 * MIN, file: "/logs/root/Beta.jsonl" });
    insertSession(db, "omp:a", { parentId: "omp:root", startedAt: T + 1 * MIN + 100, file: "/logs/root/Alpha.jsonl" });
    insertSession(db, "omp:a1", { parentId: "omp:a", startedAt: T + 3 * MIN });
    insertSession(db, "omp:other", {});
    insertEvents(db, "omp:root", [
      { ts: T, kind: "user", text: "do  the\nthing" },
      { ts: T + MIN, kind: "tool_call", tool: "task", callId: "t1", input: { tasks: [{ name: "Alpha" }, { name: "Beta" }] } },
      { ts: T + 90_000, kind: "tool_call", tool: "task", callId: "t2", input: { tasks: [{ name: "Beta" }] } },
    ]);
    insertEvents(db, "omp:a", [{ ts: T + 2 * MIN + 30_000, kind: "tool_call", tool: "task", callId: "x", input: { tasks: [{ name: "a1" }] } }]);
    insertEvents(db, "omp:a1", [{ ts: T + 4 * MIN, kind: "tool_call", tool: "bash", callId: "y", input: { command: "ls -la\necho" } }]);
    insertEvents(db, "omp:other", [{ ts: T, kind: "tool_call", tool: "bash", callId: "z", input: { command: "nope" } }]);

    const act = sessionActivity(db, "omp:root", "/home/me")!;
    expect(act.agents.map((a) => [a.id, a.parent, a.depth])).toEqual([
      ["omp:root", null, 0],
      ["omp:a", 0, 1],
      ["omp:a1", 1, 2],
      ["omp:b", 0, 1],
    ]);
    expect(act.actions.map((a) => a.agent).sort()).toEqual([0, 0, 1, 2]);
    // Agent end grows to its last action; slots cycle over the categorical palette.
    expect(act.agents[2].endedAt).toBe(T + 4 * MIN);
    expect(act.agents.map((a) => a.slot)).toEqual([1, 2, 3, 4]);

    const call = (agent: number, ts: number) => act.actions.findIndex((a) => a.agent === agent && a.ts === ts);
    // Alpha is named by the first task call; Beta by the later one; a1 by its parent's only spawn call.
    expect(act.agents[1].spawn).toBe(call(0, T + MIN));
    expect(act.agents[3].spawn).toBe(call(0, T + 90_000));
    expect(act.agents[2].spawn).toBe(call(1, T + 2 * MIN + 30_000));

    expect(act.markers).toEqual([{ agent: 0, seq: 0, ts: T, kind: "prompt", label: "do the thing" }]);
    const bash = act.actions[call(2, T + 4 * MIN)];
    expect(bash).toMatchObject({ cat: "shell", label: "ls -la", tool: "bash" });
    expect(act.actions[call(0, T + MIN)]).toMatchObject({ cat: "agent", label: "2 tasks: Alpha, Beta" });
  });

  it("pairs tool errors by call id", () => {
    insertSession(db, "omp:s");
    insertEvents(db, "omp:s", [
      { ts: T, kind: "tool_call", tool: "bash", callId: "c1", input: { command: "make" } },
      { ts: T + 1, kind: "tool_call", tool: "bash", callId: "c2", input: { command: "make test" } },
      { ts: T + 2, kind: "tool_result", tool: "bash", callId: "c2", error: true },
      { ts: T + 3, kind: "tool_result", tool: "bash", callId: "c1" },
      { ts: T + 4, kind: "error", text: "rate limited" },
    ]);
    const act = sessionActivity(db, "omp:s", "/home/me")!;
    expect(act.actions.map((a) => [a.label, a.error ?? false])).toEqual([
      ["make", false],
      ["make test", true],
    ]);
    expect(act.markers).toEqual([{ agent: 0, seq: 4, ts: T + 4, kind: "error", label: "rate limited" }]);
  });

  it("aggregates file operations per file and agent with display paths", () => {
    insertSession(db, "omp:s", { cwd: "/work/proj" });
    insertSession(db, "omp:sub", { parentId: "omp:s", cwd: "/work/proj", startedAt: T + 10 });
    insertEvents(db, "omp:s", [
      { ts: T, kind: "tool_call", tool: "read", callId: "1", input: { path: "src/a.ts" } },
      { ts: T + 1, kind: "tool_call", tool: "edit", callId: "2", input: { input: "[src/a.ts#AB12]\nPUT 1.=1:\n+x\n[src/old.ts#CD34]\nMV src/new.ts\n" } },
      { ts: T + 2, kind: "tool_call", tool: "write", callId: "3", input: { path: "/work/proj/README.md", content: "hi" } },
      { ts: T + 3, kind: "tool_call", tool: "read", callId: "4", input: { path: "~/notes/todo.md" } },
      { ts: T + 4, kind: "tool_call", tool: "read", callId: "5", input: { path: "/home/me/notes/todo.md:10-20" } },
      { ts: T + 5, kind: "tool_call", tool: "read", callId: "6", input: { path: "/etc/hosts" } },
      { ts: T + 6, kind: "tool_call", tool: "read", callId: "7", input: { path: "https://example.com/doc" } },
      { ts: T + 7, kind: "tool_call", tool: "grep", callId: "8", input: { pattern: "foo", path: "src" } },
      { ts: T + 8, kind: "tool_call", tool: "read", callId: "9", input: { path: "." } },
    ]);
    insertEvents(db, "omp:sub", [
      { ts: T + 20, kind: "tool_call", tool: "edit", callId: "1", input: { input: "[src/a.ts#AB12]\nPUT 2.=2:\n+y\n" } },
      { ts: T + 21, kind: "tool_call", tool: "edit", callId: "2", input: { input: "[README.md#AB12]\nREM\n" } },
    ]);
    const act = sessionActivity(db, "omp:s", "/home/me")!;
    const file = (p: string) => act.files.find((f) => f.path === p)!;

    expect(act.files.map((f) => f.path).sort()).toEqual(["/etc/hosts", "README.md", "src/a.ts", "src/new.ts", "src/old.ts", "~/notes/todo.md"]);
    expect(file("src/a.ts")).toMatchObject({
      dir: "src",
      reads: 1,
      edits: 2,
      writes: 0,
      first: T,
      last: T + 20,
      agents: [
        { agent: 0, reads: 1, writes: 0, edits: 1, deletes: 0, moves: 0 },
        { agent: 1, reads: 0, writes: 0, edits: 1, deletes: 0, moves: 0 },
      ],
    });
    expect(file("src/old.ts")).toMatchObject({ moves: 1 });
    expect(file("src/new.ts")).toMatchObject({ moves: 1 });
    expect(file("README.md")).toMatchObject({ dir: "", writes: 1, deletes: 1 });
    expect(file("~/notes/todo.md")).toMatchObject({ dir: "~/notes", reads: 2 });
    expect(file("/etc/hosts")).toMatchObject({ dir: "/etc", reads: 1 });

    // Actions point at their files and back; the edit touching two files counts once per file.
    const edit = act.actions.findIndex((a) => a.ts === T + 1);
    expect(act.actions[edit]).toMatchObject({ cat: "write", label: "a.ts +1" });
    expect(act.actions[edit].files!.map((i) => act.files[i].path)).toEqual(["src/a.ts", "src/old.ts", "src/new.ts"]);
    expect(file("src/a.ts").actions).toContain(edit);

    const cats = Object.fromEntries(act.actions.map((a) => [a.ts - T, a.cat]));
    expect(cats).toMatchObject({ 0: "read", 2: "write", 6: "web", 7: "search", 21: "write" });
  });

  it("lists each agent once when a malformed log makes a parent cycle", () => {
    insertSession(db, "omp:a", { parentId: "omp:b" });
    insertSession(db, "omp:b", { parentId: "omp:a", startedAt: T + 1 });
    insertEvents(db, "omp:b", [{ ts: T + 2, kind: "tool_call", tool: "read", callId: "1", input: { path: "src/a.ts" } }]);
    const act = sessionActivity(db, "omp:a", "/home/me")!;
    expect(act.agents.map((a) => a.id)).toEqual(["omp:a", "omp:b"]);
    expect(act.actions).toHaveLength(1);
    expect(act.files.map((f) => [f.path, f.reads])).toEqual([["src/a.ts", 1]]);
  });

  it("counts a file once however a Windows session wrote its path", () => {
    insertSession(db, "claude:w", { cwd: "C:\\Users\\me\\proj" });
    insertEvents(db, "claude:w", [
      { ts: T, kind: "tool_call", tool: "Read", callId: "1", input: { file_path: "C:\\Users\\me\\proj\\src\\a.ts" } },
      { ts: T + 1, kind: "tool_call", tool: "Edit", callId: "2", input: { file_path: "c:\\Users\\me\\proj\\src\\a.ts", old_string: "a", new_string: "b" } },
      { ts: T + 2, kind: "tool_call", tool: "read", callId: "3", input: { path: "src\\a.ts" } },
      { ts: T + 3, kind: "tool_call", tool: "Read", callId: "4", input: { file_path: "C:\\Users\\me\\notes\\todo.md" } },
      { ts: T + 4, kind: "tool_call", tool: "Read", callId: "5", input: { file_path: "D:\\data\\x.csv" } },
      { ts: T + 5, kind: "tool_call", tool: "Read", callId: "6", input: { file_path: "C:\\Users\\me\\proj" } },
      { ts: T + 6, kind: "tool_call", tool: "Grep", callId: "7", input: { pattern: "foo", path: "C:\\Users\\me\\proj\\src" } },
    ]);
    const act = sessionActivity(db, "claude:w", "C:\\Users\\me")!;
    expect(act.files.map((f) => [f.path, f.dir, f.reads, f.edits])).toEqual([
      ["src/a.ts", "src", 2, 1],
      ["~/notes/todo.md", "~/notes", 1, 0],
      ["D:/data/x.csv", "D:/data", 1, 0],
    ]);
    expect(act.actions[1].label).toBe("a.ts");
    // Search scopes are resources, shown the same way as files.
    expect(act.resources.find((r) => r.kind === "search")?.label).toContain("src");
    expect(act.resources.find((r) => r.kind === "search")?.label).not.toContain("C:");
  });
});

describe("helpers", () => {
  it("categorizes tools across agents", () => {
    expect(categorize("Read", [])).toBe("read");
    expect(categorize("Bash", [])).toBe("shell");
    expect(categorize("exec_command", [{ op: "edit", path: "/x" }])).toBe("write");
    expect(categorize("WebFetch", [])).toBe("web");
    expect(categorize("Task", [])).toBe("agent");
    expect(categorize("todo", [])).toBe("other");
    expect(categorize("constructor", [])).toBe("other");
  });

  it("clips labels to one short line", () => {
    expect(clip("a\n  b")).toBe("a b");
    expect(clip("x".repeat(80))).toHaveLength(60);
    expect(clip("x".repeat(80)).endsWith("…")).toBe(true);
  });

  it("shows paths relative to the working directory, else under home", () => {
    expect(displayPath("/work/proj/src/a.ts", "/work/proj", "/home/me")).toBe("src/a.ts");
    expect(displayPath("/work/project2/a.ts", "/work/proj", "/home/me")).toBe("/work/project2/a.ts");
    expect(displayPath("/home/me/x/y.md", "/work/proj", "/home/me")).toBe("~/x/y.md");
    expect(displayPath("/home/me/x/y.md", null, "/home/me")).toBe("~/x/y.md");
    // Windows: paths arrive in slash form; the working directory and home are read in either form.
    expect(displayPath("C:/work/proj/src/a.ts", "c:\\work\\proj", "C:\\Users\\me")).toBe("src/a.ts");
    expect(displayPath("C:/work/proj", "C:\\work\\proj\\", "C:\\Users\\me")).toBe(".");
    expect(displayPath("C:/Users/me/x.md", "C:\\work\\proj", "C:\\Users\\me")).toBe("~/x.md");
    expect(displayPath("D:/x.md", "C:\\work\\proj", "C:\\Users\\me")).toBe("D:/x.md");
  });
});

describe("timeScale", () => {
  it("splits activity at idle gaps longer than the threshold", () => {
    expect(activeSpans([T + 30 * MIN, T, T + 5 * MIN, T + 31 * MIN], 10 * MIN)).toEqual([
      { start: T, end: T + 5 * MIN },
      { start: T + 30 * MIN, end: T + 31 * MIN },
    ]);
    expect(activeSpans([])).toEqual([]);
  });

  it("compresses idle gaps into fixed-width breaks", () => {
    // 10 active minutes, a 5 hour gap, 10 more active minutes.
    const times = [T, T + 10 * MIN, T + 310 * MIN, T + 320 * MIN];
    const s = timeScale(times, 100, 436, { breakPx: 36, minPx: 8 });
    expect(s.breaks).toEqual([{ from: T + 10 * MIN, to: T + 310 * MIN, x0: 300, x1: 336 }]);
    expect(s.segments.map((g) => [g.x0, g.x1])).toEqual([
      [100, 300],
      [336, 536],
    ]);
    expect(s.x(T)).toBe(100);
    expect(s.x(T + 5 * MIN)).toBe(200);
    expect(s.x(T + 160 * MIN)).toBe(318); // middle of the gap -> middle of the break
    expect(s.x(T + 320 * MIN)).toBe(536);
    expect(s.x(T - MIN)).toBe(100);
    expect(s.x(T + 999 * MIN)).toBe(536);
  });

  it("keeps single-moment bursts visible and monotonic", () => {
    const s = timeScale([T, T + 60 * MIN, T + 61 * MIN], 0, 200, { breakPx: 20, minPx: 10 });
    expect(s.segments[0].x1 - s.segments[0].x0).toBe(10);
    expect(s.x(T)).toBe(5);
    const xs = [T, T + 30 * MIN, T + 60 * MIN, T + 60.5 * MIN, T + 61 * MIN].map(s.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it("places ticks on round times at least the spacing apart", () => {
    const s = timeScale([T, T + 60 * MIN], 0, 600);
    const ticks = timeTicks(s, 80);
    expect(ticks[0]).toEqual({ ts: T, x: 0 });
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].x - ticks[i - 1].x).toBeGreaterThanOrEqual(80);
      expect(ticks[i].ts % (5 * MIN)).toBe(0);
    }
  });
});

describe("resources", () => {
  it("normalizes shell command heads", () => {
    const heads = (c: string) => commandHeads(c).map((h) => h.head);
    expect(heads("cd /work/proj && pnpm test 2>&1 | tail -5")).toEqual(["pnpm test"]);
    expect(heads("git -C /repo commit -m 'a; b && c'")).toEqual(["git commit"]);
    expect(heads("FOO=1 timeout 60 cargo build --release; pnpm run build\n/usr/bin/git status")).toEqual(["cargo build", "pnpm run build", "git status"]);
    expect(heads("cat <<'EOF' > notes.md\nrm -rf /\nEOF\nls -la")).toEqual(["cat", "ls"]);
    expect(heads("python3 -m pytest -q # run the tests")).toEqual(["python3 -m pytest"]);
    expect(heads("cd sub")).toEqual(["cd"]);
    expect(heads("for f in a b; do wc -l $f; done")).toEqual(["wc"]);
    expect(heads("if grep -q x notes.md; then echo found; fi")).toEqual(["grep"]);
    expect(commandHeads("sudo -u me docker compose up")).toEqual([{ head: "docker compose", binary: "docker" }]);
  });

  it("keys URLs without fragment and groups them by host", () => {
    expect(urlResource("https://www.example.com/docs/a?x=1#part")).toEqual({
      kind: "web",
      key: "https://www.example.com/docs/a?x=1",
      label: "example.com/docs/a?x=1",
      group: "example.com",
    });
    expect(urlResource("https://example.com/").label).toBe("example.com");
  });

  it("collects what each call worked on, with per-agent counts and errors", () => {
    insertSession(db, "omp:root", { title: "Root", cwd: "/work/proj" });
    insertSession(db, "omp:sub", { parentId: "omp:root", title: "Helper", startedAt: T + 20, file: "/logs/root/Alpha.jsonl" });
    insertEvents(db, "omp:root", [
      { ts: T, kind: "tool_call", tool: "bash", callId: "1", input: { command: "cd /work/proj && pnpm test" } },
      { ts: T + 1, kind: "tool_result", tool: "bash", callId: "1", error: true },
      { ts: T + 2, kind: "tool_call", tool: "exec_command", callId: "2", input: { cmd: ["bash", "-lc", "git commit -m x"] } },
      { ts: T + 3, kind: "tool_call", tool: "WebFetch", callId: "3", input: { url: "https://www.example.com/docs/a#intro" } },
      { ts: T + 4, kind: "tool_call", tool: "read", callId: "4", input: { path: "https://www.example.com/docs/a" } },
      { ts: T + 5, kind: "tool_call", tool: "web_search", callId: "5", input: { query: "Rust  napi\nbindings" } },
      { ts: T + 6, kind: "tool_call", tool: "grep", callId: "6", input: { pattern: "TODO", path: "src" } },
      { ts: T + 7, kind: "tool_call", tool: "glob", callId: "7", input: { path: "/work/proj/app/*.tsx" } },
      { ts: T + 8, kind: "tool_call", tool: "mcp__github__create_issue", callId: "8", input: { title: "x" } },
      { ts: T + 9, kind: "tool_call", tool: "todo", callId: "9", input: { op: "init" } },
      { ts: T + 10, kind: "tool_call", tool: "task", callId: "10", input: { tasks: [{ name: "Alpha" }] } },
      { ts: T + 11, kind: "tool_call", tool: "read", callId: "11", input: { path: "src/a.ts" } },
    ]);
    insertEvents(db, "omp:sub", [{ ts: T + 30, kind: "tool_call", tool: "bash", callId: "1", input: { command: "pnpm test --watch=false" } }]);

    const act = sessionActivity(db, "omp:root", "/home/me")!;
    const res = (label: string) => act.resources.find((r) => r.label === label)!;
    const call = (ts: number) => act.actions.findIndex((a) => a.ts === ts);

    expect(res("pnpm test")).toMatchObject({
      kind: "command",
      group: "pnpm",
      calls: 2,
      errors: 1,
      first: T,
      last: T + 30,
      agents: [
        { agent: 0, calls: 1, errors: 1 },
        { agent: 1, calls: 1, errors: 0 },
      ],
    });
    expect(res("pnpm test").actions).toEqual([call(T), call(T + 30)]);
    expect(res("git commit")).toMatchObject({ kind: "command", group: "git", calls: 1, errors: 0 });
    // A fetch and a read of the same page are one resource.
    expect(res("example.com/docs/a")).toMatchObject({ kind: "web", group: "example.com", calls: 2 });
    expect(res("Rust napi bindings")).toMatchObject({ kind: "web", group: "search" });
    expect(res("TODO · src")).toMatchObject({ kind: "search", group: "grep" });
    expect(res("app/*.tsx")).toMatchObject({ kind: "search", group: "glob" });
    expect(res("create_issue")).toMatchObject({ kind: "tool", group: "mcp__github" });
    expect(res("todo")).toMatchObject({ kind: "tool", group: "tools" });
    expect(res("Helper")).toMatchObject({ kind: "agent", group: "Root", agent: 1, actions: [call(T + 10)] });

    // Calls point at their resources; plain file reads only at files.
    expect(act.actions[call(T)].res!.map((r) => act.resources[r].label)).toEqual(["pnpm test"]);
    expect(act.actions[call(T + 11)].res).toBeUndefined();
    expect(act.actions[call(T + 11)].files).toHaveLength(1);
  });

  it("carries the dispatch prompt of subagents", () => {
    insertSession(db, "omp:root");
    insertSession(db, "omp:sub", { parentId: "omp:root", startedAt: T + 10 });
    insertEvents(db, "omp:sub", [{ ts: T + 10, kind: "user", text: "Fix   the\nparser" }]);
    db.prepare("UPDATE sessions SET dispatch_seq = 0 WHERE id = 'omp:sub'").run();
    const act = sessionActivity(db, "omp:root", "/home/me")!;
    expect(act.agents.map((a) => a.prompt)).toEqual([undefined, "Fix the parser"]);
  });
});

describe("resource map filters", () => {
  it("round-trips through the query string and drops defaults", () => {
    const f = parseMapFilters({ hide: "web,bogus,files", changed: "1", errors: "0", agent: "omp:a", from: String(T + MIN), to: String(T) });
    expect(f).toEqual({ hide: ["files", "web"], changed: true, errors: false, agent: "omp:a", from: T, to: T + MIN });
    expect(parseMapFilters(Object.fromEntries(new URLSearchParams(mapQuery(f))))).toEqual(f);
    expect(mapQuery(parseMapFilters({}))).toBe("");
  });

  it("filters calls by time, agent and failure", () => {
    const f = { ...parseMapFilters({}), from: T, to: T + MIN, errors: true };
    const a = { agent: 1, seq: 0, ts: T + 1, tool: "bash", cat: "shell" as const, label: "" };
    expect(passes({ ...a, error: true }, f, 1)).toBe(true);
    expect(passes(a, f, 1)).toBe(false);
    expect(passes({ ...a, error: true }, f, 0)).toBe(false);
    expect(passes({ ...a, error: true, ts: T + 2 * MIN }, f, null)).toBe(false);
  });

  it("inverts the compressed time axis", () => {
    const times = [T, T + 10 * MIN, T + 310 * MIN, T + 320 * MIN];
    const s = timeScale(times, 100, 436, { breakPx: 36, minPx: 8 });
    for (const t of [T, T + 5 * MIN, T + 160 * MIN, T + 315 * MIN, T + 320 * MIN]) expect(invertTime(s, s.x(t))).toBeCloseTo(t, -2);
    expect(invertTime(s, 0)).toBe(T);
    expect(invertTime(s, 9999)).toBe(T + 320 * MIN);
  });
});
