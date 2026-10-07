import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code";
import { codexAdapter } from "../src/adapters/codex";
import { ompAdapter } from "../src/adapters/omp";
import { parseLog } from "../src/core/adapter";
import type { ParsedSession } from "../src/core/types";

const fixture = (rel: string) => {
  const file = path.join(__dirname, "fixtures", rel);
  return [file, fs.readFileSync(file, "utf8")] as const;
};

const kinds = (s: ParsedSession) => s.events.map((e) => e.kind);

describe("omp adapter", () => {
  const s = parseLog(ompAdapter, ...fixture("omp/-proj/2026-10-01T09-00-00-000Z_aaa111.jsonl"))!;

  it("reads session metadata, preferring the rewritten title line", () => {
    expect(s).toMatchObject({ source: "omp", nativeId: "aaa111", title: "Fix login bug", cwd: "/work/proj" });
    expect(s.parentNativeId).toBeUndefined();
    expect(s.startedAt).toBe(Date.parse("2026-10-01T09:00:00.000Z"));
    expect(s.endedAt).toBe(Date.parse("2026-10-01T09:00:25.000Z"));
  });

  it("maps messages to timeline events and skips the half-written last line", () => {
    expect(kinds(s)).toEqual(["user", "thinking", "tool_call", "tool_result", "system", "tool_call", "assistant", "error"]);
    const call = s.events[2];
    expect(call).toMatchObject({ toolName: "read", toolCallId: "call_1", toolInput: '{"path":"src/login.ts"}' });
    expect(s.events[3]).toMatchObject({ toolName: "read", isError: true, text: "ENOENT: no such file" });
    expect(s.events[7].text).toBe("overloaded_error");
  });

  it("keeps the cost omp recorded and the 1h cache-write split", () => {
    expect(s.usage).toHaveLength(3);
    expect(s.usage[0]).toMatchObject({
      model: "claude-opus-5-5",
      usage: { input: 4, output: 100, cacheRead: 0, cacheWrite: 20000 },
      cacheWrite1h: 20000,
      reportedCostUsd: 0.162016,
    });
  });

  it("links subagent runs to their parent and names them after the task file", () => {
    const sub = parseLog(ompAdapter, ...fixture("omp/-proj/2026-10-01T09-00-00-000Z_aaa111/Research.jsonl"))!;
    expect(sub).toMatchObject({ nativeId: "bbb222", parentNativeId: "aaa111", title: "Research", dispatchIndex: 0 });
    expect(sub.events[0].text).toBe("research the auth library");
    // A prompt written by the parent agent is not a human prompt.
    expect(kinds(sub)).toEqual(["system", "assistant"]);
    expect(sub.usage[0].model).toBe("claude-sonnet-5-5");
  });

  it("returns null for a file without a session", () => {
    expect(parseLog(ompAdapter, "/x/empty.jsonl", "")).toBeNull();
  });
});

describe("claude-code adapter", () => {
  const s = parseLog(claudeCodeAdapter, ...fixture("claude-code/-proj/sess-1.jsonl"))!;

  it("reads metadata and the AI-generated title", () => {
    expect(s).toMatchObject({
      source: "claude-code",
      nativeId: "sess-1",
      title: "Dark mode toggle",
      cwd: "/work/other",
      gitBranch: "main",
      agentVersion: "2.1.288",
    });
  });

  it("separates typed prompts from harness-injected text and drops empty thinking", () => {
    expect(kinds(s)).toEqual(["system", "system", "user", "tool_call", "tool_result", "assistant", "error"]);
    expect(s.events[2].text).toBe("Add a dark mode toggle");
    expect(s.events[4]).toMatchObject({ toolName: "Bash", toolCallId: "toolu_1", isError: true });
    expect(s.events[6]).toMatchObject({ kind: "error", text: "API Error: 529 overloaded" });
  });

  it("counts each API response once although it spans several lines", () => {
    expect(s.usage).toHaveLength(2);
    expect(s.usage[0]).toMatchObject({
      ts: Date.parse("2026-10-02T10:00:03.000Z"),
      usage: { input: 3, output: 200, cacheRead: 5000, cacheWrite: 1000, reasoning: 80 },
      cacheWrite1h: 1000,
    });
    expect(s.usage[0].reportedCostUsd).toBeUndefined();
  });

  it("identifies subagent transcripts by path", () => {
    const sub = parseLog(claudeCodeAdapter, ...fixture("claude-code/-proj/sess-1/subagents/agent-xyz.jsonl"))!;
    expect(sub).toMatchObject({ nativeId: "sess-1/agent-xyz", parentNativeId: "sess-1", title: "Find the theme file", dispatchIndex: 0 });
    expect(kinds(sub)).toEqual(["system", "assistant"]);
    expect(sub.usage[0].model).toBe("claude-haiku-4-5-20251001");
  });
});

describe("codex adapter", () => {
  const s = parseLog(codexAdapter, ...fixture("codex/2026/10/01/rollout-2026-10-01T12-00-00-ccc333.jsonl"))!;

  it("reads session_meta and turn_context", () => {
    expect(s).toMatchObject({ source: "codex", nativeId: "ccc333", cwd: "/work/proj", gitBranch: "feat/x", agentVersion: "0.50.0", title: "Run the tests" });
  });

  it("maps response items, flags failing commands and ignores duplicate user_message events", () => {
    expect(kinds(s)).toEqual(["system", "user", "thinking", "tool_call", "tool_result", "assistant", "error"]);
    expect(s.events[3]).toMatchObject({ toolName: "shell", toolCallId: "call_a" });
    expect(s.events[4]).toMatchObject({ toolName: "shell", isError: true, text: "1 failing" });
  });

  it("turns cumulative token counts into per-request usage, cached tokens split out", () => {
    expect(s.usage).toHaveLength(2);
    expect(s.usage[0]).toMatchObject({ model: "gpt-5-codex", usage: { input: 5000, cacheRead: 0, output: 300, reasoning: 200, cacheWrite: 0 } });
    expect(s.usage[1].usage).toEqual({ input: 1200, cacheRead: 4800, output: 50, reasoning: 20, cacheWrite: 0 });
  });
});

describe("codex adapter, legacy rollouts", () => {
  // Codex CLI 2025 rollouts: a bare session meta line, then bare response items and state snapshots, no timestamps.
  const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const s = parseLog(codexAdapter, ...fixture(`codex-legacy/rollout-2025-06-01T10-00-00-${ID}.jsonl`))!;
  const start = Date.parse("2025-06-01T10:00:00.000Z");

  it("reads the bare meta line, and the working directory from the environment context", () => {
    expect(s).toMatchObject({ source: "codex", nativeId: ID, gitBranch: "legacy/main", cwd: "/work/legacy", title: "List the source files" });
    expect(s.startedAt).toBe(start);
    expect(s.endedAt).toBe(start);
  });

  it("maps bare response items in file order, all at the meta timestamp, and skips the half-written last line", () => {
    expect(kinds(s)).toEqual(["system", "user", "thinking", "tool_call", "tool_result", "tool_call", "tool_result", "assistant"]);
    expect(s.events.every((e) => e.ts === start)).toBe(true);
    expect(s.events[3]).toMatchObject({ toolName: "shell", toolCallId: "call_legacy_1", toolInput: '{"command":["ls","src"]}' });
    expect(s.events[4]).toMatchObject({ toolName: "shell", isError: false, text: "a.ts\nb.ts\n" });
    expect(s.events[6]).toMatchObject({ toolName: "shell", isError: true });
    expect(s.usage).toEqual([]);
  });

  it("reports a file with lines in no known shape instead of storing an empty session", () => {
    expect(() => parseLog(codexAdapter, "/r/rollout-x.jsonl", '{"foo":1}\n{"bar":[2]}\n')).toThrow(/Unrecognized Codex rollout/);
    // Nothing complete yet (a rollout being created) is no session, not an error.
    expect(parseLog(codexAdapter, "/r/rollout-x.jsonl", "")).toBeNull();
    expect(parseLog(codexAdapter, "/r/rollout-x.jsonl", '{"timestamp":"2026-10-01T12:00:00.000Z","type":"session_me')).toBeNull();
    // Only state snapshots: a legacy rollout without content.
    expect(parseLog(codexAdapter, "/r/rollout-x.jsonl", '{"record_type":"state"}\n')).toBeNull();
  });
});
