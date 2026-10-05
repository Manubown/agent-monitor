import fs from "node:fs";
import path from "node:path";
import { type Env, homeDir } from "./adapter";
import type { UsageRecord } from "./types";

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache write. Defaults to 1.25x input. */
  cacheWrite5m?: number;
  /** 1-hour cache write. Defaults to 2x input. */
  cacheWrite1h?: number;
}

/**
 * Anthropic first-party API list prices (cached 2026-09-25 from the Claude API
 * reference). Cache writes follow the published multipliers (1.25x input for
 * 5m, 2x for 1h); cache reads differ per model. Models missing here (older
 * Claude versions, OpenAI, Gemini, ...) are left unpriced unless you add them
 * in ~/.config/agent-monitor/pricing.json; their tokens are still tracked.
 */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-mythos-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

/**
 * Reduce provider-specific spellings to a bare model id:
 * "anthropic/claude-opus-5-5", "us.anthropic.claude-opus-5-5-v1:0",
 * "claude-haiku-4-5-20251001", "claude-opus-5-5[1m]" -> canonical id.
 */
export function normalizeModel(model: string): string {
  let m = model.trim().toLowerCase();
  m = m.slice(m.lastIndexOf("/") + 1);
  m = m.replace(/^(?:[a-z]{2,4}\.)?anthropic\./, "");
  m = m.replace(/\[.*\]$/, "");
  m = m.replace(/-v\d+(?::\d+)?$/, "");
  m = m.replace(/[@-]\d{8}$/, "");
  return m;
}

export function loadPrices(env: Env = process.env): Record<string, ModelPrice> {
  const file = env.AGENT_MONITOR_PRICING || path.join(homeDir(env), ".config", "agent-monitor", "pricing.json");
  const prices: Record<string, ModelPrice> = { ...DEFAULT_PRICES };
  try {
    // User config outside the project; keep Next's output tracing from following it.
    const overrides = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as Record<string, ModelPrice>;
    for (const [model, price] of Object.entries(overrides)) prices[normalizeModel(model)] = price;
  } catch {
    // No overrides file (or unreadable): defaults only.
  }
  return prices;
}

export function priceFor(model: string, prices: Record<string, ModelPrice>): ModelPrice | undefined {
  const id = normalizeModel(model);
  if (prices[id]) return prices[id];
  // Longest known id that prefixes this one, e.g. "claude-opus-5-5-fast" -> "claude-opus-5-5".
  let best: string | undefined;
  for (const key of Object.keys(prices)) {
    if (id.startsWith(`${key}-`) && (!best || key.length > best.length)) best = key;
  }
  return best ? prices[best] : undefined;
}

export type CostSource = "reported" | "estimated" | "unpriced";

export interface CostResult {
  usd: number | null;
  source: CostSource;
}

/** Cost of one request: the tool's own figure when present, else a list-price estimate. */
export function costOf(record: UsageRecord, prices: Record<string, ModelPrice>): CostResult {
  if (record.reportedCostUsd !== undefined) return { usd: record.reportedCostUsd, source: "reported" };
  const price = priceFor(record.model, prices);
  if (!price) return { usd: null, source: "unpriced" };
  const u = record.usage;
  const write1h = Math.min(record.cacheWrite1h ?? 0, u.cacheWrite);
  const write5m = u.cacheWrite - write1h;
  const usd =
    (u.input * price.input +
      u.output * price.output +
      u.cacheRead * price.cacheRead +
      write5m * (price.cacheWrite5m ?? price.input * 1.25) +
      write1h * (price.cacheWrite1h ?? price.input * 2)) /
    1_000_000;
  return { usd, source: "estimated" };
}
