import { describe, expect, it } from "vitest";
import { attachment, downloadName, first, nonNegativeInt, oneOf, oneOfList, paramsOf, positiveInt, slug } from "../app/lib/params";

describe("first", () => {
  it("takes the first of repeated values and treats empty as missing", () => {
    expect(first("a")).toBe("a");
    expect(first(["b", "c"])).toBe("b");
    expect(first([])).toBeUndefined();
    expect(first("")).toBeUndefined();
    expect(first(undefined)).toBeUndefined();
  });
});

describe("positiveInt", () => {
  it("accepts plain whole numbers", () => {
    expect(positiveInt("1")).toBe(1);
    expect(positiveInt("42")).toBe(42);
    expect(positiveInt(["3", "9"])).toBe(3);
    expect(positiveInt("007")).toBe(7);
  });

  it("falls back on anything else", () => {
    for (const bad of ["1.01", "0", "-3", "1e3", "0x10", " 2", "2 ", "abc", "", "Infinity", "NaN", "99999999999999999999"]) {
      expect(positiveInt(bad), bad).toBe(1);
    }
    expect(positiveInt(undefined, 5)).toBe(5);
    expect(positiveInt([], 5)).toBe(5);
  });

  it("clamps to the maximum", () => {
    expect(positiveInt("1000", 1, 20)).toBe(20);
    expect(positiveInt("20", 1, 20)).toBe(20);
  });
});

describe("nonNegativeInt", () => {
  it("accepts plain whole numbers from 0", () => {
    expect(nonNegativeInt("0")).toBe(0);
    expect(nonNegativeInt("42")).toBe(42);
    expect(nonNegativeInt("007")).toBe(7);
    expect(nonNegativeInt(["7", "9"])).toBe(7);
  });

  it("is undefined for anything else", () => {
    for (const bad of ["", "-1", "1.5", "1e3", " 2", "2 ", "0x10", "abc", "Infinity", "NaN", "99999999999999999999"]) expect(nonNegativeInt(bad), bad).toBeUndefined();
    expect(nonNegativeInt(undefined)).toBeUndefined();
    expect(nonNegativeInt([])).toBeUndefined();
  });
});

describe("oneOf", () => {
  const table = { csv: 1, json: 2 };
  it("finds own keys only", () => {
    expect(oneOf(table, "csv")).toBe("csv");
    expect(oneOf(table, ["json", "csv"])).toBe("json");
    for (const bad of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "CSV", "", undefined]) {
      expect(oneOf(table, bad), String(bad)).toBeUndefined();
    }
  });

  it("works on null-prototype tables", () => {
    const bare = Object.assign(Object.create(null) as Record<string, number>, { a: 1 });
    expect(oneOf(bare, "a")).toBe("a");
    expect(oneOf(bare, "constructor")).toBeUndefined();
  });

  it("oneOfList checks membership", () => {
    const ids = ["24h", "7d", "all"] as const;
    expect(oneOfList(ids, "7d")).toBe("7d");
    expect(oneOfList(ids, "constructor")).toBeUndefined();
    expect(oneOfList(ids, "")).toBeUndefined();
  });
});

describe("slug and download names", () => {
  it("slugs to lowercase words", () => {
    expect(slug("My Project (v2)")).toBe("my-project-v2");
    expect(slug("  --  ")).toBe("");
    expect(slug("a".repeat(30) + " " + "b".repeat(30))).toBe("a".repeat(30) + "-" + "b".repeat(9));
    expect(slug("x".repeat(39) + " y")).toBe("x".repeat(39)); // no trailing dash after the cut
  });

  it("builds short, header-safe file names", () => {
    expect(downloadName(["agent-monitor", "sessions", "30d", undefined, false, "", "2026-10-06"], "csv")).toBe("agent-monitor-sessions-30d-2026-10-06.csv");
    const nasty = downloadName(["agent-monitor", 'a"b\r\nX-Injected: 1', "ü/..\\x", "../../etc/passwd"], "json");
    expect(nasty).toMatch(/^[a-z0-9.-]+$/);
    expect(nasty).toBe("agent-monitor-a-b-x-injected-1-x-etc-passwd.json");
    const long = downloadName(Array.from({ length: 10 }, (_, i) => `${i}${"z".repeat(39)}`), "csv");
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long).toMatch(/^[a-z0-9-]+[a-z0-9]\.csv$/);
    expect(downloadName([], "")).toBe("download.txt");
  });

  it("quotes the name in Content-Disposition", () => {
    expect(attachment(["agent-monitor", 'x";evil=1'], "log")).toBe('attachment; filename="agent-monitor-x-evil-1.log"');
  });
});

describe("paramsOf", () => {
  it("keeps repeated keys as arrays and prototype keys as own properties", () => {
    const p = paramsOf(new URLSearchParams("view=daily&tag=a&tag=b&__proto__=x&constructor=y"));
    expect(p.view).toBe("daily");
    expect(p.tag).toEqual(["a", "b"]);
    expect(Object.hasOwn(p, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(p, "constructor")?.value).toBe("y");
  });
});
