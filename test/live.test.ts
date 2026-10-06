import { describe, expect, it } from "vitest";
import {
  affectsPage,
  changeSummary,
  healthKey,
  type LiveSignal,
  type LiveView,
  liveStep,
  MAX_LISTED,
  safeDecode,
  type SyncHealth,
  syncedAt,
} from "../app/lib/live";

const change = (sessions: string[] | null, cwds: string[] | null = [], changed = 1) => ({ changed, sessions, cwds });
const healthy: SyncHealth = { syncError: null, searchError: null, files: { files: 10, missing: 0, errors: 0 } };

describe("changeSummary", () => {
  it("lists changed ids with their ancestors, and distinct cwds", () => {
    const parents: Record<string, string> = { "claude-code:sub": "claude-code:root", "claude-code:sub2": "claude-code:sub" };
    const ancestors = (ids: string[]) => {
      const out: string[] = [];
      for (let id of ids) while (parents[id]) out.push((id = parents[id]));
      return out;
    };
    const s = changeSummary(
      [
        { id: "claude-code:sub2", cwd: "/w/a" },
        { id: "codex:x", cwd: "/w/a" },
        { id: "codex:y", cwd: null },
      ],
      ancestors,
    );
    expect(s.changed).toBe(3);
    expect(s.sessions?.sort()).toEqual(["claude-code:root", "claude-code:sub", "claude-code:sub2", "codex:x", "codex:y"]);
    expect(s.cwds).toEqual(["/w/a"]);
  });

  it("sends everything-changed past the cap without looking up ancestors", () => {
    const many = Array.from({ length: MAX_LISTED + 1 }, (_, i) => ({ id: `s${i}`, cwd: "/w" }));
    const s = changeSummary(many, () => {
      throw new Error("not called");
    });
    expect(s).toEqual({ changed: MAX_LISTED + 1, sessions: null, cwds: null });
    expect(changeSummary(many.slice(0, MAX_LISTED), () => []).sessions).toHaveLength(MAX_LISTED);
  });

  it("falls back to everything-changed when the ancestor lookup fails", () => {
    const s = changeSummary([{ id: "a", cwd: "/w" }], () => {
      throw new Error("database is locked");
    });
    expect(s).toEqual({ changed: 1, sessions: null, cwds: null });
  });

  it("reports an empty sync as no change", () => {
    expect(changeSummary([], () => [])).toEqual({ changed: 0, sessions: [], cwds: [] });
  });
});

describe("affectsPage", () => {
  it("never refreshes for a sync that changed nothing", () => {
    for (const p of ["/", "/sessions", "/sessions/a", "/projects/map"]) expect(affectsPage(p, "", change(null, null, 0))).toBe(false);
  });

  it("refreshes aggregate and unknown pages on any change", () => {
    for (const p of ["/", "/sessions", "/usage", "/errors", "/projects", "/somewhere/new"]) {
      expect(affectsPage(p, "?range=7d", change(["other"]))).toBe(true);
    }
  });

  it("refreshes a session page only when the session or its tree changed", () => {
    expect(affectsPage("/sessions/claude-code%3Aabc", "", change(["claude-code:abc"]))).toBe(true);
    expect(affectsPage("/sessions/claude-code:abc", "?kinds=user", change(["claude-code:abc"]))).toBe(true);
    expect(affectsPage("/sessions/claude-code%3Aabc/graph", "", change(["claude-code:abc"]))).toBe(true);
    expect(affectsPage("/sessions/claude-code%3Aabc", "", change(["codex:other"]))).toBe(false);
    // Claude Code subagent ids contain a slash, encoded in the segment.
    const sub = "claude-code:abc/agent-1";
    expect(affectsPage(`/sessions/${encodeURIComponent(sub)}`, "", change([sub, "claude-code:abc"]))).toBe(true);
    expect(affectsPage(`/sessions/${encodeURIComponent(sub)}/graph`, "", change(["claude-code:abc"]))).toBe(false);
    // Unlisted (too many changes): refresh.
    expect(affectsPage("/sessions/claude-code%3Aabc", "", change(null, null))).toBe(true);
    // A malformed segment does not throw.
    expect(affectsPage("/sessions/%E0%A4%A", "", change(["x"]))).toBe(false);
  });

  it("refreshes a project map only when a session of that project changed", () => {
    const search = `?${new URLSearchParams({ project: "C:\\w\\app", range: "30d" })}`;
    expect(affectsPage("/projects/map", search, change(["s"], ["C:\\w\\app"]))).toBe(true);
    expect(affectsPage("/projects/map", search, change(["s"], ["C:\\w\\other"]))).toBe(false);
    expect(affectsPage("/projects/map", search, change(null, null))).toBe(true);
    expect(affectsPage("/projects/map", "", change(["s"], ["/x"]))).toBe(true);
  });
});

describe("healthKey", () => {
  it("ignores when a failure happened, only what failed", () => {
    const a = healthKey({ ...healthy, syncError: { message: "disk full", at: 1 } });
    expect(healthKey({ ...healthy, syncError: { message: "disk full", at: 2 } })).toBe(a);
    expect(healthKey(healthy)).not.toBe(a);
    expect(healthKey({ ...healthy, searchError: { message: "x", unavailable: true } })).not.toBe(healthKey(healthy));
  });

  it("changes with the file counts the top bar shows", () => {
    const key = healthKey(healthy);
    expect(healthKey({ ...healthy, files: { files: 10, missing: 0, errors: 0 } })).toBe(key);
    expect(healthKey({ ...healthy, files: { files: 11, missing: 0, errors: 0 } })).not.toBe(key);
    expect(healthKey({ ...healthy, files: { files: 10, missing: 1, errors: 0 } })).not.toBe(key);
    expect(healthKey({ ...healthy, files: { files: 10, missing: 0, errors: 1 } })).not.toBe(key);
    expect(healthKey({ ...healthy, files: null })).not.toBe(key);
  });
});

describe("liveStep", () => {
  const view: LiveView = { generation: 5, health: healthKey(healthy), skipped: false };
  const sync = (signal: Extract<LiveSignal, { kind: "sync" }>) => signal;
  const onSession = (sessions: string[], extra: Partial<SyncHealth> = {}) =>
    sync({ kind: "sync", event: { generation: 6, changed: 1, sessions, cwds: ["/w"], health: { ...healthy, ...extra } }, pathname: "/sessions/a", search: "" });

  it("refreshes a page the sync changed, and leaves nothing skipped", () => {
    const r = liveStep(view, onSession(["a"]));
    expect(r).toEqual({ view: { ...view, generation: 6 }, refresh: true });
  });

  it("remembers a change to another page and refreshes on the next URL change only", () => {
    const r = liveStep(view, onSession(["b"]));
    expect(r.refresh).toBe(false);
    expect(r.view).toEqual({ ...view, generation: 6, skipped: true });
    expect(liveStep(r.view, { kind: "navigated" }).refresh).toBe(true);
    // The caller clears `skipped` when it refreshes; afterwards navigating is free again.
    expect(liveStep({ ...r.view, skipped: false }, { kind: "navigated" }).refresh).toBe(false);
    expect(liveStep(view, { kind: "navigated" })).toEqual({ view, refresh: false });
  });

  it("keeps a skipped change across later syncs that do refresh", () => {
    const skipped = liveStep(view, onSession(["b"])).view;
    expect(liveStep(skipped, onSession(["a"])).view.skipped).toBe(true);
  });

  it("does not count an empty or failed sync as skipped", () => {
    const empty = sync({ kind: "sync", event: { generation: 5, changed: 0, sessions: [], cwds: [], health: healthy }, pathname: "/sessions/a", search: "" });
    expect(liveStep(view, empty)).toEqual({ view, refresh: false });
    const failed = sync({ ...empty, event: { ...empty.event, health: { ...healthy, syncError: { message: "boom", at: 9 } } } });
    const r = liveStep(view, failed);
    expect(r.refresh).toBe(true);
    expect(r.view.skipped).toBe(false);
    // The same failure again is no news.
    expect(liveStep(r.view, failed).refresh).toBe(false);
  });

  it("refreshes any page when the top bar's counts change, even if no session did", () => {
    const r = liveStep(view, sync({ kind: "sync", event: { generation: 5, changed: 0, sessions: [], cwds: [], health: { ...healthy, files: { files: 10, missing: 0, errors: 1 } } }, pathname: "/sessions/a", search: "" }));
    expect(r.refresh).toBe(true);
  });

  it("refreshes on hello when syncs were missed or health changed", () => {
    expect(liveStep(view, { kind: "hello", generation: 5, health: healthy })).toEqual({ view, refresh: false });
    expect(liveStep(view, { kind: "hello", generation: 7, health: healthy })).toEqual({ view: { ...view, generation: 7 }, refresh: true });
    expect(liveStep(view, { kind: "hello", generation: 5, health: { ...healthy, files: null } }).refresh).toBe(true);
    // A malformed event (no health) keeps the known health.
    expect(liveStep(view, { kind: "hello", generation: 5 })).toEqual({ view, refresh: false });
  });

  it("keeps the generation through a sync without one", () => {
    const r = liveStep(view, sync({ kind: "sync", event: {}, pathname: "/", search: "" }));
    expect(r).toEqual({ view, refresh: false });
  });
});

describe("syncedAt", () => {
  it("is the time of a successful sync only", () => {
    expect(syncedAt({ at: 100, health: healthy })).toBe(100);
    expect(syncedAt({ at: 100, health: { ...healthy, syncError: { message: "boom", at: 100 } } })).toBeNull();
    expect(syncedAt({ health: healthy })).toBeNull();
    expect(syncedAt({ at: 100 })).toBeNull();
  });
});

describe("safeDecode", () => {
  it("decodes, and keeps malformed percent-encoding as written", () => {
    expect(safeDecode("claude-code%3Aabc%2Fagent-1")).toBe("claude-code:abc/agent-1");
    expect(safeDecode("e-%")).toBe("e-%");
    expect(safeDecode("%E0%A4%A")).toBe("%E0%A4%A");
  });
});
