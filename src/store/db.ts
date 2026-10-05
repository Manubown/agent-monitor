import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Env, homeDir } from "../core/adapter";

export type Db = DatabaseSync;

/**
 * Bump when the schema changes. The database is a cache: older databases are
 * dropped and rebuilt from the live logs plus the raw-log archive on next sync.
 * User data (tags) lives in user.db and is never dropped.
 */
const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE files (
  path        TEXT PRIMARY KEY,
  adapter     TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mtime_ms    REAL NOT NULL,
  synced_at   INTEGER NOT NULL,
  missing     INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);

CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,          -- "<source>:<native id>"
  source             TEXT NOT NULL,
  native_id          TEXT NOT NULL,
  parent_id          TEXT,                      -- spawning session (subagents)
  file_path          TEXT NOT NULL,
  title              TEXT,
  cwd                TEXT,
  git_branch         TEXT,
  agent_version      TEXT,
  models             TEXT NOT NULL,             -- JSON array, heaviest first
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER NOT NULL,
  event_count        INTEGER NOT NULL,
  user_messages      INTEGER NOT NULL,
  tool_calls         INTEGER NOT NULL,
  tool_errors        INTEGER NOT NULL,
  errors             INTEGER NOT NULL,
  requests           INTEGER NOT NULL,
  input_tokens       INTEGER NOT NULL,
  output_tokens      INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  reasoning_tokens   INTEGER NOT NULL,
  cost_usd           REAL,                      -- null when nothing could be priced
  cost_source        TEXT NOT NULL,             -- reported | estimated | mixed | partial | unpriced | none
  events_hash        TEXT NOT NULL              -- chained hash of the stored events, detects append-only changes
);
CREATE INDEX sessions_started ON sessions(started_at);
CREATE INDEX sessions_parent ON sessions(parent_id);
CREATE INDEX sessions_file ON sessions(file_path);

CREATE TABLE events (
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  text         TEXT,
  tool_name    TEXT,
  tool_call_id TEXT,
  tool_input   TEXT,
  is_error     INTEGER NOT NULL DEFAULT 0,
  model        TEXT,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX events_tool ON events(tool_name);

CREATE TABLE usage (
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  model        TEXT NOT NULL,
  input        INTEGER NOT NULL,
  output       INTEGER NOT NULL,
  cache_read   INTEGER NOT NULL,
  cache_write  INTEGER NOT NULL,
  reasoning    INTEGER NOT NULL,
  cost_usd     REAL,
  cost_source  TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX usage_ts ON usage(ts);
`;

/** Tables in user.db: data the user created. Never dropped by schema changes. */
const USER_SCHEMA = `
CREATE TABLE IF NOT EXISTS user.tags (
  session_id TEXT NOT NULL,
  tag        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, tag)
);
CREATE INDEX IF NOT EXISTS user.tags_tag ON tags(tag);
`;

/** $XDG_DATA_HOME/agent-monitor: database, user data, search index and raw-log archive. */
export function dataDir(env: Env = process.env): string {
  const dataHome = env.XDG_DATA_HOME || path.join(homeDir(env), ".local", "share");
  return path.join(dataHome, "agent-monitor");
}

export function defaultDbPath(env: Env = process.env): string {
  return env.AGENT_MONITOR_DB || path.join(dataDir(env), "monitor.db");
}

/** Compressed copies of every ingested log; the source of truth once a tool prunes its own logs. */
export function defaultArchiveDir(env: Env = process.env): string {
  return env.AGENT_MONITOR_ARCHIVE || path.join(dataDir(env), "archive");
}

/** Files next to the database: user.db (tags) and the search index. In-memory databases get in-memory user data. */
export function siblingPath(dbFile: string, name: string): string {
  return dbFile === ":memory:" ? ":memory:" : path.join(path.dirname(dbFile), name);
}

export interface OpenOptions {
  /** user.db path; defaults to AGENT_MONITOR_USER_DB or user.db next to the database. */
  userDb?: string;
}

/** Open the cache database with user.db attached as schema `user`. */
export function openDb(file: string = defaultDbPath(), options: OpenOptions = {}): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const userDb = options.userDb ?? (process.env.AGENT_MONITOR_USER_DB || siblingPath(file, "user.db"));
  db.prepare("ATTACH DATABASE ? AS user").run(userDb);
  db.exec("PRAGMA user.journal_mode = WAL;");
  db.exec(USER_SCHEMA);
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const { user_version: version } = db.prepare("PRAGMA main.user_version").get() as { user_version: number };
  if (version === SCHEMA_VERSION) return;
  db.exec("BEGIN");
  try {
    for (const table of ["usage", "events", "sessions", "files", "meta"]) db.exec(`DROP TABLE IF EXISTS main.${table}`);
    db.exec(SCHEMA);
    db.exec(`PRAGMA main.user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Run `fn` inside a transaction. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Monotonic counter bumped by every sync that changed the database. The search
 * index stores the generation it reflects; a mismatch means it must be rebuilt.
 */
export function generation(db: Db): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'generation'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

/** Atomic, so a CLI sync and the server's sync never hand out the same number. */
export function bumpGeneration(db: Db): number {
  const row = db
    .prepare(
      `INSERT INTO meta (key, value) VALUES ('generation', '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value`,
    )
    .get() as { value: string | number };
  return Number(row.value);
}
