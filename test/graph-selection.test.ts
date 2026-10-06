import { describe, expect, it } from "vitest";
import { actionKey, agentIndex, agentKey, catalogKeys, changes, indexOf, isChanged, nodeKey, requestKeys, resolveSelection, uniqueKeys } from "../app/components/graph/selection";
import type { ActivityFile } from "../src/store/activity";

const file = (path: string, actions: number[], changes = 0): ActivityFile => {
  const slash = path.lastIndexOf("/");
  return { path, dir: slash === -1 ? "" : path.slice(0, slash), reads: 1, writes: changes, edits: 0, deletes: 0, moves: 0, first: 0, last: 0, agents: [], actions };
};

const agents = [
  { id: "claude:root", title: "Root" },
  { id: "claude:sub-a", title: "Sub A" },
];

describe("selection keys", () => {
  it("finds agents by session id", () => {
    expect(agentIndex(agents, "claude:sub-a")).toBe(1);
    expect(agentIndex(agents, "claude:gone")).toBeNull();
    expect(agentIndex(agents, null)).toBeNull();
    expect(agentKey(agents, 1)).toBe("a:claude:sub-a");
    expect(actionKey(agents, { agent: 1, seq: 7 })).toBe("claude:sub-a\n7");
  });

  it("makes repeated keys unique without touching the first", () => {
    expect(uniqueKeys(["x", "y", "x", "x"])).toEqual(["x", "y", "x\n#2", "x\n#3"]);
  });

  it("never hands out a suffixed key that is already taken", () => {
    const keys = uniqueKeys(["x", "x", "x\n#2"]);
    expect(new Set(keys).size).toBe(3);
    expect(keys).toEqual(["x", "x\n#3", "x\n#2"]);
    const many = uniqueKeys(["a", "a\n#2", "a", "a", "a\n#3", "a\n#2"]);
    expect(new Set(many).size).toBe(many.length);
  });

  it("keys catalog nodes by path, spawned agent id, or kind and resource key", () => {
    const keys = catalogKeys(
      [{ path: "src/a.ts" }],
      [
        { kind: "command", key: "git status" },
        { kind: "agent", key: "claude:sub-a", agent: 1 },
        { kind: "agent", key: "?Same title" },
        { kind: "command", key: "git status --short" },
      ],
      agents,
    );
    expect(keys).toEqual(["file\nsrc/a.ts", "command\ngit status", "agent\n#claude:sub-a", "agent\n?Same title", "command\ngit status --short"]);
    expect(indexOf(keys).get("agent\n#claude:sub-a")).toBe(2);
  });

  it("tells resources with the same clipped label apart by their key", () => {
    // Two long commands whose labels clip to the same text keep their own keys, whatever order a refresh lists them in.
    const a = { kind: "command" as const, key: "pnpm exec vitest run test/a.test.ts" };
    const b = { kind: "command" as const, key: "pnpm exec vitest run test/b.test.ts" };
    const before = catalogKeys([], [a, b], agents);
    const after = catalogKeys([], [b, a], agents);
    expect(new Set(before).size).toBe(2);
    expect(after).toEqual([before[1], before[0]]);
  });

  it("keeps catalog keys when a refresh inserts a file or resource before them", () => {
    const before = catalogKeys([{ path: "b.ts" }], [{ kind: "web", key: "https://example.com/x" }], agents);
    const after = catalogKeys([{ path: "a.ts" }, { path: "b.ts" }], [{ kind: "command", key: "ls" }, { kind: "web", key: "https://example.com/x" }], agents);
    const at = indexOf(after);
    expect(before.map((k) => at.get(k))).toEqual([1, 3]);
  });

  it("keys model requests uniquely, also when they share an anchor event or have none", () => {
    const requests = [
      { agent: 0, seq: 4, ts: 100 },
      { agent: 0, seq: 4, ts: 110 },
      { agent: 0, seq: null, ts: 200 },
      { agent: 0, seq: null, ts: 200 },
      { agent: 1, seq: 4, ts: 100 },
    ];
    const keys = requestKeys(agents, requests);
    expect(new Set(keys).size).toBe(requests.length);
    expect(keys[0]).toBe("a:claude:root\nr4");
    // A request appended by a refresh leaves the earlier keys alone.
    expect(requestKeys(agents, [...requests.slice(0, 4), { agent: 0, seq: 9, ts: 300 }, requests[4]])).toEqual([...keys.slice(0, 4), "a:claude:root\nr9", keys[4]]);
  });

  it("counts changes the same way for every graph", () => {
    expect(changes({ reads: 5, writes: 1, edits: 2, deletes: 0, moves: 1 })).toBe(4);
    expect(isChanged({ reads: 5, writes: 0, edits: 0, deletes: 0, moves: 0 })).toBe(false);
    expect(isChanged({ reads: 0, writes: 0, edits: 0, deletes: 1, moves: 0 })).toBe(true);
  });
});

describe("resolveSelection", () => {
  const files = [file("src/a.ts", [0, 2], 1), file("src/b.ts", [1]), file("README.md", [3])];
  const actions = [{ agent: 0 }, { agent: 1 }, { agent: 1 }, { agent: 0 }];
  const data = { agents, actions, files };

  it("resolves files, directories, read-only files and agents to their calls", () => {
    expect(resolveSelection(nodeKey.file("src/b.ts"), data)).toEqual({ kind: "files", files: [1], label: "src/b.ts", actions: [1] });
    expect(resolveSelection(nodeKey.dir("src"), data)).toMatchObject({ files: [0, 1], label: "src", actions: [0, 2, 1] });
    expect(resolveSelection(nodeKey.reads("src"), data)).toMatchObject({ files: [1], label: "read-only files in src" });
    expect(resolveSelection(nodeKey.dir(""), data)).toMatchObject({ files: [2], label: "./" });
    expect(resolveSelection("a:claude:sub-a", data)).toEqual({ kind: "agent", agent: 1, label: "Sub A", actions: [1, 2] });
  });

  it("follows the key to its new index after a refresh shifts the arrays", () => {
    const refreshed = {
      agents: [agents[0], { id: "claude:new", title: "New" }, agents[1]],
      actions: [{ agent: 0 }, { agent: 1 }, { agent: 2 }, { agent: 2 }, { agent: 0 }],
      files: [file("src/new.ts", [1]), file("src/a.ts", [0, 3], 1), file("src/b.ts", [2]), file("README.md", [4])],
    };
    expect(resolveSelection(nodeKey.file("src/b.ts"), refreshed)).toMatchObject({ files: [2], actions: [2] });
    expect(resolveSelection("a:claude:sub-a", refreshed)).toMatchObject({ agent: 2, actions: [2, 3] });
  });

  it("is null once the key matches nothing", () => {
    expect(resolveSelection(nodeKey.file("gone.ts"), data)).toBeNull();
    expect(resolveSelection(nodeKey.dir("lib"), data)).toBeNull();
    expect(resolveSelection(nodeKey.reads("."), data)).toBeNull();
    expect(resolveSelection("a:claude:gone", data)).toBeNull();
    expect(resolveSelection("x:whatever", data)).toBeNull();
  });
});
