import { describe, expect, it } from "vitest";
import { dirKey, fileKey, isAbsolutePath, isWindowsPath, normalizePath, resolvePath, sessionPath, slashPath } from "../src/core/paths";

describe("paths", () => {
  it("recognizes Windows paths by their drive or UNC prefix", () => {
    expect(isWindowsPath("C:\\Users\\me")).toBe(true);
    expect(isWindowsPath("c:/Users/me")).toBe(true);
    expect(isWindowsPath("\\\\server\\share\\x")).toBe(true);
    expect(isWindowsPath("/home/me")).toBe(false);
    expect(isWindowsPath("src\\a.ts")).toBe(false);
    expect(isWindowsPath("C:")).toBe(false);
  });

  it("converts Windows paths to slash form with an upper-case drive and leaves POSIX paths alone", () => {
    expect(slashPath("c:\\Users\\me\\proj")).toBe("C:/Users/me/proj");
    expect(slashPath("\\\\server\\share\\x")).toBe("//server/share/x");
    // On POSIX a backslash is part of the file name.
    expect(slashPath("/tmp/odd\\name")).toBe("/tmp/odd\\name");
    expect(slashPath("src\\a.ts")).toBe("src\\a.ts");
    expect(slashPath("src\\a.ts", true)).toBe("src/a.ts");
  });

  it("treats drive and UNC paths as absolute", () => {
    expect(isAbsolutePath("C:/x")).toBe(true);
    expect(isAbsolutePath("//server/share")).toBe(true);
    expect(isAbsolutePath("/x")).toBe(true);
    expect(isAbsolutePath("x/y")).toBe(false);
    expect(isAbsolutePath("C:x")).toBe(false);
  });

  it("normalizes without climbing above the drive or share", () => {
    expect(normalizePath("C:/a/./b/../c")).toBe("C:/a/c");
    expect(normalizePath("C:/a/../..")).toBe("C:/");
    expect(normalizePath("//server/share/x/../y")).toBe("//server/share/y");
    expect(normalizePath("/a//b/../c")).toBe("/a/c");
  });

  it("resolves relative paths against an absolute working directory only", () => {
    expect(resolvePath("src/a.ts", "C:/w")).toBe("C:/w/src/a.ts");
    expect(resolvePath("../b.ts", "/w/app")).toBe("/w/b.ts");
    expect(resolvePath("C:/x/../y", "/w")).toBe("C:/y");
    expect(resolvePath("src/a.ts", "relative")).toBe("src/a.ts");
    expect(resolvePath("src/a.ts", undefined)).toBe("src/a.ts");
  });

  it("reads tool paths in the session's own convention", () => {
    expect(sessionPath("src\\a.ts", "C:\\w")).toBe("C:/w/src/a.ts");
    expect(sessionPath("c:\\w\\src\\a.ts", "C:\\w")).toBe("C:/w/src/a.ts");
    expect(sessionPath("C:\\other\\b.ts", undefined)).toBe("C:/other/b.ts");
    expect(sessionPath("~/notes.md", "C:\\w")).toBe("~/notes.md");
    expect(sessionPath("src\\a.ts", "/w")).toBe("/w/src\\a.ts");
  });

  it("keys home-relative paths by the expanded path, also for a Windows home", () => {
    expect(fileKey("~/notes/todo.md", "C:\\Users\\me")).toBe("C:/Users/me/notes/todo.md");
    expect(fileKey("~/notes/todo.md", "/home/me")).toBe("/home/me/notes/todo.md");
    expect(fileKey("Mu\u0308ller.md", "/home/me")).toBe("M\u00fcller.md");
  });
});

describe("directory keys", () => {
  it("compare with file keys whatever the trailing slash or spelling", () => {
    expect(dirKey("C:\\proj\\")).toBe("C:/proj");
    expect(dirKey("/home/me/proj/")).toBe("/home/me/proj");
    expect(dirKey("/")).toBe("/");
    expect(dirKey("c:\\")).toBe("C:/");
    expect(fileKey("/home/me/proj/", "/home/me")).toBe(dirKey("/home/me/proj"));
    expect(dirKey("/Users/me/Mu\u0308ller")).toBe("/Users/me/M\u00fcller");
  });
});
