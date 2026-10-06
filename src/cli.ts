import { setTimeout as sleep } from "node:timers/promises";
import { adapters } from "./adapters";
import { rootsFor, syncAll, type SyncResult } from "./ingest/sync";
import { openSearchIndex } from "./search/native";
import { defaultArchiveDir, defaultDbPath, openDb, siblingPath } from "./store/db";
import { byModel, overview } from "./store/queries";

const USAGE = `agent-monitor <command>

  sync [--full]      ingest new and changed session logs (--full re-parses everything, archived logs included)
  watch [seconds]    sync now and then every N seconds (default 5)
  stats              print totals per model
  sources            show where each adapter looks for logs

Environment:
  AGENT_MONITOR_DB               database file (default ${defaultDbPath()})
  AGENT_MONITOR_ARCHIVE          raw-log archive (default ${defaultArchiveDir()})
  AGENT_MONITOR_PRICING          pricing overrides (default ~/.config/agent-monitor/pricing.json)
  AGENT_MONITOR_<ADAPTER>_DIRS   override an adapter's log roots, e.g. AGENT_MONITOR_CLAUDE_CODE_DIRS`;

const fmt = new Intl.NumberFormat("en-US");
const usd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);

const report = (r: SyncResult) => {
  console.log(`scanned ${r.scanned} files, parsed ${r.parsed}, ${r.sessions} sessions updated in ${r.durationMs} ms`);
  for (const e of r.errors) console.error(`  error: ${e.path}: ${e.error}`);
  if (r.indexError) console.error(`  search index not updated (rebuilt on a later sync): ${r.indexError}`);
};

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  const indexDir = siblingPath(defaultDbPath(), "search-index");
  switch (command) {
    case "sync": {
      report(await syncAll(openDb(), { full: process.argv.includes("--full"), index: openSearchIndex(indexDir) }));
      return;
    }
    case "watch": {
      const seconds = Number(arg) || 5;
      const db = openDb();
      const searchIndex = openSearchIndex(indexDir);
      console.log(`watching every ${seconds}s, database ${defaultDbPath()}`);
      for (;;) {
        try {
          const r = await syncAll(db, { index: searchIndex });
          if (r.parsed || r.errors.length || r.indexError) report(r);
        } catch (error) {
          // E.g. the database is locked by another process: the next round tries again.
          console.error(`  sync failed (retried in ${seconds}s): ${error instanceof Error ? error.message : String(error)}`);
        }
        await sleep(seconds * 1000);
      }
    }
    case "stats": {
      const db = openDb();
      const o = overview(db, {});
      console.log(`${o.sessions} sessions (+${o.subagents} subagents), ${fmt.format(o.requests)} model requests, ${fmt.format(o.toolCalls)} tool calls`);
      console.log(
        `tokens: input ${fmt.format(o.input)}, output ${fmt.format(o.output)}, cache read ${fmt.format(o.cacheRead)}, cache write ${fmt.format(o.cacheWrite)}`,
      );
      console.log(`cost: ${usd(o.cost)} (of which estimated ${usd(o.estimatedCost)}; ${fmt.format(o.unpricedTokens)} tokens unpriced)\n`);
      console.table(
        byModel(db, {}).map((m) => ({
          source: m.source,
          model: m.model,
          requests: m.requests,
          output: m.output,
          "cache read": m.cacheRead,
          cost: usd(m.cost),
          "cost from": m.costSource,
        })),
      );
      return;
    }
    case "sources": {
      for (const a of adapters) console.log(`${a.label} (${a.id}): ${rootsFor(a, process.env).join(", ")}`);
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
