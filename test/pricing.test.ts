import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { costOf, DEFAULT_PRICES, loadPrices, normalizeModel, priceFor } from "../src/core/pricing";
import { emptyUsage } from "../src/core/types";

describe("normalizeModel", () => {
  it.each([
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["anthropic/claude-opus-5-5", "claude-opus-5-5"],
    ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
    ["us.anthropic.claude-sonnet-5-5-v1:0", "claude-sonnet-5-5"],
    ["anthropic.claude-opus-5-5", "claude-opus-5-5"],
    ["claude-opus-5-5[1m]", "claude-opus-5-5"],
    ["claude-opus-4-5@20251101", "claude-opus-4-5"],
    ["GPT-5-Codex", "gpt-5-codex"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeModel(input)).toBe(expected);
  });
});

describe("priceFor", () => {
  it("does not confuse a model with a longer id that shares its prefix", () => {
    expect(priceFor("claude-opus-5", DEFAULT_PRICES)?.input).toBe(5);
    expect(priceFor("claude-opus-5-5", DEFAULT_PRICES)?.input).toBe(4);
  });

  it("returns undefined for unknown models", () => {
    expect(priceFor("gpt-5-codex", DEFAULT_PRICES)).toBeUndefined();
  });
});

describe("costOf", () => {
  const usage = { ...emptyUsage(), input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 2_000_000 };

  it("prices 5m and 1h cache writes at 1.25x and 2x input", () => {
    const c = costOf({ ts: 0, model: "claude-opus-5-5", usage, cacheWrite1h: 1_000_000 }, DEFAULT_PRICES);
    // 4 input + 20 output + 0.2 cache read + 5 (5m write) + 8 (1h write)
    expect(c).toEqual({ usd: 37.2, source: "estimated" });
  });

  it("prefers the cost recorded by the tool", () => {
    expect(costOf({ ts: 0, model: "claude-opus-5-5", usage, reportedCostUsd: 1.5 }, DEFAULT_PRICES)).toEqual({ usd: 1.5, source: "reported" });
  });

  it("leaves unknown models unpriced instead of guessing", () => {
    expect(costOf({ ts: 0, model: "gpt-5-codex", usage }, DEFAULT_PRICES)).toEqual({ usd: null, source: "unpriced" });
  });
});

describe("loadPrices", () => {
  it("merges user overrides from pricing.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-monitor-"));
    const file = path.join(dir, "pricing.json");
    fs.writeFileSync(file, JSON.stringify({ "openai/gpt-5-codex": { input: 1.25, output: 10, cacheRead: 0.125 } }));
    const prices = loadPrices({ AGENT_MONITOR_PRICING: file });
    expect(prices["gpt-5-codex"]).toEqual({ input: 1.25, output: 10, cacheRead: 0.125 });
    expect(prices["claude-opus-5-5"]).toEqual(DEFAULT_PRICES["claude-opus-5-5"]);
  });

  it("falls back to defaults when the file is missing", () => {
    expect(loadPrices({ AGENT_MONITOR_PRICING: "/nonexistent/pricing.json" })).toEqual(DEFAULT_PRICES);
  });
});
