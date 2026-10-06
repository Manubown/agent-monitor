import type { Db } from "./db";

/**
 * The prompt each subagent was dispatched with: the text of the event at its
 * `dispatch_seq`, i.e. exactly the instructions it received from its spawner
 * (clipped at storage like every event text). Sessions without one are absent.
 */
export function dispatchPrompts(db: Db, ids: readonly string[]): Record<string, string> {
  if (!ids.length) return {};
  const rows = db
    .prepare(
      `SELECT s.id, e.text FROM sessions s JOIN events e ON e.session_id = s.id AND e.seq = s.dispatch_seq
       WHERE s.id IN (SELECT value FROM json_each(?)) AND e.text IS NOT NULL`,
    )
    .all(JSON.stringify(ids)) as { id: string; text: string }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.text]));
}
