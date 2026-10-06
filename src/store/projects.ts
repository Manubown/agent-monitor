import os from "node:os";
import path from "node:path";
import { fileOps } from "../core/activity";
import type { GourceTouch, TouchKind } from "../core/gource";
import { totalTokens } from "../core/types";
import { clip, displayPath } from "./activity";
import { type Db, generation } from "./db";
import { byProject, type Filters, where } from "./queries";

/**
 * Cross-session file activity of a project (every session, subagents included, whose working directory is the
 * project): which files were read and changed, by which agents, when. Parsing tool inputs is the expensive part, so
 * the parsed log of a project is kept per database generation and filters are applied on top of it.
 */

/** Lower-cased tool names `fileOps` takes paths from; grep/glob searches are not file touches. */
const FILE_TOOLS = ["read", "write", "edit", "multiedit", "notebookedit", "apply_patch"];

/** Only calls that can touch files: named file tools, plus any tool carrying a patch (Codex runs apply_patch through its shell). */
const FILE_CALLS = `e.kind = 'tool_call' AND (lower(e.tool_name) IN (${FILE_TOOLS.map((t) => `'${t}'`).join(", ")}) OR instr(e.tool_input, '*** Begin Patch') > 0)`;

export interface LogSession {
  id: string;
  parentId: string | null;
  /** Top-level ancestor (the session itself when it has none). */
  rootId: string;
  title: string;
  source: string;
  cwd: string | null;
  startedAt: number;
}

export interface Touch {
  /** Index into `TouchLog.sessions`. */
  session: number;
  seq: number;
  ts: number;
  tool: string;
  kind: TouchKind;
  /** Index into `TouchLog.files`. */
  file: number;
}

export interface TouchLog {
  sessions: LogSession[];
  /** Absolute paths (or as written when no working directory was known), NFC. */
  files: string[];
  /** In (session, seq) order. */
  touches: Touch[];
}

/** Parse the file touches of `ids` (each resolved against its own working directory). */
function loadLog(db: Db, ids: string[], root: (id: string, parentId: string | null) => string, home: string): TouchLog {
  const sessionStmt = db.prepare(
    "SELECT id, parent_id AS parentId, title, native_id AS nativeId, source, cwd, started_at AS startedAt FROM sessions WHERE id = ?",
  );
  const eventStmt = db.prepare(
    `SELECT e.seq, e.ts, e.tool_name AS toolName, e.tool_input AS toolInput FROM events e WHERE e.session_id = ? AND ${FILE_CALLS} ORDER BY e.seq`,
  );
  const sessions: LogSession[] = [];
  const files: string[] = [];
  const fileIndex = new Map<string, number>();
  const touches: Touch[] = [];
  for (const id of ids) {
    const s = sessionStmt.get(id) as
      | { id: string; parentId: string | null; title: string | null; nativeId: string; source: string; cwd: string | null; startedAt: number }
      | undefined;
    if (!s) continue;
    const session = sessions.length;
    sessions.push({
      id: s.id,
      parentId: s.parentId,
      rootId: root(s.id, s.parentId),
      title: clip(s.title || s.nativeId),
      source: s.source,
      cwd: s.cwd,
      startedAt: s.startedAt,
    });
    const cwd = s.cwd ?? undefined;
    const add = (raw: string, kind: TouchKind, e: { seq: number; ts: number; tool: string }) => {
      // One key per file however it was written: `~/x` and `/home/me/x`, composed and decomposed umlauts.
      const abs = (raw.startsWith("~/") && home ? path.posix.join(home, raw.slice(2)) : raw).normalize("NFC");
      // The working directory itself is a directory listing, not a file.
      if (abs === s.cwd) return;
      let file = fileIndex.get(abs);
      if (file === undefined) {
        file = files.length;
        fileIndex.set(abs, file);
        files.push(abs);
      }
      touches.push({ session, seq: e.seq, ts: e.ts, tool: e.tool, kind, file });
    };
    for (const e of eventStmt.all(id) as { seq: number; ts: number; toolName: string | null; toolInput: string | null }[]) {
      const call = { seq: e.seq, ts: e.ts, tool: e.toolName ?? "tool" };
      for (const op of fileOps(e.toolName, e.toolInput, cwd)) {
        if (op.op === "search") continue;
        if (op.op === "move") {
          add(op.path, "move-from", call);
          if (op.to) add(op.to, "move-to", call);
        } else add(op.path, op.op, call);
      }
    }
  }
  return { sessions, files, touches };
}

/** Top-level ancestor of each session, walking `parent_id` (parents missing from the database end the walk). */
function rootFinder(db: Db): (id: string, parentId: string | null) => string {
  const parentOf = db.prepare("SELECT parent_id AS parentId FROM sessions WHERE id = ?");
  const memo = new Map<string, string>();
  const find = (id: string, parentId: string | null, depth = 0): string => {
    const known = memo.get(id);
    if (known) return known;
    let result = id;
    if (parentId && depth < 64) {
      const parent = parentOf.get(parentId) as { parentId: string | null } | undefined;
      if (parent) result = find(parentId, parent.parentId, depth + 1);
    }
    memo.set(id, result);
    return result;
  };
  return find;
}

/** Parsed logs per database (in-memory test databases included), dropped whenever a sync changes the data. */
const cache = new WeakMap<Db, { generation: number; logs: Map<string, TouchLog> }>();

/** The parsed log of every session whose working directory is `cwd`. Cached until the next sync that changes data. */
export function projectLog(db: Db, cwd: string, home: string = os.homedir()): TouchLog {
  const gen = generation(db);
  let entry = cache.get(db);
  if (!entry || entry.generation !== gen) cache.set(db, (entry = { generation: gen, logs: new Map() }));
  const key = `${home}\0${cwd}`;
  let log = entry.logs.get(key);
  if (!log) {
    const ids = (db.prepare("SELECT id FROM sessions WHERE cwd = ? ORDER BY started_at, id").all(cwd) as { id: string }[]).map((r) => r.id);
    log = loadLog(db, ids, rootFinder(db), home);
    entry.logs.set(key, log);
  }
  return log;
}

/** The parsed log of a session and everything it spawned, recursively. Null when the session does not exist. */
export function sessionLog(db: Db, sessionId: string, home: string = os.homedir()): TouchLog | null {
  const ids = (
    db
      .prepare(
        `WITH RECURSIVE tree(id, depth) AS (
           SELECT id, 0 FROM sessions WHERE id = ? UNION ALL SELECT c.id, tree.depth + 1 FROM sessions c JOIN tree ON c.parent_id = tree.id WHERE tree.depth < 64)
         SELECT tree.id FROM tree JOIN sessions s ON s.id = tree.id ORDER BY s.started_at, s.id`,
      )
      .all(sessionId) as { id: string }[]
  ).map((r) => r.id);
  if (!ids.length) return null;
  return loadLog(db, ids, () => sessionId, home);
}

/** Sessions of `cwd` the filters keep (source, title search, tag); time is applied per touch. */
function allowedSessions(db: Db, cwd: string, f: Filters): Set<string> {
  const w = where({ ...f, from: undefined, cwd }, null);
  return new Set((db.prepare(`SELECT s.id FROM sessions s ${w.sql}`).all(...w.params) as { id: string }[]).map((r) => r.id));
}

/** Touches of the log inside the filters. */
function filtered(db: Db, cwd: string, f: Filters, log: TouchLog): Touch[] {
  const allowed = allowedSessions(db, cwd, f);
  const keep = log.sessions.map((s) => allowed.has(s.id));
  const from = f.from ?? -Infinity;
  return log.touches.filter((t) => keep[t.session] && t.ts >= from);
}

export interface FileCounts {
  reads: number;
  writes: number;
  edits: number;
  deletes: number;
  moves: number;
}

const COUNT_KEY: Record<TouchKind, keyof FileCounts> = {
  read: "reads",
  write: "writes",
  edit: "edits",
  delete: "deletes",
  "move-from": "moves",
  "move-to": "moves",
};

export interface ProjectFile extends FileCounts {
  /** Display path: relative inside the project, `~/…` under home, else absolute. */
  path: string;
  /** Writes + edits + deletes + moves. */
  changes: number;
  /** Distinct top-level sessions (subagent work counts toward its session). */
  sessions: number;
  /** Distinct agents: sessions and subagents. */
  agents: number;
  /** Touches per agent tool (source). */
  sources: Record<string, number>;
  first: number;
  last: number;
}

export interface ProjectMap {
  cwd: string;
  /** Most touched first. */
  files: ProjectFile[];
  /** Top-level sessions and agents (sessions + subagents) with touches in the filters. */
  sessions: number;
  agents: number;
  reads: number;
  changes: number;
}

/** Per-file activity of a project under the page filters. */
export function projectMap(db: Db, cwd: string, f: Filters, home: string = os.homedir()): ProjectMap {
  const log = projectLog(db, cwd, home);
  const touches = filtered(db, cwd, f, log);
  const byFile = new Map<number, ProjectFile & { roots: Set<string>; agentSet: Set<number> }>();
  const roots = new Set<string>();
  const agents = new Set<number>();
  let reads = 0;
  for (const t of touches) {
    let file = byFile.get(t.file);
    if (!file) {
      file = {
        path: displayPath(log.files[t.file], cwd, home),
        reads: 0,
        writes: 0,
        edits: 0,
        deletes: 0,
        moves: 0,
        changes: 0,
        sessions: 0,
        agents: 0,
        sources: {},
        first: t.ts,
        last: t.ts,
        roots: new Set(),
        agentSet: new Set(),
      };
      byFile.set(t.file, file);
    }
    const s = log.sessions[t.session];
    file[COUNT_KEY[t.kind]]++;
    if (t.kind === "read") reads++;
    else file.changes++;
    file.sources[s.source] = (file.sources[s.source] ?? 0) + 1;
    if (t.ts < file.first) file.first = t.ts;
    if (t.ts > file.last) file.last = t.ts;
    file.roots.add(s.rootId);
    file.agentSet.add(t.session);
    roots.add(s.rootId);
    agents.add(t.session);
  }
  const files: ProjectFile[] = [...byFile.values()].map(({ roots, agentSet, ...rest }) => ({ ...rest, sessions: roots.size, agents: agentSet.size }));
  files.sort((a, b) => b.reads + b.changes - (a.reads + a.changes) || b.last - a.last || a.path.localeCompare(b.path));
  return { cwd, files, sessions: roots.size, agents: agents.size, reads, changes: touches.length - reads };
}

export interface FileAgent extends FileCounts {
  sessionId: string;
  rootId: string;
  title: string;
  source: string;
  /** Subagent of another session. */
  subagent: boolean;
  last: number;
}

export interface FileCall {
  sessionId: string;
  title: string;
  source: string;
  seq: number;
  ts: number;
  tool: string;
  kind: TouchKind;
}

export interface FileDetail {
  path: string;
  abs: string;
  /** Per agent (session or subagent), most recently active first. */
  agents: FileAgent[];
  /** Newest first. */
  calls: FileCall[];
}

/** Every touch of one file (by display path) under the filters. Null when the file has none. */
export function projectFile(db: Db, cwd: string, f: Filters, filePath: string, home: string = os.homedir()): FileDetail | null {
  const log = projectLog(db, cwd, home);
  const indexes = new Set<number>();
  log.files.forEach((abs, i) => {
    if (displayPath(abs, cwd, home) === filePath) indexes.add(i);
  });
  if (!indexes.size) return null;
  const touches = filtered(db, cwd, f, log).filter((t) => indexes.has(t.file));
  if (!touches.length) return null;
  const byAgent = new Map<number, FileAgent>();
  const calls: FileCall[] = [];
  for (const t of touches) {
    const s = log.sessions[t.session];
    let a = byAgent.get(t.session);
    if (!a) {
      a = { sessionId: s.id, rootId: s.rootId, title: s.title, source: s.source, subagent: s.rootId !== s.id, reads: 0, writes: 0, edits: 0, deletes: 0, moves: 0, last: t.ts };
      byAgent.set(t.session, a);
    }
    a[COUNT_KEY[t.kind]]++;
    if (t.ts > a.last) a.last = t.ts;
    calls.push({ sessionId: s.id, title: s.title, source: s.source, seq: t.seq, ts: t.ts, tool: t.tool, kind: t.kind });
  }
  calls.sort((a, b) => b.ts - a.ts || b.seq - a.seq);
  return {
    path: filePath,
    abs: log.files[[...indexes][0]],
    agents: [...byAgent.values()].sort((a, b) => b.last - a.last),
    calls,
  };
}

export interface ProjectSummary {
  cwd: string;
  /** Top-level sessions active in range. */
  sessions: number;
  /** Sessions plus subagents active in range. */
  agents: number;
  sources: string[];
  cost: number | null;
  tokens: number;
  toolCalls: number;
  /** Distinct files written, edited, deleted or moved in range. */
  filesChanged: number;
  filesTouched: number;
  lastActive: number;
}

/** Every project (distinct working directory) with sessions active in the filters, most recently active first. */
export function listProjects(db: Db, f: Filters, home: string = os.homedir()): ProjectSummary[] {
  const w = where(f, "s.ended_at");
  const rows = db
    .prepare(
      `SELECT s.cwd AS cwd, COUNT(CASE WHEN s.parent_id IS NULL THEN 1 END) AS sessions, COUNT(*) AS agents,
              json_group_array(DISTINCT s.source) AS sources, SUM(s.tool_calls) AS toolCalls, MAX(s.ended_at) AS lastActive
       FROM sessions s ${w.sql ? `${w.sql} AND` : "WHERE"} s.cwd IS NOT NULL
       GROUP BY s.cwd ORDER BY lastActive DESC, s.cwd`,
    )
    .all(...w.params) as { cwd: string; sessions: number; agents: number; sources: string; toolCalls: number; lastActive: number }[];
  // Cost and tokens as the overview counts them: usage inside the range.
  const usage = new Map(byProject(db, f).map((p) => [p.cwd, p]));
  return rows.map((r) => {
    const map = projectMap(db, r.cwd, f, home);
    const u = usage.get(r.cwd);
    return {
      cwd: r.cwd,
      sessions: r.sessions,
      agents: r.agents,
      sources: (JSON.parse(r.sources) as string[]).sort(),
      cost: u ? u.cost : null,
      tokens: u ? totalTokens(u) : 0,
      toolCalls: r.toolCalls,
      filesChanged: map.files.filter((x) => x.changes > 0).length,
      filesTouched: map.files.length,
      lastActive: r.lastActive,
    };
  });
}

/** Gource touches of a project under the filters; paths as on the map, user = agent title. */
export function projectGource(db: Db, cwd: string, f: Filters, home: string = os.homedir()): GourceTouch[] {
  const log = projectLog(db, cwd, home);
  return toGource(log, filtered(db, cwd, f, log), cwd, home);
}

/** Gource touches of a session tree; paths relative to the session's working directory. Null when the session does not exist. */
export function sessionGource(db: Db, sessionId: string, home: string = os.homedir()): GourceTouch[] | null {
  const log = sessionLog(db, sessionId, home);
  if (!log) return null;
  const cwd = log.sessions.find((s) => s.id === sessionId)?.cwd ?? null;
  return toGource(log, log.touches, cwd, home);
}

function toGource(log: TouchLog, touches: Touch[], cwd: string | null, home: string): GourceTouch[] {
  const shown = new Map<number, string>();
  return touches.map((t) => {
    let p = shown.get(t.file);
    if (p === undefined) shown.set(t.file, (p = displayPath(log.files[t.file], cwd, home)));
    const s = log.sessions[t.session];
    return { ts: t.ts, user: s.title, kind: t.kind, path: p, source: s.source };
  });
}
