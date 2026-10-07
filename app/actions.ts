"use server";

import { revalidatePath } from "next/cache";
import { applyEdit, type LayoutEdit, parseEdit } from "../src/core/dashboard";
import { loadLayout, resetLayout, saveLayout } from "../src/store/dashboard";
import { normalizeTag } from "../src/store/queries";
import { WIDGET_SPECS } from "./components/dashboard/specs";
import { getDb, runSync } from "./lib/server";

/** A failed sync is kept by `runSync` and shown in the top bar, so the button never turns it into an error page. */
export async function syncNow(): Promise<void> {
  await runSync().catch(() => undefined);
  revalidatePath("/", "layout");
}

/**
 * One change to the dashboard layout. The browser sends only what it wants changed; the stored layout is read here
 * and the edit is checked against the widget registry (`parseEdit`) before `applyEdit` decides whether it is
 * possible at all, so no request can store a widget, a width or a height the registry does not know. An edit that
 * does not survive that is dropped silently: the page re-renders unchanged, which is what the controls would show.
 */
export async function updateDashboard(edit: LayoutEdit): Promise<void> {
  const valid = parseEdit(edit, WIDGET_SPECS);
  if (!valid) return;
  const db = getDb();
  if (valid.kind === "reset") resetLayout(db);
  else saveLayout(db, WIDGET_SPECS, applyEdit(loadLayout(db, WIDGET_SPECS), valid, WIDGET_SPECS));
  revalidatePath("/");
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
