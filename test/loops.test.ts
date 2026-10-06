import { describe, expect, it } from "vitest";
import { detectLoops, type LoopEvent, loopReason, normalizeCommand } from "../src/core/loops";
import { DEFAULT_PRICES } from "../src/core/pricing";
import type { AgentEvent, ParsedSession } from "../src/core/types";
import { writeSession } from "../src/ingest/sync";
import { sessionActivity } from "../src/store/activity";
import { openDb } from "../src/store/db";
import { sessionLoops } from "../src/store/loops";

const T = Date.UTC(2026, 9, 1, 12);

type Ev = Omit<AgentEvent, "ts"> & { ts?: number };

const call = (toolName: string, input: unknown, toolCallId?: string): Ev => ({ kind: "tool_call", toolName, toolInput: JSON.stringify(input), toolCallId });
const sh = (command: string) => call("bash", { command });
const edit = (file: string) => call("Edit", { file_path: file, old_string: "a", new_string: "b" });
const ok: Ev = { kind: "tool_result" };
const fail: Ev = { kind: "tool_result", isError: true };

/** Events one second apart; `seq` is the position. */
const events = (list: Ev[]): (LoopEvent & AgentEvent)[] => list.map((e, i) => ({ ...e, ts: e.ts ?? T + i * 1000 }));
const loops = (list: Ev[]) => detectLoops(events(list), "/work/app");

/** `list` repeated `n` times. */
const times = (n: number, list: Ev[]): Ev[] => Array.from({ length: n }, () => list).flat();
/** `n` rounds of: edit the file, run the tests, tests fail. */
const editFailCycles = (n: number, file = "src/a.ts") => times(n, [edit(file), ok, sh("pnpm test"), fail]);

describe("edit loops", () => {
  it("needs five edits of one file, at least two of them right after a failure", () => {
    // edit → fail → edit … four times: 4 edits, 3 after a failure.
    expect(loops(editFailCycles(4)).filter((l) => l.kind === "edit")).toEqual([]);
    const five = loops(editFailCycles(5)).filter((l) => l.kind === "edit");
    expect(five).toEqual([
      { kind: "edit", subject: "/work/app/src/a.ts", count: 5, failures: 4, firstSeq: 0, lastSeq: 16, firstTs: T, lastTs: T + 16_000, seqs: [0, 4, 8, 12, 16] },
    ]);
  });

  it("ignores many edits without failures in between, and needs two cycles", () => {
    expect(loops(Array.from({ length: 8 }, () => [edit("src/a.ts"), ok]).flat())).toEqual([]);
    // One failure among five edits is one cycle.
    expect(loops([edit("src/a.ts"), ok, sh("pnpm lint"), fail, ...Array.from({ length: 4 }, () => [edit("src/a.ts"), ok]).flat()])).toEqual([]);
  });

  it("counts a failed edit as the failure before the next edit", () => {
    const list = [edit("src/a.ts"), fail, edit("src/a.ts"), fail, edit("src/a.ts"), ok, edit("src/a.ts"), ok, edit("src/a.ts"), ok];
    expect(loops(list).find((l) => l.kind === "edit")).toMatchObject({ count: 5, failures: 2 });
  });

  it("keeps files apart and counts writes", () => {
    const list = [...editFailCycles(3, "src/a.ts"), ...editFailCycles(3, "src/b.ts"), call("Write", { file_path: "src/a.ts", content: "x" }), ok, sh("pnpm test"), fail];
    expect(loops(list).filter((l) => l.kind === "edit")).toEqual([]);
    const more = [...list, edit("/work/app/src/a.ts"), ok];
    expect(loops(more).filter((l) => l.kind === "edit")).toMatchObject([{ subject: "/work/app/src/a.ts", count: 5 }]);
  });
});

describe("command loops", () => {
  it("fires on three failures of the same command in a row, not two", () => {
    expect(loops([sh("pnpm test"), fail, sh("pnpm test"), fail])).toEqual([]);
    expect(loops([sh("pnpm test"), fail, sh("pnpm test"), fail, sh("pnpm test"), fail])).toMatchObject([
      { kind: "command", subject: "pnpm test", count: 3, failures: 3, firstSeq: 0, lastSeq: 4, seqs: [0, 2, 4] },
    ]);
  });

  it("a success of the same command ends the streak; other commands do not", () => {
    const fixed = [sh("pnpm test"), fail, sh("pnpm test"), fail, sh("pnpm test"), ok, sh("pnpm test"), fail, sh("pnpm test"), fail];
    expect(loops(fixed)).toEqual([]);
    const other = [sh("pnpm test"), fail, sh("git status"), ok, sh("pnpm test"), fail, call("Read", { file_path: "a.ts" }), ok, sh("pnpm test"), fail];
    expect(loops(other)).toMatchObject([{ kind: "command", subject: "pnpm test", count: 3 }]);
    // Two separate streaks are two loops.
    const twice = [...times(3, [sh("pnpm build"), fail]), sh("pnpm build"), ok, ...times(3, [sh("pnpm build"), fail])];
    expect(loops(twice).map((l) => [l.subject, l.count, l.firstSeq])).toEqual([
      ["pnpm build", 3, 0],
      ["pnpm build", 3, 8],
    ]);
  });

  it("treats spelling variants of one command as the same command", () => {
    const list = [sh("pnpm test"), fail, sh("cd /work/app && CI=1 pnpm  test 2>&1 | tail -40"), fail, call("shell", { command: ["bash", "-lc", "timeout 120 pnpm test"] }), fail];
    expect(loops(list)).toMatchObject([{ kind: "command", subject: "pnpm test", count: 3 }]);
    expect(loops([sh("pnpm test a"), fail, sh("pnpm test b"), fail, sh("pnpm test a"), fail])).toEqual([]);
  });

  it("ignores calls whose result never arrived", () => {
    expect(loops([sh("pnpm test"), fail, sh("pnpm test"), sh("pnpm test"), fail])).toEqual([]);
    expect(loops([sh("pnpm test"), fail, sh("pnpm test"), fail, sh("pnpm test"), sh("pnpm test"), fail])).toMatchObject([{ count: 3, seqs: [0, 2, 5] }]);
  });

  it("pairs results by call id", () => {
    // Two calls in flight; the results arrive in reverse order.
    const list = [
      call("bash", { command: "pnpm test" }, "a"),
      call("bash", { command: "pnpm lint" }, "b"),
      { ...ok, toolCallId: "b" },
      { ...fail, toolCallId: "a" },
    ];
    expect(loops([...list, ...list, ...list].map((e, i) => (e.toolCallId ? { ...e, toolCallId: `${e.toolCallId}${Math.floor(i / 4)}` } : e)))).toMatchObject([
      { kind: "command", subject: "pnpm test", count: 3 },
    ]);
  });
});

describe("repeated failed calls", () => {
  it("fires on three identical failed calls of a non-shell tool", () => {
    const read = call("Read", { file_path: "src/missing.ts" });
    expect(loops([read, fail, read, fail])).toEqual([]);
    expect(loops([read, fail, read, fail, read, fail])).toMatchObject([{ kind: "call", subject: "Read src/missing.ts", count: 3 }]);
    // Different arguments are different calls.
    expect(loops([read, fail, call("Read", { file_path: "src/other.ts" }), fail, read, fail])).toEqual([]);
  });

  it("does not report a failing shell command twice", () => {
    expect(loops(times(3, [sh("make"), fail])).map((l) => l.kind)).toEqual(["command"]);
  });
});

describe("normalizeCommand", () => {
  it("drops setup commands, wrappers, redirections and later pipeline stages", () => {
    expect(normalizeCommand("cd app && pnpm test")).toBe("pnpm test");
    expect(normalizeCommand("export CI=1; sudo env FOO=1 pnpm test 2>&1 | tee out.log")).toBe("pnpm test");
    expect(normalizeCommand("env FOO=1 time pnpm test > /dev/null")).toBe("pnpm test");
    expect(normalizeCommand("timeout 60 ./node_modules/.bin/vitest run 'test/a.test.ts' &")).toBe("vitest run test/a.test.ts");
    expect(normalizeCommand("pnpm build && pnpm test")).toBe("pnpm build && pnpm test");
  });

  it("drops here-document bodies and falls back to the script when nothing is left", () => {
    expect(normalizeCommand("cat > /tmp/x.sql <<'EOF'\nselect 1;\nEOF\nsqlite3 db.sqlite < /tmp/x.sql")).toBe("cat && sqlite3 db.sqlite");
    expect(normalizeCommand("echo  hi")).toBe("echo hi");
  });
});

describe("loopReason", () => {
  it("names the biggest loops, paths relative to the working directory, repeated streaks summed", () => {
    const list = [
      ...editFailCycles(9),
      ...times(3, [sh("pnpm lint"), fail]),
      sh("pnpm lint"),
      ok,
      ...times(3, [sh("pnpm lint"), fail]),
    ];
    expect(loopReason(loops(list), "/work/app")).toBe("src/a.ts edited 9 times; `pnpm test` failed 9 times; `pnpm lint` failed 6 times");
  });

  it("clips long subjects and counts the rest", () => {
    const long = `node scripts/${"x".repeat(80)}.js`;
    const list = [...times(3, [sh(long), fail]), ...["a", "b", "c"].flatMap((n) => times(3, [sh(`make ${n}`), fail]))];
    expect(loopReason(loops(list))).toBe(`\`${long.slice(0, 59)}…\` failed 3 times; \`make a\` failed 3 times; \`make b\` failed 3 times; 1 more`);
  });
});

describe("sessionLoops", () => {
  it("detects loops per agent of the tree and links edit loops to the file list", () => {
    const db = openDb(":memory:");
    const session = (nativeId: string, list: Ev[], parentNativeId?: string): ParsedSession => {
      const evs = events(list);
      return { source: "omp", nativeId, parentNativeId, cwd: "/work/app", startedAt: T, endedAt: evs.at(-1)?.ts ?? T, events: evs, usage: [] };
    };
    writeSession(db, "/logs/root.jsonl", session("root", [call("task", { tasks: [{ name: "fix" }] }), ok, ...times(3, [sh("pnpm test"), fail])]), DEFAULT_PRICES);
    writeSession(db, "/logs/fix.jsonl", session("fix", [call("Read", { file_path: "src/b.ts" }), ok, ...editFailCycles(5)], "root"), DEFAULT_PRICES);

    const activity = sessionActivity(db, "omp:root", "/home/me");
    if (!activity) throw new Error("no activity");
    const found = sessionLoops(db, activity, "/home/me");
    expect(found.map((l) => [l.kind, l.subject, l.agent, l.count])).toEqual([
      ["command", "pnpm test", 0, 3],
      ["edit", "src/a.ts", 1, 5],
      ["command", "pnpm test", 1, 5],
    ]);
    const editLoop = found.find((l) => l.kind === "edit");
    expect(editLoop?.file).not.toBeNull();
    expect(activity.files[editLoop?.file ?? -1].path).toBe("src/a.ts");
    expect(found.every((l) => l.kind === "edit" || l.file === null)).toBe(true);
  });
});
