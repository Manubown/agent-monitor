import { beforeEach, describe, expect, it } from "vitest";
import { classifyError, type ErrorCategory } from "../src/core/errors";
import { type Db, openDb } from "../src/store/db";
import { type ErrorEvent, errorEvents, errorTaxonomy, snippet, summarizeErrors } from "../src/store/insights";

const CASES: Record<ErrorCategory, string[]> = {
  interrupted: ["Interrupted by user", "[Request interrupted by user for tool use]", "The user doesn't want to proceed with this tool use. The tool use was rejected."],
  rate_limit: ["API Error: 429 Too Many Requests", '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "rate_limit_error: slow down"],
  edit_mismatch: [
    "String to replace not found in file.",
    "Edit rejected for src/a.ts: hash #F0F0 is not from this session.",
    "This edit anchors to lines 4 of src/a.ts that never displayed",
    "error: patch failed: src/a.ts:12",
    "Failed to find expected lines in src/a.ts",
  ],
  test_failure: [" FAIL  test/a.test.ts > adds numbers", "Test Files  1 failed (3)\n      Tests  2 failed | 10 passed", "test result: FAILED. 1 passed; 1 failed", "==== 1 failed, 3 passed in 0.21s ====", "AssertionError: expected 1 to be 2"],
  build_error: ["src/a.ts(2,5): error TS2322: Type 'string' is not assignable to type 'number'.", "error[E0308]: mismatched types", "SyntaxError: Unexpected token '}'", "Transform failed with 1 error"],
  timeout: ["Command timed out after 30000ms", "connect ETIMEDOUT 10.0.0.1:443", "TimeoutError: waiting for selector failed"],
  network: ["connect ECONNREFUSED 127.0.0.1:5432", "TypeError: fetch failed", "API Error: 502 Bad Gateway", "getaddrinfo ENOTFOUND api.example.com"],
  permission: ["EACCES: permission denied, open '/etc/shadow'", "sudo: a password is required", "Request failed with status code 403", "401 Unauthorized"],
  not_found: ["ENOENT: no such file or directory, open 'a.txt'", "bash: foo: command not found", "HTTP/1.1 404 Not Found", "Path '/tmp/x.webp' not found"],
  other: [
    "Command exited with code 1",
    "TypeError: x.filter is not a function",
    "lines 404 to 410 of a.ts changed",
    "Error at line 503",
    "",
    // A passing test summary in the output of a command that failed for another reason.
    "==== 0 failed, 12 passed in 0.50s ====\nCommand exited with code 1",
    "Tests  0 failed | 12 passed\nCommand exited with code 2",
  ],
};

describe("classifyError", () => {
  for (const [category, texts] of Object.entries(CASES)) {
    it.each(texts)(`${category}: %s`, (text) => {
      expect(classifyError(text, "bash")).toBe(category);
    });
  }

  it("treats missing text as other", () => {
    expect(classifyError(null)).toBe("other");
    expect(classifyError(undefined, null)).toBe("other");
  });

  it("applies precedence: the first category in rule order wins", () => {
    // A test runner's verdict beats the cause printed inside its output.
    expect(classifyError("Test failed: ENOENT: no such file or directory")).toBe("test_failure");
    // A compiler error beats the "cannot find" in its message.
    expect(classifyError("error TS2307: Cannot find module './x' or its corresponding type declarations.")).toBe("build_error");
    // The user stopping the agent beats whatever was running.
    expect(classifyError("Interrupted by user: command timed out")).toBe("interrupted");
    // A provider rate limit beats the connection it broke.
    expect(classifyError("overloaded_error after ECONNRESET")).toBe("rate_limit");
    // A stale edit beats the "not found" in its message.
    expect(classifyError("old_string not found in file")).toBe("edit_mismatch");
    // Timeouts are not network errors, even when the socket timed out.
    expect(classifyError("socket timed out: ECONNRESET")).toBe("timeout");
  });

  it("reads 'no match' as an edit mismatch only from edit tools", () => {
    expect(classifyError("No match found for the given text", "Edit")).toBe("edit_mismatch");
    expect(classifyError("Could not find the text in a.ts", "apply_patch")).toBe("edit_mismatch");
    expect(classifyError("No match found for the given text", "grep")).toBe("other");
    // A missing file stays a missing file, even from an edit tool.
    expect(classifyError("File not found: notes/x.md", "edit")).toBe("not_found");
  });
});

const ev = (over: Partial<ErrorEvent>): ErrorEvent => ({
  sessionId: "omp:a",
  title: "A",
  seq: 1,
  ts: 0,
  day: "2026-10-01",
  source: "omp",
  tool: "bash",
  kind: "tool_result",
  text: "",
  category: "other",
  ...over,
});

describe("summarizeErrors", () => {
  const events = [
    ev({ seq: 5, day: "2026-10-03", category: "not_found", text: "ENOENT   a\n\nb" }),
    ev({ seq: 4, day: "2026-10-03", category: "not_found", tool: "read", source: "codex", sessionId: "codex:b" }),
    ev({ seq: 3, day: "2026-10-01", category: "not_found" }),
    ev({ seq: 2, day: "2026-10-02", category: "interrupted", tool: null, kind: "error" }),
  ];

  it("counts by category, tool, source and day", () => {
    const t = summarizeErrors(events, 2);
    expect(t.total).toBe(4);
    expect(t.sessions).toBe(2);
    expect(t.byCategory.slice(0, 2)).toEqual([
      { category: "not_found", count: 3 },
      { category: "interrupted", count: 1 },
    ]);
    expect(t.byCategory.slice(2).every((c) => c.count === 0)).toBe(true);
    expect(t.byTool.map((r) => [r.key, r.total])).toEqual([
      ["bash", 2],
      ["read", 1],
      [null, 1],
    ]);
    expect(t.bySource.map((r) => [r.key, r.counts.not_found, r.counts.interrupted])).toEqual([
      ["omp", 2, 1],
      ["codex", 1, 0],
    ]);
    expect(t.byDay.map((d) => [d.key, d.total])).toEqual([
      ["2026-10-01", 1],
      ["2026-10-02", 1],
      ["2026-10-03", 2],
    ]);
  });

  it("keeps the newest examples per category with collapsed whitespace", () => {
    const t = summarizeErrors(events, 2);
    expect(t.examples.not_found.map((e) => e.seq)).toEqual([5, 4]);
    expect(t.examples.not_found[0].snippet).toBe("ENOENT a b");
    expect(t.examples.timeout).toEqual([]);
  });

  it("clips snippets", () => {
    expect(snippet("x".repeat(500), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

function insertSession(db: Db, id: string, opts: { toolErrors?: number; errors?: number; source?: string; parentId?: string } = {}): void {
  const [source, nativeId] = id.split(":");
  db.prepare(
    `INSERT INTO sessions (id, source, native_id, parent_id, file_path, title, cwd, git_branch, agent_version, models,
       started_at, ended_at, event_count, user_messages, tool_calls, tool_errors, errors, requests,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, cost_source, events_hash)
     VALUES (?, ?, ?, ?, ?, ?, '/work/proj', NULL, NULL, '[]', 0, ?, 0, 0, 0, ?, ?, 0, 0, 0, 0, 0, 0, NULL, 'none', '')`,
  ).run(id, opts.source ?? source, nativeId, opts.parentId ?? null, `/logs/${nativeId}.jsonl`, nativeId, T + 10 * H, opts.toolErrors ?? 0, opts.errors ?? 0);
}

function insertEvent(db: Db, sessionId: string, seq: number, ts: number, kind: string, text: string | null, isError = 0, tool: string | null = null): void {
  db.prepare("INSERT INTO events (session_id, seq, ts, kind, text, tool_name, is_error) VALUES (?, ?, ?, ?, ?, ?, ?)").run(sessionId, seq, ts, kind, text, tool, isError);
}

const T = Date.UTC(2026, 9, 1, 12);
const H = 3600_000;

describe("errorEvents", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
    insertSession(db, "omp:a", { toolErrors: 2, errors: 1 });
    insertEvent(db, "omp:a", 1, T - H, "tool_result", "ENOENT: old", 1, "read");
    insertEvent(db, "omp:a", 2, T + H, "tool_result", "permission denied", 1, "bash");
    insertEvent(db, "omp:a", 3, T + 2 * H, "tool_result", "fine", 0, "bash");
    insertEvent(db, "omp:a", 4, T + 3 * H, "error", "Interrupted by user", 1);
    insertEvent(db, "omp:a", 5, T + 4 * H, "tool_call", null, 0, "bash");
    insertSession(db, "codex:b", { toolErrors: 1 });
    insertEvent(db, "codex:b", 1, T + 5 * H, "tool_result", `${"x".repeat(5000)}\nTests  1 failed`, 1, "shell");
    insertSession(db, "omp:clean");
    insertEvent(db, "omp:clean", 1, T + H, "tool_result", "fine", 0, "bash");
  });

  it("reads failed tool results and error events, newest first, classified", () => {
    const rows = errorEvents(db, {});
    expect(rows.map((r) => [r.sessionId, r.seq, r.category])).toEqual([
      ["codex:b", 1, "test_failure"],
      ["omp:a", 4, "interrupted"],
      ["omp:a", 2, "permission"],
      ["omp:a", 1, "not_found"],
    ]);
    expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype);
  });

  it("clips long texts to head and tail, so a summary at the end still classifies", () => {
    const [long] = errorEvents(db, {});
    expect(long.text.length).toBeLessThan(1700);
    expect(long.text.endsWith("Tests  1 failed")).toBe(true);
  });

  it("respects the time and source filters", () => {
    expect(errorEvents(db, { from: T }).map((r) => r.seq)).toEqual([1, 4, 2]);
    expect(errorEvents(db, { source: "omp", from: T }).map((r) => [r.sessionId, r.seq])).toEqual([
      ["omp:a", 4],
      ["omp:a", 2],
    ]);
    expect(errorTaxonomy(db, { source: "codex" }).byCategory[0]).toEqual({ category: "test_failure", count: 1 });
  });
});
