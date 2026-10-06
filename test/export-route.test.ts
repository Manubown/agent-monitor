import { beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/store/db";

// The route reads the process-wide state of app/lib/server.ts. Seed it before the import with an empty in-memory
// database and a finished "sync", so `ready()` never scans the real log folders or opens the search index.
let GET: (request: Request) => Promise<Response>;
beforeAll(async () => {
  globalThis.__agentMonitor = { db: openDb(":memory:"), last: { at: Date.now() } as never, indexError: "not used in tests" };
  ({ GET } = await import("../app/api/export/route"));
});

const get = (query: string) => GET(new Request(`http://127.0.0.1:4100/api/export?${query}`));
const SAFE_DISPOSITION = /^attachment; filename="[a-z0-9.-]{1,100}"$/;

describe("GET /api/export validation", () => {
  it("rejects views that are only Object.prototype members", async () => {
    for (const view of ["constructor", "__proto__", "toString", "hasOwnProperty", "nope"]) {
      const res = await get(`view=${encodeURIComponent(view)}`);
      expect(res.status, view).toBe(400);
      expect(await res.text()).toContain("Unknown view");
    }
  });

  it("rejects unknown formats, including prototype keys", async () => {
    for (const format of ["xml", "constructor", "__proto__"]) {
      const res = await get(`view=daily&format=${format}`);
      expect(res.status, format).toBe(400);
    }
  });

  it("defaults view and format, and an empty format means csv", async () => {
    const res = await get("format=");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect((await res.text()).split("\n")[0]).toMatch(/^id,source,title,/);
  });

  it("slugs every filter that goes into the file name", async () => {
    const query = new URLSearchParams({
      view: "models",
      format: "json",
      source: 'evil"\r\nX-Injected: 1',
      project: "C:\\Users\\me\\My Project",
      tag: "../../x",
      q: "a".repeat(500),
    });
    const res = await get(String(query));
    expect(res.status).toBe(200);
    const disposition = res.headers.get("Content-Disposition") ?? "";
    expect(disposition).toMatch(SAFE_DISPOSITION);
    expect(disposition).toContain("agent-monitor-models-30d-evil-x-injected-1-my-project-tag-x-q-");
    expect(disposition.endsWith('.json"')).toBe(true);
    expect(res.headers.get("X-Injected")).toBeNull();
    expect(JSON.parse(await res.text())).toEqual([]);
  });

  it("uses the first of repeated parameters, like the pages", async () => {
    const res = await get("view=daily&view=constructor&format=json&format=xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="agent-monitor-daily-30d-/);
  });
});

describe("GET /api/export?view=gource", () => {
  it("needs a session or a project", async () => {
    expect((await get("view=gource")).status).toBe(400);
    expect((await get("view=gource&session=")).status).toBe(400);
  });

  it("404s for an unknown session", async () => {
    expect((await get("view=gource&session=nope")).status).toBe(404);
  });

  it("slugs the project and filters into the file name", async () => {
    const res = await get(String(new URLSearchParams({ view: "gource", project: '/home/me/we"ird\nname', source: "x\r\ny", range: "constructor", reads: "1" })));
    expect(res.status).toBe(200);
    const disposition = res.headers.get("Content-Disposition") ?? "";
    expect(disposition).toMatch(SAFE_DISPOSITION);
    expect(disposition).toMatch(/^attachment; filename="agent-monitor-gource-we-ird-name-30d-x-y-reads-\d{4}-\d{2}-\d{2}\.log"$/);
  });
});
