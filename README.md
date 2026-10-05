# Agent Monitor

A local dashboard for your AI coding agents. It shows what each session did (prompts, replies, tool calls, errors, subagents) and how many tokens it used and what it cost, for every agent CLI on the machine.

It reads the session logs the tools already write. There is nothing to configure inside the tools and no proxy, and older history is picked up on the first sync.

| Tool | Logs read from | Cost | Status |
|---|---|---|---|
| omp (oh-my-pi) | `~/.omp/agent/sessions/**/*.jsonl` | as recorded by omp | verified on real logs |
| Claude Code | `$CLAUDE_CONFIG_DIR/projects/**/*.jsonl` (default `~/.claude`) | estimated from list prices | verified on real logs |
| Codex CLI | `$CODEX_HOME/sessions/**/rollout-*.jsonl` (default `~/.codex`) | unpriced unless you add prices | prompts, replies and token usage verified on a real log; tool calls only against the documented format |

## Quick start

Requires Node >= 22.13, pnpm, and a Rust toolchain (`cargo`) for the search index addon.

```bash
pnpm install
pnpm build && pnpm start        # http://127.0.0.1:4100 (build compiles the Rust addon first)
# or: pnpm build:native && pnpm dev
```

The server syncs on start and then every 5 seconds; open pages refresh themselves when something changed. The **Sync now** button forces a sync.

CLI, without the UI:

```bash
pnpm sync            # ingest new and changed logs (add -- --full to re-parse everything, archived logs included)
pnpm stats           # totals per model in the terminal
pnpm sources         # where each adapter looks
pnpm watch           # keep syncing every 5 s
```

## What you get

- **Overview**: sessions active right now; cost, sessions, tokens, requests, tool calls and cache hit rate; cost and tokens per day by tool; token mix; most-used tools with failure rates; models; projects; recent sessions. Every number follows one filter row (time range, tool, project). The headline tiles drill down to the sessions behind them (sorted by that measure, same filters), and rows open what they list. Daily usage and models export as CSV or JSON.
- **Sessions**: every top-level session with its subagents' work rolled in, most recently active first or sorted by cost, tokens, requests, tool calls, errors or duration (`?sort=`, or click a column header); a session counts for a time range when it was active in it. Search by title, directory or id, filter by tag, export the list (in the same order) as CSV or JSON.
- **Session detail**: context size per model request (shows how the context grows and when it was compacted), token breakdown, tools used, subagent runs, and the full timeline. Tool calls and results can be expanded, and the timeline can be filtered by event type. Add your own `#tags`, and copy the command that resumes the session in its tool.
- **Automatic tags**: every session also gets tags derived from what it did, computed locally from its events (no model calls). They show as dashed chips next to your own tags, with the reason as tooltip, and work everywhere tags do (`?tag=`, `#tag` in search, export). Add one as a manual tag to pin it.
  - Languages, from files written or edited (at least 3 files or a quarter of all changed files; reads never count): `typescript`, `javascript`, `rust`, `python`, `go`, `java`, `c`, `swift`, `ruby`, `shell`, `sql`, `css`, `html`, `docs` (Markdown), `config` (JSON/YAML/TOML).
  - Shell commands: `tests` (vitest, jest, pytest, `cargo test`, `go test`, `pnpm test`…), `build` (`pnpm build`, `cargo build`, `tsc` without `--noEmit`…), `deps` (`pnpm add`, `cargo add`, `pip install`…; not a bare `npm install`), `git` (commit, push, pull, merge, rebase, checkout/switch, branch or tag creation, `gh pr create`; not status/diff/log).
  - `web`: web search or fetch tools. `subagents`: spawned subagents. `refactor`: 3+ files moved or renamed, or a `refactor/…` branch. `errors`: 3+ failed tool calls making up at least 20% of results, or an API error (not user interrupts). `long`: more than 1 h of activity (pauses over 10 min are idle unless a tool was running). `research`: 10+ reads, searches and fetches without changing a file.
- **Search** (`Ctrl K` / `⌘K` or `/`): full-text search over every prompt, reply, tool call and result, grouped by session, with a preview of what happened before and after each hit. Enter jumps to the event in the timeline. Filters: `kind:error`, `tool:bash`, `source:claude`, `project:web`, `model:opus`, `branch:main`, `tag:review` or `#review`, `after:7d`, `before:2026-10-01`, `in:<session id>`, `sort:new`; `"phrases"` and `-exclusions` work too.
- **Usage windows**: Claude requests grouped into the 5-hour windows that Anthropic's subscription limits reset on, with burn rate and a projection for the current window. Costs there are API-equivalent list prices; the limits themselves are not in the logs.

## How it works

```
 tool logs ──► adapter (one per tool) ──► normalized session ──► SQLite ──► Next.js UI / CLI
     │           parse(file) → ParsedSession     events + usage     │ queries.ts
     └──► archive (gzip copy)                                      └──► search index (Rust, tantivy)
```

- `src/core/types.ts`: the normalized schema (`ParsedSession`, `AgentEvent`, `UsageRecord`). Storage and UI only see this, never a tool's format.
- `src/adapters/*`: one file per tool. Each finds its log files, turns one into a `ParsedSession`, and knows how to resume a session.
- `src/ingest/sync.ts`: walks every adapter's directories and re-parses only files whose size or mtime changed. Each file is written in a single transaction; when only new events were appended (the usual case for a running agent) only those are inserted and indexed.
- `src/ingest/archive.ts`: a gzip copy of every ingested log.
- `src/store/`: the SQLite schema (built-in `node:sqlite`) and the read queries.
- `native/search` + `src/search/`: the full-text index, a Rust addon built on [tantivy](https://github.com/quickwit-oss/tantivy), and the query parser and search service on top.

**History is kept.** Tools prune their own logs; Claude Code, for example, deletes transcripts after 30 days by default. Every log is archived the moment it is ingested, so when a tool deletes it the sessions stay, the file is flagged as deleted, and it can still be re-parsed later.

**The database is a cache.** `monitor.db` and the search index can be deleted at any time and are rebuilt from the live logs plus the archive; schema changes do exactly that. Your own data (tags) lives in `user.db` and is never touched by a rebuild.

**Truncation.** Event text is cut at 20,000 characters and tool output at 6,000 so the database stays small. The full log is linked on every session page and kept in the archive.

## Cost

Each model request gets its cost from the first of these that applies:

1. **Reported**: the tool recorded it (omp).
2. **Estimated**: tokens × list price (`src/core/pricing.ts`, Anthropic API prices as of 2026-09-25). 5-minute and 1-hour cache writes are priced separately when the log says which was used. Estimated costs are marked with `~`.
3. **Unpriced**: the model isn't in the price table. Its tokens are still counted, and its cost shows as `—` or `*`.

Add or override prices in `~/.config/agent-monitor/pricing.json` (USD per million tokens), then run `pnpm sync -- --full`:

```json
{
  "gpt-5-codex": { "input": 1.25, "output": 10, "cacheRead": 0.125 }
}
```

`cacheWrite5m` and `cacheWrite1h` are optional and default to 1.25× and 2× input.

The estimates are list prices. They are not your bill if you use a subscription plan, a discount or a cloud provider. Claude Code's own background requests (title generation and the like) are not written to the transcript, so they aren't counted.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_MONITOR_DB` | `~/.local/share/agent-monitor/monitor.db` | database file (cache); the search index lives next to it in `search-index/` |
| `AGENT_MONITOR_USER_DB` | `user.db` next to the database | your tags |
| `AGENT_MONITOR_ARCHIVE` | `~/.local/share/agent-monitor/archive` | gzip copies of every ingested log |
| `AGENT_MONITOR_PRICING` | `~/.config/agent-monitor/pricing.json` | price overrides |
| `AGENT_MONITOR_SYNC_SECONDS` | `5` | background sync interval of the web server |
| `AGENT_MONITOR_NATIVE` | `native/agent_monitor_search.node` | path of the compiled search addon |
| `AGENT_MONITOR_<ADAPTER>_DIRS` | adapter default | replace an adapter's log directories, `:`-separated, e.g. `AGENT_MONITOR_CLAUDE_CODE_DIRS` |

## Adding a tool

1. Create `src/adapters/<tool>.ts` that implements `Adapter` (`roots`, `match`, `parse`, optionally `resumeCommand`). Parse leniently: skip lines you don't understand, and expect the last line to be half-written while the tool is running.
2. Register it in `src/adapters/index.ts`. Its color in the charts comes from its position in that list.
3. Add a small synthetic fixture under `test/fixtures/<tool>/` and tests in `test/adapters.test.ts`.

The storage, CLI and UI pick it up automatically.

## Privacy

Everything stays on this machine. The server listens on `127.0.0.1` only and refuses requests whose `Host` header is not a loopback name, which blocks DNS-rebinding attacks from web pages. The database, the search index and the archive hold transcripts (prompts, tool output, file contents the agents read), so treat them like the logs they come from.

## Development

```bash
pnpm build:native   # compile the Rust search addon (needed before dev/tests)
pnpm check          # addon + typecheck + tests
```
