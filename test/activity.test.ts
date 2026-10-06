import { describe, expect, it } from "vitest";
import { fileOps } from "../src/core/activity";

const json = (v: unknown) => JSON.stringify(v);

describe("fileOps", () => {
  it("reads Claude Code file tools", () => {
    expect(fileOps("Read", json({ file_path: "/w/app/a.ts" }))).toEqual([{ op: "read", path: "/w/app/a.ts" }]);
    expect(fileOps("Write", json({ file_path: "/w/b.md", content: "x" }))).toEqual([{ op: "write", path: "/w/b.md" }]);
    // Stored input is clipped, so large writes are not valid JSON any more.
    expect(fileOps("Write", `${json({ file_path: "/w/big.ts", content: "y".repeat(50) }).slice(0, 40)}\n… [truncated 99 chars]`)).toEqual([
      { op: "write", path: "/w/big.ts" },
    ]);
    expect(fileOps("Edit", json({ file_path: "/w/c.ts", old_string: "a", new_string: "b" }))).toEqual([{ op: "edit", path: "/w/c.ts" }]);
    expect(fileOps("NotebookEdit", json({ notebook_path: "/w/n.ipynb" }))).toEqual([{ op: "edit", path: "/w/n.ipynb" }]);
  });

  it("resolves omp's relative paths against the session directory and drops selectors", () => {
    expect(fileOps("read", json({ path: "src/store/queries.ts:316-324" }), "/w")).toEqual([{ op: "read", path: "/w/src/store/queries.ts" }]);
    expect(fileOps("read", json({ path: "README.md:raw" }), "/w")).toEqual([{ op: "read", path: "/w/README.md" }]);
    expect(fileOps("read", json({ path: "agent://RustSearch" }), "/w")).toEqual([]);
    expect(fileOps("grep", json({ pattern: "x", path: "src/a.ts;app/b" }), "/w")).toEqual([
      { op: "search", path: "/w/src/a.ts" },
      { op: "search", path: "/w/app/b" },
    ]);
  });

  it("splits omp multi-file edits and recognizes deletes and moves", () => {
    const input = "[src/a.ts#1A2B]\nPUT 1.=1:\n+x\n[old.ts#3C4D]\nREM\n[src/b.ts#ABCD]\nPUT 2.=2:\n+y\nMV src/c.ts";
    expect(fileOps("edit", json({ i: "x", input }), "/w")).toEqual([
      { op: "edit", path: "/w/src/a.ts" },
      { op: "delete", path: "/w/old.ts" },
      { op: "move", path: "/w/src/b.ts", to: "/w/src/c.ts" },
    ]);
  });

  it("reads Codex patches, also when sent through the shell", () => {
    const patch = "*** Begin Patch\n*** Add File: new.ts\n+x\n*** Update File: src/a.ts\n*** Move to: src/z.ts\n@@\n*** Delete File: gone.ts\n*** End Patch";
    const expected = [
      { op: "write", path: "/w/new.ts" },
      { op: "move", path: "/w/src/a.ts", to: "/w/src/z.ts" },
      { op: "delete", path: "/w/gone.ts" },
    ];
    expect(fileOps("apply_patch", json({ input: patch }), "/w")).toEqual(expected);
    expect(fileOps("shell", json({ command: ["apply_patch", patch] }), "/w")).toEqual(expected);
  });

  it("reads Windows paths in slash form, relative ones against a Windows working directory", () => {
    expect(fileOps("Read", json({ file_path: "c:\\w\\app\\a.ts" }))).toEqual([{ op: "read", path: "C:/w/app/a.ts" }]);
    expect(fileOps("read", json({ path: "src\\a.ts:10-20" }), "C:\\w")).toEqual([{ op: "read", path: "C:/w/src/a.ts" }]);
    const patch = "*** Begin Patch\n*** Update File: src\\a.ts\n*** Move to: src\\z.ts\n@@\n*** End Patch";
    expect(fileOps("apply_patch", json({ input: patch }), "C:\\w")).toEqual([{ op: "move", path: "C:/w/src/a.ts", to: "C:/w/src/z.ts" }]);
  });

  it("ignores other tools and malformed input", () => {
    expect(fileOps("bash", json({ command: "cat a.ts" }), "/w")).toEqual([]);
    expect(fileOps("read", "{not json", "/w")).toEqual([]);
    expect(fileOps(null, null)).toEqual([]);
  });
});
