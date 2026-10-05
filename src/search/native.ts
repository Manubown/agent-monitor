import fs from "node:fs";
import path from "node:path";

/**
 * Thin wrapper over the Rust/tantivy search addon (native/search). The addon is
 * loaded with `process.dlopen` so bundlers never try to follow it.
 */

export interface IndexDoc { sessionId: string; seq: number; ts: number; kind: string; source: string; tool?: string; text: string }
// kind "session" with seq -1 = one doc per session holding title + cwd + branch (session-level matches)
export interface Clause { type: "term" | "prefix" | "phrase"; text: string } // Rust tokenizes `text` with the index tokenizer
export interface SearchRequest {
  must: Clause[]; mustNot: Clause[];
  kinds?: string[]; sources?: string[]; tools?: string[]; // exact; tools compared lowercase; [] = no restriction
  sessionIds?: string[];         // restrict to these sessions (resolved in SQL for project/model/branch/tag facets); [] = no hits
  from?: number; to?: number;    // epoch ms, inclusive from, exclusive to
  sort: "relevance" | "newest";  // no must clauses => always newest
  limit: number;
}
export interface SearchHit { sessionId: string; seq: number; ts: number; kind: string; score: number;
  snippet: string; highlights: [number, number][] } // highlight ranges are UTF-16 offsets into snippet
export interface SearchIndex {
  generation(): number | null;   // payload of the last commit; null for a fresh index
  apply(batch: { reset?: boolean; deleteSessions: string[]; add: IndexDoc[]; generation: number }): void; // one commit; throws Error with message starting "LOCKED" if another writer holds the lock
  search(req: SearchRequest): SearchHit[];
  docCount(): number;
}

interface NativeIndex {
  generation(): number | null | undefined;
  apply(batch: { reset?: boolean; deleteSessions: string[]; add: IndexDoc[]; generation: number }): void;
  search(req: SearchRequest): SearchHit[];
  docCount(): number;
}

interface NativeModule {
  SearchIndex: new (dir: string) => NativeIndex;
}

let addon: NativeModule | undefined;

function loadAddon(): NativeModule {
  if (addon) return addon;
  // turbopackIgnore: the path is resolved at runtime; tracing it would pull the whole project into the build output.
  const file = process.env.AGENT_MONITOR_NATIVE || path.resolve(/* turbopackIgnore: true */ process.cwd(), "native/agent_monitor_search.node");
  if (!fs.existsSync(file)) throw new Error("search addon not built: run `pnpm build:native`");
  const mod = { exports: {} as NativeModule };
  process.dlopen(mod, file);
  addon = mod.exports;
  return addon;
}

export function openSearchIndex(dir: string): SearchIndex {
  const index = new (loadAddon().SearchIndex)(dir);
  return {
    generation: () => index.generation() ?? null,
    apply: (batch) => index.apply(batch),
    search: (req) => index.search(req),
    docCount: () => index.docCount(),
  };
}
