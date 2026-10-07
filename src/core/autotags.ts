import path from "node:path";
import { fileOps, isWrite } from "./activity";
import { LoopScan, loopReason } from "./loops";
import { isShellTool, shellCommand } from "./shell";
import type { AgentEvent } from "./types";

/**
 * Automatic tags: what a session did, derived locally and deterministically
 * from its events. Every tag comes from one rule below and carries a reason
 * naming the evidence ("changed 12 TypeScript files"). No model calls.
 */

export interface AutoTag {
  tag: string;
  /** Why the rule fired for this session; shown as the chip's tooltip. */
  reason: string;
}

export interface AutoTagInput {
  /** In timeline order; `toolCallId` pairs results with their calls for loop detection. */
  events: readonly Pick<AgentEvent, "ts" | "kind" | "toolName" | "toolCallId" | "toolInput" | "text" | "isError">[];
  /** Resolves relative file paths in tool arguments. */
  cwd?: string | null;
  gitBranch?: string | null;
}

/** A language tag needs this many changed files, or this share of all changed files. */
export const LANGUAGE_MIN_FILES = 3;
export const LANGUAGE_MIN_SHARE = 0.25;
/** `errors`: at least this many failed tool calls making up at least this share of tool results. */
export const ERROR_MIN_FAILURES = 3;
export const ERROR_MIN_RATE = 0.2;
/**
 * `long`: more than this much activity. A pause longer than IDLE_GAP_MS is idle (waiting for the user, a resumed
 * session) unless it ends with a tool result: then a tool or subagent was running.
 */
export const LONG_ACTIVE_MS = 60 * 60_000;
export const IDLE_GAP_MS = 10 * 60_000;
/** `research`: at least this many reads, searches and fetches with no file changed. */
export const RESEARCH_MIN_LOOKUPS = 10;
/** `refactor`: at least this many files moved or renamed. */
export const REFACTOR_MIN_MOVES = 3;

/** Language/format tags by file extension, with the name used in reasons. */
const LANGUAGES: { tag: string; label: string; ext: string[] }[] = [
  { tag: "typescript", label: "TypeScript", ext: [".ts", ".tsx", ".mts", ".cts"] },
  { tag: "javascript", label: "JavaScript", ext: [".js", ".jsx", ".mjs", ".cjs"] },
  { tag: "rust", label: "Rust", ext: [".rs"] },
  { tag: "python", label: "Python", ext: [".py", ".pyi", ".ipynb"] },
  { tag: "go", label: "Go", ext: [".go"] },
  { tag: "java", label: "Java/Kotlin", ext: [".java", ".kt", ".kts"] },
  { tag: "c", label: "C/C++", ext: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"] },
  { tag: "swift", label: "Swift", ext: [".swift"] },
  { tag: "ruby", label: "Ruby", ext: [".rb"] },
  { tag: "shell", label: "shell", ext: [".sh", ".bash", ".zsh", ".fish"] },
  { tag: "sql", label: "SQL", ext: [".sql"] },
  { tag: "css", label: "CSS", ext: [".css", ".scss", ".sass", ".less"] },
  { tag: "html", label: "HTML", ext: [".html", ".htm"] },
  { tag: "docs", label: "Markdown/docs", ext: [".md", ".mdx", ".rst", ".adoc"] },
  { tag: "config", label: "config (JSON/YAML/TOML)", ext: [".json", ".jsonc", ".json5", ".yaml", ".yml", ".toml", ".ini", ".conf"] },
];

const LANGUAGE_BY_EXT = new Map(LANGUAGES.flatMap((l) => l.ext.map((e) => [e, l] as const)));

const SEARCH_TOOLS = new Set(["grep", "glob", "find", "search", "ast_grep", "codebase_search", "file_search", "ls", "list_dir"]);
const WEB_TOOLS = new Set(["web_search", "websearch", "web_fetch", "webfetch", "fetch", "search_web", "browser", "browse"]);
const SUBAGENT_TOOLS = new Set(["task", "agent", "spawn_agent"]);
/** Shell commands that only look at files; Codex reads and searches this way. */
const READ_COMMANDS = new Set(["cat", "rg", "grep", "ls", "find", "fd", "head", "tail", "nl", "tree", "less", "wc", "bat"]);
/** API errors that are really the user stopping the agent. */
const INTERRUPTED = /interrupt|abort|cancel/i;

const parseArgs = (input: string | undefined): Record<string, unknown> | undefined => {
  if (!input) return undefined;
  try {
    const v: unknown = JSON.parse(input);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** Wrappers in front of the real command: `sudo`, `env A=1`, `npx`, `pnpm exec`, `uv run`, `python -m`, `timeout 60`. */
const PREFIXES = new Set(["sudo", "env", "time", "nice", "nohup", "command", "exec"]);
/** Flags that take a value, so the value is not mistaken for a subcommand (`git -C dir commit`, `pnpm --filter x test`). */
const VALUE_FLAGS = new Set(["-C", "-c", "--dir", "--cwd", "--prefix", "--filter", "-F", "--workspace", "-w", "--git-dir", "--work-tree", "--manifest-path"]);

const base = (word: string): string => word.slice(word.lastIndexOf("/") + 1);

/** Simple commands of a shell script, each as words with wrappers removed and the program name reduced to its basename. */
function commands(script: string): string[][] {
  const out: string[][] = [];
  for (const segment of script.split(/\r?\n|&&|\|\||[;|&()`]/)) {
    const w = segment
      .trim()
      .split(/\s+/)
      .map((x) => x.replace(/^['"]+|['"]+$/g, ""))
      .filter(Boolean);
    let i = 0;
    while (i < w.length) {
      const h = base(w[i]);
      if (/^[A-Za-z_]\w*=/.test(w[i]) || PREFIXES.has(h)) i++;
      else if (h === "timeout") i += 2;
      else if (h === "npx" || h === "bunx" || h === "pnpx") {
        i++;
        while (w[i]?.startsWith("-")) i++;
      } else if (["pnpm", "npm", "yarn", "bun"].includes(h) && ["exec", "dlx", "x"].includes(w[i + 1])) i += 2;
      else if (["uv", "poetry", "pipenv", "rye"].includes(h) && w[i + 1] === "run") i += 2;
      else if (/^python[\d.]*$/.test(h) && w[i + 1] === "-m") i += 2;
      else break;
    }
    if (i < w.length) out.push([base(w[i]), ...w.slice(i + 1)]);
  }
  return out;
}

/** Positional arguments after the program name, skipping flags and the values of VALUE_FLAGS. */
function positionals(w: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < w.length; i++) {
    if (VALUE_FLAGS.has(w[i])) i++;
    else if (!w[i].startsWith("-")) out.push(w[i]);
  }
  return out;
}

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const TEST_PROGRAMS = new Set(["vitest", "jest", "pytest", "py.test", "mocha", "ava", "rspec", "phpunit", "ctest", "tox", "nox", "unittest", "karma"]);

/** A package.json script run through a package manager: `pnpm test`, `npm run build:native`. */
const script = (h: string, p: string[]): string | undefined => (PACKAGE_MANAGERS.has(h) ? (p[0] === "run" ? p[1] : p[0]) : undefined);

/** Test runner invocation, as a short label ("vitest", "cargo test", "pnpm test"), or undefined. */
function testRun(w: string[]): string | undefined {
  const [h] = w;
  const p = positionals(w);
  if (TEST_PROGRAMS.has(h)) return h;
  if (h === "playwright" && p[0] === "test") return "playwright test";
  if (h === "cypress" && p[0] === "run") return "cypress run";
  const s = script(h, p);
  if (s !== undefined) {
    if (s === "test" || s.startsWith("test:")) return `${h} ${s}`;
    // `pnpm vitest`: without `run`, package managers also start installed binaries. The positional comes after the
    // program name, so searching from 1 always shortens `w` (`pnpm pnpm i` must not recurse on itself).
    return p[0] === "run" ? undefined : testRun(w.slice(w.indexOf(s, 1)));
  }
  if (h === "cargo" && (p[0] === "test" || p[0] === "nextest")) return `cargo ${p[0]}`;
  if (["go", "deno", "dotnet", "mix", "swift", "zig"].includes(h) && p[0] === "test") return `${h} test`;
  if ((h === "make" || h === "just") && (p[0] === "test" || p[0] === "check")) return `${h} ${p[0]}`;
  if ((h === "gradle" || h === "gradlew" || h === "mvn") && p.includes("test")) return `${h} test`;
  return undefined;
}

/** Build invocation ("cargo build", "pnpm build", "tsc"), or undefined. Type checks (`tsc --noEmit`) are not builds. */
function buildRun(w: string[]): string | undefined {
  const [h] = w;
  const p = positionals(w);
  const s = script(h, p);
  if (s !== undefined) {
    if (s === "build" || s.startsWith("build:")) return `${h} ${s}`;
    return p[0] === "run" ? undefined : buildRun(w.slice(w.indexOf(s, 1)));
  }
  if (h === "tsc") return w.some((x) => x.toLowerCase() === "--noemit") ? undefined : "tsc";
  if (["cargo", "go", "dotnet", "swift", "zig", "next", "vite", "astro", "napi"].includes(h) && p[0] === "build") return `${h} build`;
  if (h === "docker" && (p[0] === "build" || (["compose", "buildx"].includes(p[0]) && p[1] === "build"))) return "docker build";
  if (h === "make" && (p.length === 0 || ["build", "all", "release"].includes(p[0]))) return "make";
  if (h === "cmake" && w.includes("--build")) return "cmake --build";
  if ((h === "gradle" || h === "gradlew") && (p[0] === "build" || p[0] === "assemble")) return `${h} ${p[0]}`;
  if (h === "mvn" && ["package", "compile", "install"].includes(p[0])) return `mvn ${p[0]}`;
  return undefined;
}

/** Dependency change ("pnpm add", "cargo add", "pip install"), or undefined. A bare `npm install` restores a lockfile and does not count. */
function depsRun(w: string[]): string | undefined {
  const [h] = w;
  const p = positionals(w);
  if ((h === "pnpm" || h === "yarn" || h === "bun") && ["add", "remove", "rm"].includes(p[0])) return `${h} ${p[0]}`;
  if (h === "npm" && ["install", "i", "add", "uninstall", "remove", "rm"].includes(p[0]) && p.length >= 2) return `npm ${p[0]}`;
  if ((h === "cargo" || h === "poetry" || h === "uv") && (p[0] === "add" || p[0] === "remove")) return `${h} ${p[0]}`;
  if (/^pip3?$/.test(h) && (p[0] === "install" || p[0] === "uninstall") && w.length > 2) return `pip ${p[0]}`;
  if (h === "uv" && p[0] === "pip" && p[1] === "install") return "uv pip install";
  if (h === "go" && p[0] === "get") return "go get";
  if (h === "gem" && p[0] === "install") return "gem install";
  if (h === "bundle" && p[0] === "add") return "bundle add";
  if (h === "composer" && p[0] === "require") return "composer require";
  return undefined;
}

const GIT_CHANGES = new Set(["commit", "push", "pull", "merge", "rebase", "cherry-pick", "revert", "switch", "checkout", "reset"]);

/** Git operation that changes history, branches or the remote ("git commit", "gh pr create"), or undefined. Status/diff/log do not count. */
function gitRun(w: string[]): string | undefined {
  const [h] = w;
  const p = positionals(w);
  if (h === "gh" && p[0] === "pr" && (p[1] === "create" || p[1] === "merge")) return `gh pr ${p[1]}`;
  if (h !== "git") return undefined;
  const sub = p[0];
  if (GIT_CHANGES.has(sub)) return `git ${sub}`;
  // `git branch`/`git tag` only change something with a name (or -d/-D/-m): `git branch -a` just lists.
  if ((sub === "branch" || sub === "tag") && (p.length >= 2 || w.some((x) => /^-[dDmM]$|^--(delete|move)$/.test(x)))) return `git ${sub}`;
  if (sub === "stash" && !["list", "show"].includes(p[1])) return "git stash";
  if (sub === "worktree" && p[1] === "add") return "git worktree add";
  return undefined;
}

/** Counter of labels, rendered as "a ×2, b". */
class Tally {
  readonly counts = new Map<string, number>();
  total = 0;
  add(label: string): void {
    this.counts.set(label, (this.counts.get(label) ?? 0) + 1);
    this.total++;
  }
  toString(): string {
    return [...this.counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([label, n]) => (n > 1 ? `${label} ×${n}` : label))
      .join(", ");
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const hoursMinutes = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

/**
 * Running state of one session's automatic tags, so a growing log only pays for its new events: events are added in
 * timeline order and never taken back, and `tags()` may be called after any number of them. The working directory
 * and branch are fixed, since they resolve relative paths and feed the `refactor` rule: a session whose own change
 * needs a new scan.
 */
export class AutoTagScan {
  private readonly cwd?: string;
  private readonly gitBranch?: string | null;
  private readonly changed = new Set<string>();
  private readonly tests = new Tally();
  private readonly builds = new Tally();
  private readonly deps = new Tally();
  private readonly git = new Tally();
  private readonly loops: LoopScan;
  private moves = 0;
  private lookups = 0;
  private web = 0;
  private subagents = 0;
  private toolResults = 0;
  private failures = 0;
  private apiErrors = 0;
  private active = 0;
  private lastTs: number | undefined;

  constructor(input: Omit<AutoTagInput, "events">) {
    this.cwd = input.cwd ?? undefined;
    this.gitBranch = input.gitBranch;
    this.loops = new LoopScan(input.cwd);
  }

  /** Add the events from `from` on. */
  add(events: AutoTagInput["events"], from = 0): this {
    for (let i = from; i < events.length; i++) {
      const e = events[i];
      if (this.lastTs !== undefined) {
        const gap = e.ts - this.lastTs;
        if (gap > 0 && (gap <= IDLE_GAP_MS || e.kind === "tool_result")) this.active += gap;
      }
      this.lastTs = this.lastTs === undefined ? e.ts : Math.max(this.lastTs, e.ts);

      if (e.kind === "error") {
        if (!INTERRUPTED.test(e.text ?? "")) this.apiErrors++;
        continue;
      }
      if (e.kind === "tool_result") {
        this.toolResults++;
        if (e.isError) this.failures++;
        continue;
      }
      if (e.kind !== "tool_call") continue;

      const name = (e.toolName ?? "").toLowerCase();
      const args = parseArgs(e.toolInput);
      const ops = fileOps(e.toolName, e.toolInput, this.cwd);
      for (const op of ops) {
        if (isWrite(op.op)) {
          this.changed.add(op.to ?? op.path);
          if (op.op === "move") this.moves++;
        } else this.lookups++;
      }
      if (SEARCH_TOOLS.has(name) && !ops.length) this.lookups++;
      const target = args?.path ?? args?.url;
      if (WEB_TOOLS.has(name) || (name === "read" && typeof target === "string" && /^https?:\/\//.test(target))) this.web++;
      if (SUBAGENT_TOOLS.has(name)) this.subagents += Array.isArray(args?.tasks) ? args.tasks.length : 1;

      const commandLine = isShellTool(name) ? shellCommand(args) : undefined;
      if (!commandLine) continue;
      for (const w of commands(commandLine)) {
        const t = testRun(w);
        if (t) this.tests.add(t);
        const b = buildRun(w);
        if (b) this.builds.add(b);
        const d = depsRun(w);
        if (d) this.deps.add(d);
        const g = gitRun(w);
        if (g) this.git.add(g);
        if (w[0] === "git" && positionals(w)[0] === "mv") this.moves++;
        if (READ_COMMANDS.has(w[0]) || (w[0] === "sed" && w.includes("-n"))) this.lookups++;
      }
    }
    this.loops.add(events, from);
    return this;
  }

  /** Every automatic tag the events so far make up, sorted by tag. */
  tags(): AutoTag[] {
    const tags: AutoTag[] = [];
    const tag = (t: string, reason: string) => tags.push({ tag: t, reason });

    const byLanguage = new Map<string, number>();
    for (const file of this.changed) {
      const lang = LANGUAGE_BY_EXT.get(path.extname(file).toLowerCase());
      if (lang) byLanguage.set(lang.tag, (byLanguage.get(lang.tag) ?? 0) + 1);
    }
    for (const lang of LANGUAGES) {
      const n = byLanguage.get(lang.tag) ?? 0;
      if (n > 0 && (n >= LANGUAGE_MIN_FILES || n / this.changed.size >= LANGUAGE_MIN_SHARE)) {
        tag(lang.tag, `changed ${plural(n, `${lang.label} file`)}${n < this.changed.size ? ` (of ${this.changed.size} changed)` : ""}`);
      }
    }

    if (this.tests.total) tag("tests", `ran tests ${plural(this.tests.total, "time")}: ${this.tests}`);
    if (this.builds.total) tag("build", `ran ${plural(this.builds.total, "build")}: ${this.builds}`);
    if (this.deps.total) tag("deps", `changed dependencies: ${this.deps}`);
    if (this.git.total) tag("git", this.git.toString());
    if (this.web) tag("web", `${plural(this.web, "web search or fetch", "web searches and fetches")}`);
    const refactorBranch = this.gitBranch && /^refactor(\/|-|$)/i.test(this.gitBranch);
    if (this.moves >= REFACTOR_MIN_MOVES || refactorBranch) {
      tag("refactor", this.moves >= REFACTOR_MIN_MOVES ? `moved or renamed ${plural(this.moves, "file")}` : `on branch ${this.gitBranch}`);
    }
    if (this.subagents) tag("subagents", `spawned ${plural(this.subagents, "subagent")}`);

    const failing = this.failures >= ERROR_MIN_FAILURES && this.failures / this.toolResults >= ERROR_MIN_RATE;
    if (failing || this.apiErrors) {
      const parts = [failing && `${this.failures} of ${plural(this.toolResults, "tool call")} failed`, this.apiErrors && plural(this.apiErrors, "API error")].filter(Boolean);
      tag("errors", parts.join("; "));
    }
    if (this.active > LONG_ACTIVE_MS) tag("long", `${hoursMinutes(this.active)} of activity`);
    if (!this.changed.size && this.lookups + this.web >= RESEARCH_MIN_LOOKUPS) {
      tag("research", `${this.lookups + this.web} reads, searches and fetches; no file changed`);
    }
    const loops = this.loops.loops();
    if (loops.length) tag("loop", loopReason(loops, this.cwd));

    return tags.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  }
}

/** Every automatic tag that applies, sorted by tag. */
export const deriveAutoTags = (input: AutoTagInput): AutoTag[] => new AutoTagScan(input).add(input.events).tags();

/** Names of the automatic tags that apply, sorted and unique. */
export const autoTags = (input: AutoTagInput): string[] => deriveAutoTags(input).map((t) => t.tag);
