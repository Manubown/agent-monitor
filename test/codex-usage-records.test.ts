import { describe, expect, it } from "vitest";
import { codexAdapter } from "../src/adapters/codex";
import { parseLog } from "../src/core/adapter";

/** Codex 0.160+ rollouts: a `token_usage_record` per model response, then the `token_count` with the new running total. */

const ID = "44444444-4444-7444-8444-444444444444";
const jsonl = (lines: object[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join("");
const at = (s: number) => `2026-10-05T12:00:${String(s).padStart(2, "0")}.000Z`;

interface Tokens {
  input: number;
  cached?: number;
  write?: number;
  output: number;
  reasoning?: number;
}
const wire = (t: Tokens) => ({
  input_tokens: t.input,
  cached_input_tokens: t.cached ?? 0,
  cache_write_input_tokens: t.write ?? 0,
  output_tokens: t.output,
  reasoning_output_tokens: t.reasoning ?? 0,
  total_tokens: t.input + t.output,
});

const head = (id = ID) => [
  { timestamp: at(0), type: "session_meta", payload: { id, timestamp: at(0), cwd: "/work/p", cli_version: "0.160.0" } },
  { timestamp: at(1), type: "turn_context", payload: { cwd: "/work/p", model: "gpt-5.5" } },
];
const record = (s: number, responseId: string, last: Tokens, total: Tokens, thread = ID) => ({
  timestamp: at(s),
  type: "token_usage_record",
  payload: { thread_id: thread, session_id: thread, turn_id: "t", root_turn_id: "t", response_id: responseId, usage: wire(last), turn_token_usage: wire(last), thread_token_usage: wire(total) },
});
const count = (s: number, last: Tokens, total: Tokens) => ({
  timestamp: at(s),
  type: "event_msg",
  payload: { type: "token_count", info: { total_token_usage: wire(total), last_token_usage: wire(last), model_context_window: 258400 } },
});

const R1 = { input: 1000, cached: 600, write: 100, output: 50, reasoning: 10 };
const T1 = R1;
const R2 = { input: 2000, cached: 1500, output: 80 };
const T2 = { input: 3000, cached: 2100, write: 100, output: 130, reasoning: 10 };

const parse = (lines: object[]) => parseLog(codexAdapter, `/r/rollout-2026-10-05T12-00-00-${ID}.jsonl`, jsonl(lines))!;

describe("codex token_usage_record", () => {
  it("counts one request per record, keyed by response id, with cache reads and writes out of input", () => {
    const s = parse([...head(), record(2, "resp_1", R1, T1), count(3, R1, T1), record(4, "resp_2", R2, T2), count(5, R2, T2)]);
    expect(s.usage).toEqual([
      { ts: Date.parse(at(2)), model: "gpt-5.5", usage: { input: 300, cacheRead: 600, cacheWrite: 100, output: 50, reasoning: 10 }, requestId: "codex:resp_1" },
      { ts: Date.parse(at(4)), model: "gpt-5.5", usage: { input: 500, cacheRead: 1500, cacheWrite: 0, output: 80, reasoning: 0 }, requestId: "codex:resp_2" },
    ]);
  });

  it("lets a record replace the request its token_count already counted when it comes second", () => {
    const s = parse([...head(), count(2, R1, T1), record(3, "resp_1", R1, T1), count(4, R2, T2), record(5, "resp_2", R2, T2)]);
    expect(s.usage.map((u) => u.requestId)).toEqual(["codex:resp_1", "codex:resp_2"]);
  });

  it("keeps token_count usage from before the CLI started writing records, without double counting after", () => {
    const s = parse([...head(), count(2, R1, T1), record(4, "resp_2", R2, T2), count(5, R2, T2)]);
    expect(s.usage).toHaveLength(2);
    expect(s.usage[0].requestId).toMatch(/^codex:[0-9a-f]{40}$/);
    expect(s.usage[1]).toMatchObject({ requestId: "codex:resp_2", usage: { input: 500, cacheRead: 1500, output: 80 } });
  });

  it("counts a record whose token_count never arrived", () => {
    const s = parse([...head(), record(2, "resp_1", R1, T1)]);
    expect(s.usage).toHaveLength(1);
    expect(s.usage[0].usage.cacheWrite).toBe(100);
  });

  it("gives a fork's replayed records the parent's request ids", () => {
    const parentId = "55555555-5555-7555-8555-555555555555";
    const own = { input: 5000, cached: 3000, output: 40 };
    const ownTotal = { input: 8000, cached: 5100, write: 100, output: 170, reasoning: 10 };
    const s = parse([
      ...head(),
      // The parent's lines, replayed with fresh timestamps.
      ...head(parentId).map((l) => ({ ...l, timestamp: at(1) })),
      record(1, "resp_1", R1, T1, parentId),
      count(1, R1, T1),
      record(1, "resp_2", R2, T2, parentId),
      count(1, R2, T2),
      record(8, "resp_3", own, ownTotal),
      count(9, own, ownTotal),
    ]);
    expect(s.nativeId).toBe(ID);
    // Storage drops resp_1 and resp_2 here because the parent session holds them.
    expect(s.usage.map((u) => u.requestId)).toEqual(["codex:resp_1", "codex:resp_2", "codex:resp_3"]);
  });
});
