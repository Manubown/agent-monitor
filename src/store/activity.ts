import os from "node:os";
import path from "node:path";
import { type FileOp, fileOps } from "../core/activity";
import { dirKey, fileKey, isAbsolutePath, sessionPath } from "../core/paths";
import { type ResourceKind, type ResourceRef, toolResources } from "../core/resources";
import type { Db } from "./db";
import { SUBTREE } from "./tree";

/**
 * What a session tree (the session plus every subagent, recursively) did:
 * one action per tool call, prompt/error markers, per-file operation counts
 * and the other resources calls worked on (commands, URLs, searches,
 * subagents, other tools). Everything is plain and compact so it can go
 * straight to a client component: agents, files and resources are referenced
 * by index, texts are clipped.
 */

export type ActionCategory = "read" | "write" | "search" | "shell" | "web" | "agent" | "other";

export interface ActivityAgent {
  id: string;
  title: string;
  /** Index of the spawning agent in `agents`; null for the session itself. */
  parent: number | null;
  /** Nesting level below the session (0 = the session). */
  depth: number;
  startedAt: number;
  /** Last activity: the later of the recorded end and the last action. */
  endedAt: number;
  /** Categorical color slot 1..7 (`--series-<slot>`); 8 is skipped because it reads as error red. */
  slot: number;
  /** Index in `actions` of the call that spawned this agent, when it could be matched. */
  spawn: number | null;
  /** The instructions the spawning agent sent (subagents only), one line, clipped. */
  prompt?: string;
}

export interface ActivityAction {
  /** Index in `agents`. */
  agent: number;
  seq: number;
  ts: number;
  tool: string;
  cat: ActionCategory;
  label: string;
  /** Set when the matching tool result failed. */
  error?: true;
  /** Indices in `files` this call touched. */
  files?: number[];
  /** Indices in `resources` this call worked on. */
  res?: number[];
}

export interface ActivityMarker {
  agent: number;
  seq: number;
  ts: number;
  kind: "prompt" | "error";
  label: string;
}

export interface OpCounts {
  reads: number;
  writes: number;
  edits: number;
  deletes: number;
  moves: number;
}

export interface ActivityFile extends OpCounts {
  /** Relative to the session's working directory when inside it, `~/…` under home, else absolute. */
  path: string;
  /** Directory part of `path` ("" for files directly in the working directory). */
  dir: string;
  first: number;
  last: number;
  /** Who touched the file and how, by agent index ascending. */
  agents: (OpCounts & { agent: number })[];
  /** Indices in `actions`, in time order per agent. */
  actions: number[];
}

export type { ResourceKind };

/** A non-file thing calls worked on: a command head, URL or web search, search pattern, spawned agent or tool. */
export interface ActivityResource {
  kind: ResourceKind;
  /** What tells resources of one kind apart (normalized command head, URL, query...); unique per kind, unlike `label`. */
  key: string;
  label: string;
  /** Binary, domain ("search" for web searches), search tool, spawning agent's title, MCP server or "tools". */
  group: string;
  /** For `agent` resources: index in `agents` of the spawned agent, when matched. */
  agent?: number;
  first: number;
  last: number;
  calls: number;
  errors: number;
  /** Calls per agent, by agent index ascending. */
  agents: { agent: number; calls: number; errors: number }[];
  /** Indices in `actions`, in time order per agent. */
  actions: number[];
}

export interface SessionActivity {
  cwd: string | null;
  agents: ActivityAgent[];
  actions: ActivityAction[];
  markers: ActivityMarker[];
  files: ActivityFile[];
  resources: ActivityResource[];
}

const LABEL_MAX = 60;

/** One line, whitespace collapsed, clipped to `max` characters. */
export const clip = (s: string, max = LABEL_MAX): string => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const TOOLS: Record<ActionCategory, string[]> = {
  read: ["read", "read_file", "view_image", "notebookread", "ls", "list_dir"],
  write: ["write", "edit", "multiedit", "notebookedit", "apply_patch", "ast_edit"],
  search: ["grep", "glob", "find", "ast_grep", "search", "toolsearch", "lsp", "codebase_search"],
  shell: ["bash", "shell", "exec_command", "local_shell", "eval", "bashoutput", "killshell", "write_stdin", "unified_exec"],
  web: ["web_search", "websearch", "webfetch", "fetch", "web_fetch", "browser"],
  agent: ["task", "agent", "spawn_agent", "send_input", "wait_agent", "close_agent", "wait", "yield"],
  other: [],
};

/** Lower-cased tool name -> category. */
const CATEGORY_OF: Record<string, ActionCategory> = Object.fromEntries(
  (Object.entries(TOOLS) as [ActionCategory, string[]][]).flatMap(([cat, names]) => names.map((n) => [n, cat])),
);

/** Tools that start a subagent; the source of spawn links. */
const SPAWN: Record<string, true> = { task: true, agent: true, spawn_agent: true };

/** Category of one tool call; anything that changed a file counts as a write, a `read` of a URL as web. */
export function categorize(toolName: string, ops: FileOp[], isUrl = false): ActionCategory {
  if (ops.some((o) => o.op !== "read" && o.op !== "search")) return "write";
  const name = toolName.toLowerCase();
  const cat = Object.hasOwn(CATEGORY_OF, name) ? CATEGORY_OF[name] : "other";
  return cat === "read" && isUrl ? "web" : cat;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

function parseArgs(input: string | null): Record<string, unknown> | undefined {
  if (!input) return undefined;
  try {
    const v: unknown = JSON.parse(input);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Short human label of a call: file name, command head, query, task names. */
function labelOf(name: string, args: Record<string, unknown> | undefined, ops: FileOp[], raw: string | null): string {
  const tool = name.toLowerCase();
  const touched = ops.filter((o) => o.op !== "search");
  if (touched.length) {
    const first = touched[0];
    const base = path.posix.basename(first.path) || first.path;
    const head = first.to ? `${base} → ${path.posix.basename(first.to)}` : base;
    return clip(touched.length > 1 ? `${head} +${touched.length - 1}` : head);
  }
  if (!args) return raw ? clip(raw) : "";
  const command = args.command ?? args.cmd;
  if (Array.isArray(command)) return clip(String(command.at(-1) ?? "").split("\n")[0]);
  if (str(command)) return clip(String(command).split("\n")[0]);
  if (tool === "task" && Array.isArray(args.tasks)) {
    const names = args.tasks.map((t) => (t && typeof t === "object" ? str((t as Record<string, unknown>).name) : undefined)).filter(Boolean);
    return clip(`${args.tasks.length} ${args.tasks.length === 1 ? "task" : "tasks"}${names.length ? `: ${names.join(", ")}` : ""}`);
  }
  const specific = str(args.pattern) ?? str(args.query) ?? str(args.url) ?? str(args.description) ?? str(args.path) ?? str(args.file_path);
  if (specific) return clip(specific);
  if (str(args.i)) return clip(String(args.i));
  const code = str(args.code) ?? str(args.prompt) ?? str(args.message);
  if (code) return clip(code.split("\n")[0]);
  const any = Object.values(args).find((v) => typeof v === "string" && v.trim());
  return any ? clip(String(any)) : "";
}

interface AgentRow {
  id: string;
  parentId: string | null;
  title: string | null;
  nativeId: string;
  filePath: string;
  cwd: string | null;
  startedAt: number;
  endedAt: number;
  prompt: string | null;
}

interface EventRow {
  sessionId: string;
  seq: number;
  ts: number;
  kind: string;
  text: string | null;
  toolName: string | null;
  toolCallId: string | null;
  toolInput: string | null;
  isError: number;
}

/** Display form of an absolute path (slash form, see `src/core/paths.ts`): relative to `cwd` inside it, `~/…` under `home`. */
export function displayPath(p: string, cwd: string | null, home: string): string {
  // Keys as `fileKey` makes them: slash form, no trailing slash, NFC (a decomposed home on macOS still matches).
  const dir = cwd && dirKey(cwd);
  if (dir && isAbsolutePath(dir)) {
    const root = dir.endsWith("/") ? dir : `${dir}/`;
    if (p === dir) return ".";
    if (p.startsWith(root)) return p.slice(root.length);
  }
  const h = home && dirKey(home);
  if (h && h !== "/" && p.startsWith(`${h}/`)) return `~/${p.slice(h.length + 1)}`;
  return p;
}

const COUNT_KEY: Record<Exclude<FileOp["op"], "search">, keyof OpCounts> = {
  read: "reads",
  write: "writes",
  edit: "edits",
  delete: "deletes",
  move: "moves",
};

/** The session tree's agents, actions, markers and files. Null when the session does not exist. */
export function sessionActivity(db: Db, sessionId: string, home: string = os.homedir()): SessionActivity | null {
  const rows = db
    .prepare(
      `${SUBTREE}
       SELECT s.id, s.parent_id AS parentId, s.title, s.native_id AS nativeId, s.file_path AS filePath, s.cwd,
              s.started_at AS startedAt, s.ended_at AS endedAt, substr(d.text, 1, 600) AS prompt
       FROM tree JOIN sessions s ON s.id = tree.id
       LEFT JOIN events d ON d.session_id = s.id AND d.seq = s.dispatch_seq`,
    )
    .all(sessionId) as unknown as AgentRow[];
  const rootRow = rows.find((r) => r.id === sessionId);
  if (!rootRow) return null;

  // Depth-first order: every agent directly after its spawner, siblings by start time.
  const byParent = new Map<string, AgentRow[]>();
  for (const r of rows) {
    if (r.id === sessionId || !r.parentId) continue;
    const list = byParent.get(r.parentId) ?? [];
    list.push(r);
    byParent.set(r.parentId, list);
  }
  const ordered: { row: AgentRow; parent: number | null; depth: number }[] = [];
  const visit = (row: AgentRow, parent: number | null, depth: number) => {
    const index = ordered.length;
    ordered.push({ row, parent, depth });
    const kids = (byParent.get(row.id) ?? []).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
    for (const k of kids) visit(k, index, depth + 1);
  };
  visit(rootRow, null, 0);
  const agentIndex = new Map(ordered.map((o, i) => [o.row.id, i]));

  const agents: ActivityAgent[] = ordered.map(({ row, parent, depth }, i) => ({
    id: row.id,
    title: clip(row.title || row.nativeId),
    parent,
    depth,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    slot: (i % 7) + 1,
    spawn: null,
    ...(row.prompt?.trim() ? { prompt: clip(row.prompt, 400) } : {}),
  }));

  const cwd = rootRow.cwd;
  const cwdKey = cwd && dirKey(cwd);
  const actions: ActivityAction[] = [];
  const markers: ActivityMarker[] = [];
  const files: ActivityFile[] = [];
  const fileIndex = new Map<string, number>();
  const resources: ActivityResource[] = [];
  const resourceIndex = new Map<string, number>();
  /** Per agent: spawn calls, to link subagents to the call that started them. */
  const spawnCalls: { action: number; ts: number; input: string }[][] = agents.map(() => []);

  /** Link a call to a resource; counts are summed once errors are known. */
  const use = (action: number, r: ResourceRef & { agent?: number }) => {
    const id = `${r.kind}\u0000${r.key}`;
    let i = resourceIndex.get(id);
    if (i === undefined) {
      i = resources.length;
      resourceIndex.set(id, i);
      const ts = actions[action].ts;
      resources.push({ kind: r.kind, key: r.key, label: r.label, group: r.group, ...(r.agent !== undefined ? { agent: r.agent } : {}), first: ts, last: ts, calls: 0, errors: 0, agents: [], actions: [] });
    }
    const a = actions[action];
    if (!a.res) a.res = [i];
    else if (!a.res.includes(i)) a.res.push(i);
  };

  const touch = (raw: string, agent: number, action: number, ts: number, kind: Exclude<FileOp["op"], "search">) => {
    const abs = fileKey(raw, home);
    // The working directory itself is a directory listing, not a file.
    if (abs === cwdKey) return;
    let i = fileIndex.get(abs);
    if (i === undefined) {
      i = files.length;
      fileIndex.set(abs, i);
      const shown = displayPath(abs, cwd, home);
      const dir = path.posix.dirname(shown);
      files.push({ path: shown, dir: dir === "." ? "" : dir, reads: 0, writes: 0, edits: 0, deletes: 0, moves: 0, first: ts, last: ts, agents: [], actions: [] });
    }
    const f = files[i];
    const key = COUNT_KEY[kind];
    f[key]++;
    f.first = Math.min(f.first, ts);
    f.last = Math.max(f.last, ts);
    let by = f.agents.find((x) => x.agent === agent);
    if (!by) f.agents.push((by = { agent, reads: 0, writes: 0, edits: 0, deletes: 0, moves: 0 }));
    by[key]++;
    if (f.actions.at(-1) !== action) f.actions.push(action);
    const a = actions[action];
    if (!a.files) a.files = [i];
    else if (!a.files.includes(i)) a.files.push(i);
  };

  // One pass over the tree's events in (agent, seq) order; results only carry what pairing needs.
  const events = db.prepare(
    `${SUBTREE}
     SELECT e.session_id AS sessionId, e.seq, e.ts, e.kind,
            CASE WHEN e.kind IN ('user', 'error') THEN substr(e.text, 1, 400) END AS text,
            e.tool_name AS toolName, e.tool_call_id AS toolCallId,
            CASE WHEN e.kind = 'tool_call' THEN e.tool_input END AS toolInput, e.is_error AS isError
     FROM tree JOIN events e ON e.session_id = tree.id
     WHERE e.kind IN ('tool_call', 'tool_result', 'user', 'error')
     ORDER BY e.session_id, e.seq`,
  );
  let current = "";
  let agent = 0;
  let agentCwd: string | undefined;
  let pending = new Map<string, number>();
  let lastCall = new Map<string, number>();
  for (const e of events.all(sessionId) as unknown as EventRow[]) {
    if (e.sessionId !== current) {
      current = e.sessionId;
      agent = agentIndex.get(current) ?? 0;
      agentCwd = ordered[agent].row.cwd ?? undefined;
      pending = new Map();
      lastCall = new Map();
    }
    const a = agents[agent];
    if (e.ts > a.endedAt) a.endedAt = e.ts;
    if (e.kind === "tool_call") {
      const tool = e.toolName ?? "tool";
      const ops = fileOps(tool, e.toolInput, agentCwd);
      const args = parseArgs(e.toolInput);
      const target = str(args?.path) ?? str(args?.file_path) ?? str(args?.url);
      const index = actions.length;
      actions.push({
        agent,
        seq: e.seq,
        ts: e.ts,
        tool,
        cat: categorize(tool, ops, target !== undefined && /^https?:\/\//.test(target)),
        label: labelOf(tool, args, ops, e.toolInput),
      });
      if (e.toolCallId) pending.set(e.toolCallId, index);
      lastCall.set(tool, index);
      for (const op of ops) {
        if (op.op === "search") continue;
        touch(op.path, agent, index, e.ts, op.op);
        if (op.to) touch(op.to, agent, index, e.ts, "move");
      }
      const where = (p: string) => displayPath(fileKey(sessionPath(p, agentCwd), home), cwd, home);
      for (const r of toolResources(tool, args, e.toolInput, where)) use(index, r);
      if (Object.hasOwn(SPAWN, tool.toLowerCase())) spawnCalls[agent].push({ action: index, ts: e.ts, input: e.toolInput ?? "" });
    } else if (e.kind === "tool_result") {
      // Pair by call id; results without one belong to the latest call of the same tool.
      const index = e.toolCallId ? pending.get(e.toolCallId) : e.toolName ? lastCall.get(e.toolName) : undefined;
      if (index !== undefined && e.isError) actions[index].error = true;
      if (e.toolCallId) pending.delete(e.toolCallId);
    } else {
      markers.push({ agent, seq: e.seq, ts: e.ts, kind: e.kind === "user" ? "prompt" : "error", label: clip(e.text ?? "") });
    }
  }

  // Spawn links: the call naming the subagent, else the latest spawn call just before it started.
  for (let i = 1; i < agents.length; i++) {
    const parent = agents[i].parent;
    if (parent === null) continue;
    const calls = spawnCalls[parent];
    if (!calls.length) continue;
    const name = path.basename(ordered[i].row.filePath).replace(/\.jsonl$/, "");
    const named = calls.findLast(
      (c) => c.ts <= agents[i].startedAt + 5_000 && (c.input.includes(`"name":"${name}"`) || c.input.includes(`"name": "${name}"`)),
    );
    const before = calls.findLast((c) => c.ts <= agents[i].startedAt + 5_000);
    agents[i].spawn = (named ?? before)?.action ?? null;
  }

  // Spawn calls work on the agents they started; calls nothing matched stay one resource per label.
  for (let i = 1; i < agents.length; i++) {
    const spawn = agents[i].spawn;
    const parent = agents[i].parent;
    if (spawn === null || parent === null) continue;
    use(spawn, { kind: "agent", key: `#${i}`, label: agents[i].title, group: agents[parent].title, agent: i });
  }
  for (const calls of spawnCalls) {
    for (const c of calls) {
      const a = actions[c.action];
      if (!a.res?.some((r) => resources[r].kind === "agent")) use(c.action, { kind: "agent", key: `?${a.label}`, label: a.label || a.tool, group: "unmatched" });
    }
  }
  // Everything else is the tool itself.
  actions.forEach((a, i) => {
    if (!a.files && !a.res) use(i, { kind: "tool", key: a.tool, label: clip(a.tool), group: "tools" });
  });

  actions.forEach((a, i) => {
    for (const r of a.res ?? []) {
      const res = resources[r];
      res.calls++;
      if (a.error) res.errors++;
      res.first = Math.min(res.first, a.ts);
      res.last = Math.max(res.last, a.ts);
      let by = res.agents.find((x) => x.agent === a.agent);
      if (!by) res.agents.push((by = { agent: a.agent, calls: 0, errors: 0 }));
      by.calls++;
      if (a.error) by.errors++;
      res.actions.push(i);
    }
  });

  for (const f of files) f.agents.sort((x, y) => x.agent - y.agent);
  for (const r of resources) r.agents.sort((x, y) => x.agent - y.agent);
  return { cwd, agents, actions, markers, files, resources };
}
