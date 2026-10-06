import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncEvent } from "../app/lib/live";
import { openDb } from "../src/store/db";

// The route reads the process-wide state of app/lib/server.ts. Seed it before the import with an empty in-memory
// database and no finished sync, so the import screen's progress events apply; no sync ever runs here.
type State = NonNullable<typeof globalThis.__agentMonitor>;
let state: State;
let GET: (request: Request) => Response;
beforeAll(async () => {
  state = globalThis.__agentMonitor = { db: openDb(":memory:"), indexError: "not used in tests" };
  ({ GET } = await import("../app/api/live/route"));
});

beforeEach(() => {
  vi.useFakeTimers();
  state.last = undefined;
  state.failure = undefined;
  state.running = undefined;
});
afterEach(() => {
  vi.useRealTimers();
});

/** Opens the stream and collects its text until `close()`. */
function open() {
  const abort = new AbortController();
  const res = GET(new Request("http://127.0.0.1:4100/api/live", { signal: abort.signal }));
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const out = { text: "" };
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      out.text += decoder.decode(value);
    }
  })();
  const events = (name: string) => out.text.split("\n\n").filter((chunk) => chunk.startsWith(`event: ${name}\n`)).length;
  return { events, close: () => abort.abort() };
}

const syncEvent = (e: Partial<SyncEvent>): SyncEvent => ({
  at: Date.now(),
  generation: null,
  changed: 0,
  sessions: [],
  cwds: [],
  health: { syncError: null, searchError: null, files: null },
  ...e,
});
const emit = (e: SyncEvent) => {
  for (const listener of state.listeners ?? []) listener(e);
};

describe("GET /api/live progress", () => {
  it("reports import progress until a sync event, even a failed one", async () => {
    const s = open();
    await vi.advanceTimersByTimeAsync(2500);
    expect(s.events("hello")).toBe(1);
    const before = s.events("progress");
    expect(before).toBeGreaterThanOrEqual(3);
    // The first sync failed: it carries the old (null) generation.
    emit(syncEvent({ health: { syncError: { message: "boom", at: Date.now() }, searchError: null, files: null } }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.events("sync")).toBe(1);
    expect(s.events("progress")).toBe(before);
    s.close();
  });

  it("sends no progress when the first sync failed and none is running", async () => {
    state.failure = { message: "boom", at: Date.now() };
    const s = open();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.events("hello")).toBe(1);
    expect(s.events("progress")).toBe(0);
    s.close();
  });

  it("stops polling when a failure is left and no sync runs any more", async () => {
    state.failure = { message: "boom", at: Date.now() };
    state.running = new Promise(() => {}) as never;
    const s = open();
    await vi.advanceTimersByTimeAsync(2500);
    const before = s.events("progress");
    expect(before).toBeGreaterThanOrEqual(3);
    state.running = undefined;
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.events("progress")).toBe(before);
    s.close();
  });

  it("sends no progress after the first successful sync", async () => {
    state.last = { at: Date.now(), generation: 1 } as never;
    const s = open();
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.events("progress")).toBe(0);
    s.close();
  });
});
