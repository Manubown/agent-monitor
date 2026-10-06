import os from "node:os";
import { detectLoops, type Loop, type LoopEvent } from "../core/loops";
import { fileKey } from "../core/paths";
import { displayPath, type SessionActivity } from "./activity";
import type { Db } from "./db";

/** A retry loop of one agent in a session tree; edit loops name their file as `SessionActivity.files` does. */
export interface SessionLoop extends Loop {
  /** Index in `activity.agents`. */
  agent: number;
  /** Index in `activity.files` of an edit loop's file, when the file is listed there. */
  file: number | null;
}

interface Row extends LoopEvent {
  sessionId: string;
  cwd: string | null;
  seq: number;
  isError: boolean;
}

/** Retry loops of every agent in the tree `activity` describes (see `detectLoops`), ordered by start time. */
export function sessionLoops(db: Db, activity: SessionActivity, home: string = os.homedir()): SessionLoop[] {
  const agentIndex = new Map(activity.agents.map((a, i) => [a.id, i]));
  const fileIndex = new Map(activity.files.map((f, i) => [f.path, i]));
  const rows = db
    .prepare(
      `SELECT e.session_id AS sessionId, s.cwd, e.seq, e.ts, e.kind, e.tool_name AS toolName, e.tool_call_id AS toolCallId,
              CASE WHEN e.kind = 'tool_call' THEN e.tool_input END AS toolInput, e.is_error AS isError
       FROM events e JOIN sessions s ON s.id = e.session_id
       WHERE e.session_id IN (SELECT value FROM json_each(?)) AND e.kind IN ('tool_call', 'tool_result')
       ORDER BY e.session_id, e.seq`,
    )
    .all(JSON.stringify([...agentIndex.keys()])) as unknown as (Omit<Row, "isError"> & { isError: number })[];

  const bySession = new Map<string, Row[]>();
  for (const r of rows) {
    const list = bySession.get(r.sessionId) ?? [];
    list.push({ ...r, isError: r.isError === 1 });
    bySession.set(r.sessionId, list);
  }

  const out: SessionLoop[] = [];
  for (const [id, events] of bySession) {
    const agent = agentIndex.get(id) ?? 0;
    for (const loop of detectLoops(events, events[0].cwd)) {
      if (loop.kind !== "edit") {
        out.push({ ...loop, agent, file: null });
        continue;
      }
      // Same key as the activity's file list: `~/x` expanded, NFC, shown relative to the session's directory.
      const subject = displayPath(fileKey(loop.subject, home), activity.cwd, home);
      out.push({ ...loop, subject, agent, file: fileIndex.get(subject) ?? null });
    }
  }
  return out.sort((a, b) => a.firstTs - b.firstTs || a.agent - b.agent || a.firstSeq - b.firstSeq);
}
