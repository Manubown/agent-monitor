import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PRICES } from "../src/core/pricing";
import { syncAll } from "../src/ingest/sync";
import { openDb } from "../src/store/db";
import { getSession } from "../src/store/queries";

const LEGACY = "rollout-2025-06-01T10-00-00-0f0e0d0c-0b0a-4908-8706-050403020100.jsonl";

describe("sync of Codex rollouts", () => {
  let root = "";
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("stores a legacy rollout and reports one in an unknown format", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-monitor-codex-legacy-"));
    const dir = path.join(root, "codex", "2025", "06", "01");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, "fixtures", "codex-legacy", LEGACY), path.join(dir, LEGACY));
    const unknown = path.join(dir, "rollout-2025-06-01T11-00-00-unknown.jsonl");
    fs.writeFileSync(unknown, '{"foo":1}\n');
    const env = {
      HOME: root,
      AGENT_MONITOR_OMP_DIRS: path.join(root, "omp"),
      AGENT_MONITOR_CLAUDE_CODE_DIRS: path.join(root, "claude-code"),
      AGENT_MONITOR_CODEX_DIRS: path.join(root, "codex"),
    };
    const db = openDb(":memory:");
    const r = await syncAll(db, { env, prices: DEFAULT_PRICES });
    expect(r.sessions).toBe(1);
    expect(r.errors).toEqual([{ path: unknown, error: expect.stringMatching(/Unrecognized Codex rollout/) }]);
    expect(getSession(db, "codex:0f0e0d0c-0b0a-4908-8706-050403020100")?.session).toMatchObject({ cwd: "/work/legacy", toolCalls: 2 });
  });
});
