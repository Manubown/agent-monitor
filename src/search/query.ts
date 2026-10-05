import type { Clause } from "./native";

/**
 * Search query language shared by the server (parsing) and the palette (token
 * highlighting, autocomplete, cheat sheet). Pure and dependency-free so it can
 * run in the browser.
 *
 *   bare words          all must match; the trailing word matches as a prefix while typing
 *   "a phrase"          exact phrase
 *   -word, -"a phrase"  exclude
 *   kind:reply tool:Bash source:codex project:web model:opus branch:main
 *   tag:review #review  after:2026-10-01 before:today after:7d in:<session id> sort:new
 *
 * Repeated operators of the same key OR together. `foo:bar` with an unknown
 * key stays a literal term.
 */

export type Sort = "relevance" | "newest";

export interface QueryToken {
  /** UTF-16 offsets into the query string. */
  start: number;
  end: number;
  type: "term" | "phrase" | "operator" | "tag";
  negated: boolean;
  /** Operator key, lowercase (operators only). */
  key?: string;
  /** Word, phrase content, operator value or tag name (without quotes, `-`, `#` or `key:`). */
  value: string;
  /** Set when the token is not applied: invalid value, unsupported negation. */
  error?: string;
}

export interface ParsedQuery {
  must: Clause[];
  mustNot: Clause[];
  kinds: string[];
  sources: string[];
  /** Lowercase tool names. */
  tools: string[];
  /** Substrings of the working directory. */
  projects: string[];
  /** Substrings of a model name. */
  models: string[];
  /** Substrings of the git branch. */
  branches: string[];
  /** Lowercase tag names. */
  tags: string[];
  /** `in:` values: a session id, or a native id or its prefix. */
  sessionIds: string[];
  /** Epoch ms, inclusive. */
  from?: number;
  /** Epoch ms, exclusive. */
  to?: number;
  /** Only set when the query says `sort:`; callers fall back to their default. */
  sort?: Sort;
  tokens: QueryToken[];
}

export const EVENT_KINDS = ["user", "assistant", "thinking", "tool_call", "tool_result", "system", "error"] as const;

const KIND_ALIASES: Record<string, string[]> = {
  user: ["user"],
  prompt: ["user"],
  prompts: ["user"],
  assistant: ["assistant"],
  reply: ["assistant"],
  replies: ["assistant"],
  thinking: ["thinking"],
  tool: ["tool_call", "tool_result"],
  tools: ["tool_call", "tool_result"],
  call: ["tool_call"],
  calls: ["tool_call"],
  tool_call: ["tool_call"],
  result: ["tool_result"],
  results: ["tool_result"],
  tool_result: ["tool_result"],
  system: ["system"],
  error: ["error"],
  errors: ["error"],
};

/** Session sources (adapter ids). Kept here rather than imported from the adapters so the browser can use it. */
const SOURCE_ALIASES: Record<string, string> = {
  omp: "omp",
  claude: "claude-code",
  "claude-code": "claude-code",
  claudecode: "claude-code",
  cc: "claude-code",
  codex: "codex",
};
export const SOURCES = ["omp", "claude-code", "codex"] as const;

export interface OperatorSpec {
  key: string;
  /** Example shown in the cheat sheet. */
  example: string;
  description: string;
  /** Fixed values for autocomplete. */
  values?: { value: string; description: string }[];
  /** Dynamic values for autocomplete, from the facets endpoint. */
  facet?: "tools" | "tags" | "projects" | "models" | "branches";
  /** Whether `-key:value` is supported. */
  negatable?: boolean;
}

export const OPERATORS: OperatorSpec[] = [
  {
    key: "kind",
    example: "kind:reply",
    description: "Event type",
    negatable: true,
    values: [
      { value: "prompt", description: "Your messages" },
      { value: "reply", description: "Assistant replies" },
      { value: "thinking", description: "Reasoning" },
      { value: "tool", description: "Tool calls and results" },
      { value: "call", description: "Tool calls" },
      { value: "result", description: "Tool results" },
      { value: "system", description: "System messages" },
      { value: "error", description: "Errors" },
    ],
  },
  { key: "tool", example: "tool:Bash", description: "Tool name", facet: "tools" },
  {
    key: "source",
    example: "source:claude",
    description: "Agent",
    negatable: true,
    values: [
      { value: "omp", description: "omp" },
      { value: "claude", description: "Claude Code" },
      { value: "codex", description: "Codex" },
    ],
  },
  { key: "project", example: "project:web", description: "Working directory contains", facet: "projects" },
  { key: "model", example: "model:opus", description: "Model name contains", facet: "models" },
  { key: "branch", example: "branch:main", description: "Git branch contains", facet: "branches" },
  { key: "tag", example: "tag:review", description: "Tagged sessions (also #review)", facet: "tags" },
  {
    key: "after",
    example: "after:7d",
    description: "On or after a date (local time)",
    values: [
      { value: "today", description: "Since midnight" },
      { value: "yesterday", description: "Since yesterday's midnight" },
      { value: "24h", description: "Last 24 hours" },
      { value: "7d", description: "Last 7 days" },
      { value: "2w", description: "Last 2 weeks" },
    ],
  },
  {
    key: "before",
    example: "before:2026-10-01",
    description: "Before a date (exclusive, local time)",
    values: [
      { value: "today", description: "Before today" },
      { value: "yesterday", description: "Before yesterday" },
      { value: "7d", description: "Older than 7 days" },
    ],
  },
  { key: "in", example: "in:<session id>", description: "Within one session" },
  {
    key: "sort",
    example: "sort:new",
    description: "Result order",
    values: [
      { value: "new", description: "Newest first" },
      { value: "relevance", description: "Best match first" },
    ],
  },
];

/** Plain syntax for the cheat sheet. */
export const SYNTAX: { example: string; description: string }[] = [
  { example: "word other", description: "All words must match" },
  { example: '"exact phrase"', description: "Phrase" },
  { example: "-word", description: "Exclude a word or phrase" },
  { example: "#tag", description: "Tagged sessions" },
];

const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

/** Split a query into tokens with their source offsets. Never throws. */
export function tokenize(q: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  const n = q.length;
  let i = 0;
  while (i < n) {
    if (isSpace(q[i])) {
      i++;
      continue;
    }
    const start = i;
    // `-` negates only before a word, quote or tag; `--force` stays a literal term.
    const negated = q[i] === "-" && i + 1 < n && /[\p{L}\p{N}"#]/u.test(q[i + 1]);
    if (negated) i++;

    if (q[i] === '"') {
      const close = q.indexOf('"', i + 1);
      const end = close === -1 ? n : close + 1;
      tokens.push({ start, end, type: "phrase", negated, value: q.slice(i + 1, close === -1 ? n : close) });
      i = end;
      continue;
    }

    const op = /^([A-Za-z]+):/.exec(q.slice(i, i + 16));
    const key = op?.[1].toLowerCase();
    if (op && key && OPERATORS.some((o) => o.key === key)) {
      const valueStart = i + op[0].length;
      let end: number;
      let value: string;
      if (q[valueStart] === '"') {
        const close = q.indexOf('"', valueStart + 1);
        end = close === -1 ? n : close + 1;
        value = q.slice(valueStart + 1, close === -1 ? n : close);
      } else {
        end = valueStart;
        while (end < n && !isSpace(q[end])) end++;
        value = q.slice(valueStart, end);
      }
      tokens.push({ start, end, type: "operator", negated, key, value });
      i = end;
      continue;
    }

    let end = i;
    while (end < n && !isSpace(q[end])) end++;
    const word = q.slice(i, end);
    if (word.length > 1 && word[0] === "#") tokens.push({ start, end, type: "tag", negated, value: word.slice(1) });
    else tokens.push({ start, end, type: "term", negated, value: word });
    i = end;
  }
  return tokens;
}

const DAY = 86_400_000;
const UNIT_MS: Record<string, number> = { h: 3_600_000, d: DAY, w: 7 * DAY };

/** Local midnight of the day `offsetDays` away from `ts` (DST-safe). */
function startOfDay(ts: number, offsetDays = 0): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays).getTime();
}

/** `today`, `yesterday`, `24h`/`7d`/`2w` (relative to now) or `YYYY-MM-DD` (local midnight). */
export function parseDate(value: string, now = Date.now()): number | undefined {
  const v = value.trim().toLowerCase();
  if (v === "today") return startOfDay(now);
  if (v === "yesterday") return startOfDay(now, -1);
  const rel = /^(\d+)([hdw])$/.exec(v);
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2]];
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (day) {
    const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
    const date = new Date(y, m - 1, d);
    if (date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d) return date.getTime();
  }
  return undefined;
}

const push = (list: string[], value: string) => {
  if (!list.includes(value)) list.push(value);
};

export interface ParseOptions {
  /** Reference time for relative dates. */
  now?: number;
  /** The query is final (not being typed): no prefix matching on the trailing word. */
  complete?: boolean;
}

export function parseQuery(q: string, { now = Date.now(), complete = false }: ParseOptions = {}): ParsedQuery {
  const tokens = tokenize(q);
  const out: ParsedQuery = {
    must: [],
    mustNot: [],
    kinds: [],
    sources: [],
    tools: [],
    projects: [],
    models: [],
    branches: [],
    tags: [],
    sessionIds: [],
    tokens,
  };
  const notKinds: string[] = [];
  const notSources: string[] = [];
  const froms: number[] = [];
  const tos: number[] = [];
  const last = tokens.at(-1);

  for (const t of tokens) {
    if (t.type === "term" || t.type === "phrase") {
      // Punctuation-only words tokenize to nothing in the index.
      if (!/[\p{L}\p{N}]/u.test(t.value)) continue;
      const trailing = !complete && t === last && t.type === "term" && !t.negated && t.end === q.length;
      const clause: Clause = { type: t.type === "phrase" ? "phrase" : trailing ? "prefix" : "term", text: t.value };
      (t.negated ? out.mustNot : out.must).push(clause);
      continue;
    }
    if (t.type === "tag") {
      if (t.negated) t.error = "Excluding tags is not supported";
      else push(out.tags, t.value.toLowerCase());
      continue;
    }

    const key = t.key as string;
    const value = t.value.trim();
    // An operator without a value is still being typed: ignore it quietly.
    if (!value) continue;
    if (t.negated && !OPERATORS.find((o) => o.key === key)?.negatable) {
      t.error = `Excluding ${key}: is not supported`;
      continue;
    }
    const lower = value.toLowerCase();
    switch (key) {
      case "kind": {
        const kinds = KIND_ALIASES[lower];
        if (!kinds) t.error = `Unknown kind "${value}"`;
        else for (const k of kinds) push(t.negated ? notKinds : out.kinds, k);
        break;
      }
      case "source": {
        const source = SOURCE_ALIASES[lower];
        if (!source) t.error = `Unknown source "${value}"`;
        else push(t.negated ? notSources : out.sources, source);
        break;
      }
      case "tool":
        push(out.tools, lower);
        break;
      case "project":
        push(out.projects, value);
        break;
      case "model":
        push(out.models, value);
        break;
      case "branch":
        push(out.branches, value);
        break;
      case "tag":
        push(out.tags, lower.replace(/^#/, ""));
        break;
      case "in":
        push(out.sessionIds, value);
        break;
      case "after":
      case "before": {
        const ts = parseDate(value, now);
        if (ts === undefined) t.error = `Unknown date "${value}" (use YYYY-MM-DD, today, yesterday, 24h, 7d, 2w)`;
        else (key === "after" ? froms : tos).push(ts);
        break;
      }
      case "sort":
        if (lower === "new" || lower === "newest" || lower === "recent") out.sort = "newest";
        else if (lower === "relevance" || lower === "best") out.sort = "relevance";
        else t.error = `Unknown sort "${value}" (new or relevance)`;
        break;
    }
  }

  // Exclusions become the complement within what is already allowed.
  if (notKinds.length) out.kinds = (out.kinds.length ? out.kinds : [...EVENT_KINDS]).filter((k) => !notKinds.includes(k));
  if (notSources.length) out.sources = (out.sources.length ? out.sources : [...SOURCES]).filter((s) => !notSources.includes(s));
  // Repeated date bounds OR together: the widest range wins.
  if (froms.length) out.from = Math.min(...froms);
  if (tos.length) out.to = Math.max(...tos);
  return out;
}

/** Session-level facets that must be resolved in SQL before searching the index. */
export const hasSessionFacets = (p: ParsedQuery): boolean =>
  p.projects.length + p.models.length + p.branches.length + p.tags.length + p.sessionIds.length > 0;

/** Nothing to search for: no text and no filters. */
export const isEmptyQuery = (p: ParsedQuery): boolean =>
  !p.must.length &&
  !p.mustNot.length &&
  !p.kinds.length &&
  !p.sources.length &&
  !p.tools.length &&
  !hasSessionFacets(p) &&
  p.from === undefined &&
  p.to === undefined;

/** The token under the caret (caret at its end included), for autocomplete. */
export function tokenAt(tokens: QueryToken[], caret: number): QueryToken | undefined {
  return tokens.find((t) => caret > t.start && caret <= t.end);
}

/** Quote a value for insertion into a query when it contains spaces or quotes. */
export const quoteValue = (value: string): string => (/[\s"]/.test(value) ? `"${value.replace(/"/g, "")}"` : value);
