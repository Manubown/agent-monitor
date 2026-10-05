import { beforeEach, describe, expect, it } from "vitest";
import type { SearchHit, SearchIndex, SearchRequest } from "../src/search/native";
import { EVENT_KINDS, isEmptyQuery, parseDate, parseQuery, tokenize } from "../src/search/query";
import { context, facets, search } from "../src/search/service";
import { type Db, openDb } from "../src/store/db";

const NOW = new Date(2026, 9, 5, 15, 30).getTime(); // 5 Oct 2026 15:30 local
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const parse = (q: string) => parseQuery(q, { now: NOW });

describe("parseQuery", () => {
  it("makes the trailing word a prefix only while it is being typed", () => {
    expect(parse("foo bar").must).toEqual([
      { type: "term", text: "foo" },
      { type: "prefix", text: "bar" },
    ]);
    expect(parse("foo bar ").must).toEqual([
      { type: "term", text: "foo" },
      { type: "term", text: "bar" },
    ]);
    expect(parseQuery("foo bar", { complete: true }).must.map((c) => c.type)).toEqual(["term", "term"]);
    // A trailing operator does not turn the last word into a prefix.
    expect(parse("foo kind:reply").must).toEqual([{ type: "term", text: "foo" }]);
  });

  it("parses phrases, including an unterminated one while typing", () => {
    expect(parse('"exact phrase" word').must).toEqual([
      { type: "phrase", text: "exact phrase" },
      { type: "prefix", text: "word" },
    ]);
    expect(parse('word "still typ').must).toEqual([
      { type: "term", text: "word" },
      { type: "phrase", text: "still typ" },
    ]);
  });

  it("negates words and phrases but not flags", () => {
    const p = parse('-foo -"a b" bar');
    expect(p.mustNot).toEqual([
      { type: "term", text: "foo" },
      { type: "phrase", text: "a b" },
    ]);
    expect(p.must).toEqual([{ type: "prefix", text: "bar" }]);
    // A negated trailing word is never a prefix.
    expect(parse("bar -foo").mustNot).toEqual([{ type: "term", text: "foo" }]);
    expect(parse("git --force ").must).toEqual([
      { type: "term", text: "git" },
      { type: "term", text: "--force" },
    ]);
    expect(parse("a - b ").must.map((c) => c.text)).toEqual(["a", "b"]);
  });

  it("maps kind aliases and ORs repeated kinds", () => {
    expect(parse("kind:prompt").kinds).toEqual(["user"]);
    expect(parse("kind:reply").kinds).toEqual(["assistant"]);
    expect(parse("kind:thinking").kinds).toEqual(["thinking"]);
    expect(parse("kind:tool").kinds).toEqual(["tool_call", "tool_result"]);
    expect(parse("kind:call kind:result").kinds).toEqual(["tool_call", "tool_result"]);
    expect(parse("kind:system kind:error KIND:Error").kinds).toEqual(["system", "error"]);
    expect(parse("-kind:thinking -kind:system").kinds).toEqual(["user", "assistant", "tool_call", "tool_result", "error"]);
    expect(parse("kind:tool -kind:result").kinds).toEqual(["tool_call"]);
  });

  it("maps sources and reports unknown values without applying them", () => {
    expect(parse("source:omp source:claude").sources).toEqual(["omp", "claude-code"]);
    expect(parse("source:claude-code").sources).toEqual(["claude-code"]);
    expect(parse("-source:codex").sources).toEqual(["omp", "claude-code"]);
    const bad = parse("source:vim kind:nope");
    expect(bad.sources).toEqual([]);
    expect(bad.kinds).toEqual([]);
    expect(bad.tokens.map((t) => t.error)).toEqual([expect.stringContaining("vim"), expect.stringContaining("nope")]);
    expect(bad.must).toEqual([]);
  });

  it("collects tool, project, model, branch, tag and in: facets", () => {
    const p = parse('tool:Bash tool:read project:web project:"my app" model:opus branch:main tag:Review #ship #ship in:omp:abc123');
    expect(p.tools).toEqual(["bash", "read"]);
    expect(p.projects).toEqual(["web", "my app"]);
    expect(p.models).toEqual(["opus"]);
    expect(p.branches).toEqual(["main"]);
    expect(p.tags).toEqual(["review", "ship"]);
    expect(p.sessionIds).toEqual(["omp:abc123"]);
    expect(p.must).toEqual([]);
  });

  it("rejects negation where it is not supported", () => {
    const p = parse("-tool:Bash -#wip");
    expect(p.tools).toEqual([]);
    expect(p.tags).toEqual([]);
    expect(p.tokens.every((t) => t.error)).toBe(true);
  });

  it("parses absolute, named and relative dates in local time", () => {
    expect(parse("after:today").from).toBe(new Date(2026, 9, 5).getTime());
    expect(parse("after:yesterday").from).toBe(new Date(2026, 9, 4).getTime());
    expect(parse("after:24h").from).toBe(NOW - 24 * HOUR);
    expect(parse("after:7d").from).toBe(NOW - 7 * DAY);
    expect(parse("after:2w").from).toBe(NOW - 14 * DAY);
    expect(parse("after:2026-10-01 before:2026-10-03")).toMatchObject({
      from: new Date(2026, 9, 1).getTime(),
      to: new Date(2026, 9, 3).getTime(),
    });
    expect(parse("before:today").to).toBe(new Date(2026, 9, 5).getTime());
    // Repeated bounds OR together: the widest range wins.
    expect(parse("after:2026-10-01 after:2026-09-01").from).toBe(new Date(2026, 8, 1).getTime());
    expect(parse("before:2026-10-01 before:2026-10-04").to).toBe(new Date(2026, 9, 4).getTime());
    expect(parseDate("2026-02-30", NOW)).toBeUndefined();
    const bad = parse("after:soon");
    expect(bad.from).toBeUndefined();
    expect(bad.tokens[0].error).toBeDefined();
  });

  it("keeps unknown operators as literal terms", () => {
    expect(parse("foo:bar ").must).toEqual([{ type: "term", text: "foo:bar" }]);
    expect(parse("http://localhost:4100 x").must[0]).toEqual({ type: "term", text: "http://localhost:4100" });
  });

  it("reads sort and treats operators without a value as still being typed", () => {
    expect(parse("x sort:new").sort).toBe("newest");
    expect(parse("x sort:relevance").sort).toBe("relevance");
    expect(parse("x").sort).toBeUndefined();
    const typing = parse("kind:");
    expect(typing.tokens[0]).toMatchObject({ type: "operator", key: "kind", value: "" });
    expect(typing.tokens[0].error).toBeUndefined();
    expect(isEmptyQuery(typing)).toBe(true);
    expect(isEmptyQuery(parse("   "))).toBe(true);
    expect(isEmptyQuery(parse("kind:error"))).toBe(false);
  });

  it("tokenizes with source offsets for highlighting", () => {
    const q = '-kind:error "a b" #tag word';
    expect(tokenize(q).map((t) => [t.type, q.slice(t.start, t.end), t.negated])).toEqual([
      ["operator", "-kind:error", true],
      ["phrase", '"a b"', false],
      ["tag", "#tag", false],
      ["term", "word", false],
    ]);
  });
});

/** Records requests and answers with canned hits. */
class FakeIndex implements SearchIndex {
  requests: SearchRequest[] = [];
  constructor(public hits: SearchHit[] = []) {}
  generation() {
    return 1;
  }
  apply() {}
  search(req: SearchRequest) {
    this.requests.push(req);
    return this.hits.slice(0, req.limit);
  }
  docCount() {
    return this.hits.length;
  }
}

const hit = (sessionId: string, seq: number, kind = "assistant"): SearchHit => ({
  sessionId,
  seq,
  ts: NOW - seq * 1000,
  kind,
  score: 1,
  snippet: `snippet ${seq} needle`,
  highlights: [[`snippet ${seq} `.length, `snippet ${seq} needle`.length]],
});

function seed(db: Db): void {
  const session = db.prepare(
    `INSERT INTO sessions (id, source, native_id, parent_id, file_path, title, cwd, git_branch, models, started_at, ended_at,
       event_count, user_messages, tool_calls, tool_errors, errors, requests, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, cost_source, events_hash)
     VALUES (?, ?, ?, ?, '/logs/x.jsonl', ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 'none', '')`,
  );
  session.run("omp:a1", "omp", "a1", null, "Fix the web build", "/home/u/Work/web", "main", '["claude-opus-4"]', NOW - DAY, NOW - DAY + HOUR);
  session.run("claude-code:b2", "claude-code", "b2", "omp:a1", "Explore API", "/home/u/Work/api", "feature/x", '["claude-sonnet-4"]', NOW - 2 * DAY, NOW - 2 * DAY + HOUR);
  session.run("codex:c3", "codex", "c3", null, null, "/tmp/scratch_dir", null, '["gpt-5"]', NOW - 3 * DAY, NOW - 3 * DAY + HOUR);
  const event = db.prepare(
    "INSERT INTO events (session_id, seq, ts, kind, text, tool_name, tool_input, is_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (let seq = 0; seq < 10; seq++) {
    const kind = seq % 3 === 1 ? "tool_call" : seq % 3 === 2 ? "tool_result" : "assistant";
    event.run(
      "omp:a1",
      seq,
      NOW - DAY + seq * 1000,
      kind,
      kind === "tool_call" ? null : `event ${seq}`,
      kind === "assistant" ? null : "Bash",
      kind === "tool_call" ? JSON.stringify({ command: `ls ${seq}`, timeout: 5 }) : null,
      kind === "tool_result" && seq === 5 ? 1 : 0,
    );
  }
  event.run("claude-code:b2", 5, NOW, "user", "hello", null, null, 0);
  event.run("claude-code:b2", 6, NOW, "assistant", "world", null, null, 0);
  event.run("codex:c3", 0, NOW, "assistant", `${"x".repeat(3000)} needle ${"y".repeat(2000)}`, null, null, 0);
  db.prepare("INSERT INTO user.tags (session_id, tag, created_at) VALUES (?, ?, 0)").run("omp:a1", "review");
  db.prepare("INSERT INTO user.tags (session_id, tag, created_at) VALUES (?, ?, 0)").run("omp:a1", "ship");
}

describe("search service", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
    seed(db);
  });

  it("groups hits by session in first-appearance order with a per-group cap", () => {
    const index = new FakeIndex([
      hit("claude-code:b2", 5, "user"),
      hit("omp:a1", 1, "tool_call"),
      hit("claude-code:b2", 6),
      hit("omp:a1", -1, "session"),
      hit("omp:a1", 2, "tool_result"),
      hit("omp:a1", 3),
      hit("omp:a1", 4, "tool_call"),
      hit("missing:zz", 1),
    ]);
    const r = search(db, index, "needle", { perGroup: 2, now: NOW });
    expect(r.totalHits).toBe(8);
    expect(r.limited).toBe(false);
    expect(r.sort).toBe("relevance");
    expect(r.groups.map((g) => g.session.id)).toEqual(["claude-code:b2", "omp:a1"]);

    const [b2, a1] = r.groups;
    expect(b2.hits.map((h) => h.seq)).toEqual([5, 6]);
    expect(b2.more).toBe(0);
    expect(b2.session).toMatchObject({ parentId: "omp:a1", parentTitle: "Fix the web build", sourceLabel: "Claude Code", tags: [] });

    expect(a1.hits.map((h) => h.seq)).toEqual([1, 2]);
    expect(a1.more).toBe(2);
    expect(a1.sessionHit).toEqual({ snippet: "snippet -1 needle", highlights: [[11, 17]] });
    expect(a1.session).toMatchObject({ title: "Fix the web build", cwd: "/home/u/Work/web", gitBranch: "main", tags: ["review", "ship"] });
    expect(a1.hits[0]).toMatchObject({ toolName: "Bash", isError: false, highlights: [[10, 16]] });
    expect(a1.hits[1]).toMatchObject({ kind: "tool_result", toolName: "Bash" });
  });

  it("lists every hit once the search is narrowed to one session", () => {
    const hits = [1, 2, 3, 4, 5, 6, 7].map((seq) => hit("omp:a1", seq));
    for (const q of ["needle in:omp:a1", "needle"]) {
      const [group] = search(db, new FakeIndex(hits), q, { perGroup: 2, now: NOW }).groups;
      expect(group.hits.map((h) => h.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(group.more).toBe(0);
    }
  });

  it("passes text and filters to the index", () => {
    const index = new FakeIndex();
    search(db, index, 'deploy -"dry run" kind:error source:omp tool:Bash after:7d sort:new', { now: NOW });
    expect(index.requests).toEqual([
      {
        must: [{ type: "term", text: "deploy" }],
        mustNot: [{ type: "phrase", text: "dry run" }],
        kinds: ["error"],
        sources: ["omp"],
        tools: ["bash"],
        sessionIds: undefined,
        from: NOW - 7 * DAY,
        to: undefined,
        sort: "newest",
        limit: 400,
      },
    ]);
  });

  it("lists only events when there is no text to match session documents", () => {
    const index = new FakeIndex();
    search(db, index, "source:codex", { sort: "relevance", now: NOW });
    expect(index.requests[0].kinds).toEqual([...EVENT_KINDS]);
    search(db, index, "word source:codex", { now: NOW });
    expect(index.requests[1].kinds).toBeUndefined();
  });

  it("resolves session facets in SQL and skips the index when nothing matches", () => {
    const index = new FakeIndex();
    const ids = (q: string) => {
      index.requests = [];
      search(db, index, q, { now: NOW });
      return index.requests[0]?.sessionIds;
    };
    expect(ids("x project:web")).toEqual(["omp:a1"]);
    expect(ids("x project:Work project:scratch")?.sort()).toEqual(["claude-code:b2", "codex:c3", "omp:a1"]);
    // `_` and `%` are literal, not LIKE wildcards.
    expect(ids("x project:scratch_dir")).toEqual(["codex:c3"]);
    expect(ids("x project:W_rk")).toBeUndefined();
    expect(ids("x project:%")).toBeUndefined();
    expect(ids("x model:sonnet")).toEqual(["claude-code:b2"]);
    expect(ids("x branch:feature")).toEqual(["claude-code:b2"]);
    expect(ids("x #review")).toEqual(["omp:a1"]);
    expect(ids("x tag:REVIEW model:opus")).toEqual(["omp:a1"]);
    expect(ids("x tag:review model:sonnet")).toBeUndefined();
    expect(ids("x in:codex:c3")).toEqual(["codex:c3"]);
    expect(ids("x in:b")).toEqual(["claude-code:b2"]);

    index.requests = [];
    const r = search(db, index, "x tag:nothing", { now: NOW });
    expect(r).toMatchObject({ groups: [], totalHits: 0 });
    expect(index.requests).toEqual([]);
  });

  it("does not search an empty query", () => {
    const index = new FakeIndex([hit("omp:a1", 1)]);
    expect(search(db, index, "   ", { now: NOW }).groups).toEqual([]);
    expect(search(db, index, "kind:", { now: NOW }).groups).toEqual([]);
    expect(index.requests).toEqual([]);
  });

  it("returns the events around a hit with tool previews and term-aware clipping", () => {
    const c = context(db, "omp:a1", 5, 2);
    expect(c?.events.map((e) => e.seq)).toEqual([3, 4, 5, 6, 7]);
    expect(c?.seq).toBe(5);
    expect(c?.events[1]).toMatchObject({ kind: "tool_call", toolName: "Bash", toolInput: "ls 4 · 5" });
    expect(c?.events[2]).toMatchObject({ kind: "tool_result", isError: true, toolInput: null });
    expect(c?.session.tags).toEqual(["review", "ship"]);

    // Session-level match: the session's opening events.
    expect(context(db, "omp:a1", -1, 2)?.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(context(db, "nope:1", 0)).toBeNull();

    const long = context(db, "codex:c3", 0, 4, ["needle"])?.events[0];
    expect(long?.clipped).toBe(true);
    expect(long?.text.length).toBeLessThanOrEqual(1502);
    expect(long?.text).toContain("needle");
    expect(context(db, "codex:c3", 0)?.events[0].text).not.toContain("needle");
  });

  it("lists facet values for autocomplete", () => {
    const f = facets(db);
    expect(f.tools).toEqual([{ name: "Bash", count: 3 }]);
    expect(f.tags.map((t) => t.name)).toEqual(["review", "ship"]);
    expect(f.projects.map((p) => p.cwd)).toEqual(["/home/u/Work/web", "/home/u/Work/api", "/tmp/scratch_dir"]);
    expect(f.models.map((m) => m.name).sort()).toEqual(["claude-opus-4", "claude-sonnet-4", "gpt-5"]);
    expect(f.branches.map((b) => b.name)).toEqual(["main", "feature/x"]);
    expect(f.sources.map((s) => s.label).sort()).toEqual(["Claude Code", "Codex", "omp"]);
  });
});
