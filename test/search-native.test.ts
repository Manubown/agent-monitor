import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Clause, type IndexDoc, type SearchRequest, openSearchIndex } from "../src/search/native";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-monitor-search-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;

function doc(sessionId: string, seq: number, text: string, extra: Partial<IndexDoc> = {}): IndexDoc {
  return { sessionId, seq, ts: T0 + seq * MIN, kind: "assistant", source: "omp", text, ...extra };
}

const DOCS: IndexDoc[] = [
  doc("omp:a", 0, "Refactor the Parser so tokens stream lazily", { kind: "user" }),
  doc("omp:a", 1, "The parsers module now exposes parseTokens()", { kind: "assistant" }),
  doc("omp:a", 2, "rg -n parser src/", { kind: "tool_call", tool: "Bash" }),
  doc("claude-code:b", 3, "Fix the bug in the lexer", { kind: "user", source: "claude-code" }),
  doc("claude-code:b", 4, "the bug fix touches the lexer and parser", { source: "claude-code" }),
  doc("claude-code:b", 5, "Über-long naïve café lookup", { kind: "thinking", source: "claude-code" }),
  doc("codex:c", 6, "cat Cargo.toml", { kind: "tool_call", source: "codex", tool: "shell" }),
];

function fresh(docs: IndexDoc[] = DOCS) {
  const index = openSearchIndex(tempDir());
  index.apply({ deleteSessions: [], add: docs, generation: 1 });
  return index;
}

function req(must: Clause[], extra: Partial<SearchRequest> = {}): SearchRequest {
  return { must, mustNot: [], sort: "newest", limit: 50, ...extra };
}

const term = (text: string): Clause => ({ type: "term", text });
const prefix = (text: string): Clause => ({ type: "prefix", text });
const phrase = (text: string): Clause => ({ type: "phrase", text });
const seqs = (hits: { seq: number }[]) => hits.map((h) => h.seq);

describe("text clauses", () => {
  const index = fresh();

  it("term matches whole tokens, case-insensitively", () => {
    expect(seqs(index.search(req([term("PARSER")])))).toEqual([4, 2, 0]);
  });

  it("prefix matches token prefixes", () => {
    expect(seqs(index.search(req([prefix("pars")])))).toEqual([4, 2, 1, 0]);
  });

  it("multi-token prefix keeps word order and expands the last token", () => {
    expect(seqs(index.search(req([prefix("lexer and pa")])))).toEqual([4]);
    expect(seqs(index.search(req([prefix("and lexer pa")])))).toEqual([]);
  });

  it("phrase requires adjacent tokens in order", () => {
    expect(seqs(index.search(req([phrase("the bug")])))).toEqual([4, 3]);
    expect(seqs(index.search(req([phrase("bug the")])))).toEqual([]);
  });

  it("term with several tokens behaves as a phrase", () => {
    expect(seqs(index.search(req([term("Cargo.toml")])))).toEqual([6]);
    expect(seqs(index.search(req([term("toml cargo")])))).toEqual([]);
  });

  it("folds diacritics", () => {
    expect(seqs(index.search(req([term("uber")])))).toEqual([5]);
    expect(seqs(index.search(req([term("cafe naive")])))).toEqual([]);
    expect(seqs(index.search(req([term("naive")])))).toEqual([5]);
  });

  it("ANDs must clauses and excludes mustNot", () => {
    expect(seqs(index.search(req([term("bug"), term("parser")])))).toEqual([4]);
    expect(seqs(index.search(req([prefix("pars")], { mustNot: [term("bug")] })))).toEqual([2, 1, 0]);
    expect(seqs(index.search(req([], { mustNot: [prefix("pars"), term("lexer")] })))).toEqual([6, 5]);
  });

  it("ignores clauses without tokens", () => {
    expect(index.search(req([term("!!!")])).length).toBe(DOCS.length);
  });

  it("ranks by relevance when asked", () => {
    const docs = [doc("s:1", 0, "alpha beta gamma"), doc("s:1", 1, "alpha alpha alpha"), doc("s:1", 2, "beta gamma delta")];
    const hits = fresh(docs).search(req([term("alpha")], { sort: "relevance" }));
    expect(seqs(hits)).toEqual([1, 0]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[1].score).toBeGreaterThan(0);
  });
});

describe("filters and sorting", () => {
  const index = fresh();

  it("filters by kind, source and tool (tools case-insensitive)", () => {
    expect(seqs(index.search(req([], { kinds: ["user", "thinking"] })))).toEqual([5, 3, 0]);
    expect(seqs(index.search(req([], { sources: ["codex"] })))).toEqual([6]);
    expect(seqs(index.search(req([], { tools: ["bash"] })))).toEqual([2]);
    expect(seqs(index.search(req([], { tools: ["BASH", "Shell"] })))).toEqual([6, 2]);
    expect(seqs(index.search(req([prefix("pars")], { kinds: ["assistant"], sources: ["omp"] })))).toEqual([1]);
  });

  it("restricts to session ids; an empty list matches nothing", () => {
    expect(seqs(index.search(req([term("the")], { sessionIds: ["claude-code:b"] })))).toEqual([4, 3]);
    expect(index.search(req([], { sessionIds: [] }))).toEqual([]);
  });

  it("filters by time with inclusive from and exclusive to", () => {
    expect(seqs(index.search(req([], { from: T0 + 2 * MIN, to: T0 + 5 * MIN })))).toEqual([4, 3, 2]);
    expect(seqs(index.search(req([], { from: T0 + 5 * MIN })))).toEqual([6, 5]);
    expect(seqs(index.search(req([], { to: T0 + MIN })))).toEqual([0]);
  });

  it("filter-only queries are newest first with the text start as snippet", () => {
    const hits = index.search(req([], { sort: "relevance", limit: 3 }));
    expect(seqs(hits)).toEqual([6, 5, 4]);
    expect(hits[0]).toMatchObject({ sessionId: "codex:c", kind: "tool_call", ts: T0 + 6 * MIN, snippet: "cat Cargo.toml", highlights: [] });
  });

  it("truncates filter-only snippets on character boundaries", () => {
    const text = "🎉".repeat(300);
    const [hit] = fresh([doc("s:1", 0, text)]).search(req([]));
    expect(hit.snippet).toBe("🎉".repeat(180));
  });
});

describe("highlights", () => {
  it("returns UTF-16 offsets into the snippet", () => {
    const text = "Grüße 🎉🎉 aus Köln: the Parser module 👍 works";
    const index = fresh([doc("s:1", 0, text)]);
    for (const clause of [term("parser"), prefix("pars"), phrase("parser module")]) {
      const [hit] = index.search(req([clause]));
      expect(hit.highlights.length).toBeGreaterThan(0);
      const marked = hit.highlights.map(([a, b]) => hit.snippet.slice(a, b));
      expect(marked[0]).toBe("Parser");
    }
    const [hit] = index.search(req([term("works")]));
    expect(hit.highlights.map(([a, b]) => hit.snippet.slice(a, b))).toEqual(["works"]);
  });
});

describe("updates", () => {
  it("deletes sessions and resets", () => {
    const index = fresh();
    expect(index.docCount()).toBe(DOCS.length);

    index.apply({ deleteSessions: ["omp:a"], add: [doc("omp:a", 9, "parser rewritten")], generation: 2 });
    expect(index.docCount()).toBe(DOCS.length - 2);
    expect(seqs(index.search(req([term("parser")], { sessionIds: ["omp:a"] })))).toEqual([9]);

    index.apply({ reset: true, deleteSessions: [], add: [doc("x:1", 0, "only doc")], generation: 3 });
    expect(index.docCount()).toBe(1);
    expect(seqs(index.search(req([term("parser")])))).toEqual([]);
  });

  it("persists the generation across reopen", () => {
    const dir = tempDir();
    const index = openSearchIndex(dir);
    expect(index.generation()).toBeNull();
    index.apply({ deleteSessions: [], add: DOCS, generation: 42 });
    expect(index.generation()).toBe(42);

    const reopened = openSearchIndex(dir);
    expect(reopened.generation()).toBe(42);
    expect(reopened.docCount()).toBe(DOCS.length);
    reopened.apply({ deleteSessions: ["codex:c"], add: [], generation: 43 });
    expect(openSearchIndex(dir).generation()).toBe(43);
    expect(openSearchIndex(dir).docCount()).toBe(DOCS.length - 1);
  });

  it("sees commits made through another handle, as from the CLI's sync", () => {
    const dir = tempDir();
    const server = openSearchIndex(dir);
    server.apply({ deleteSessions: [], add: DOCS, generation: 1 });
    expect(seqs(server.search(req([term("cargo")])))).toEqual([6]);

    const cli = openSearchIndex(dir);
    cli.apply({ deleteSessions: ["codex:c"], add: [doc("omp:z", 9, "cargo build --release")], generation: 2 });
    expect(seqs(server.search(req([term("cargo")])))).toEqual([9]);
    expect(server.docCount()).toBe(DOCS.length);
  });
});
