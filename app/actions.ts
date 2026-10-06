"use server";

import { revalidatePath } from "next/cache";
import { normalizeTag } from "../src/store/queries";
import { getDb, runSync } from "./lib/server";

/** A failed sync is kept by `runSync` and shown in the top bar, so the button never turns it into an error page. */
export async function syncNow(): Promise<void> {
  await runSync().catch(() => undefined);
  revalidatePath("/", "layout");
}

export type TagResult = { ok: true; tag: string } | { ok: false; error: string };

const revalidateSession = (sessionId: string) => {
  revalidatePath(`/sessions/${encodeURIComponent(sessionId)}`);
  revalidatePath("/sessions");
  revalidatePath("/");
};

export async function addTag(sessionId: string, tag: string): Promise<TagResult> {
  const clean = normalizeTag(tag);
  if (!clean) return { ok: false, error: "Tags are 1–40 characters: letters, digits, '-', '_' or '/', starting with a letter or digit." };
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId)) return { ok: false, error: "Unknown session." };
  db.prepare("INSERT OR IGNORE INTO user.tags (session_id, tag, created_at) VALUES (?, ?, ?)").run(sessionId, clean, Date.now());
  revalidateSession(sessionId);
  return { ok: true, tag: clean };
}

export async function removeTag(sessionId: string, tag: string): Promise<TagResult> {
  const clean = normalizeTag(tag);
  if (!clean) return { ok: false, error: "Invalid tag." };
  getDb().prepare("DELETE FROM user.tags WHERE session_id = ? AND tag = ?").run(sessionId, clean);
  revalidateSession(sessionId);
  return { ok: true, tag: clean };
}
