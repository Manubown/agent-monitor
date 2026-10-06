# Improvements and ideas

Backlog from the code review of 0.1.0-alpha.1 (2026-10-06). The eight most urgent findings are fixed in 0.1.0-alpha.2
(see [CHANGELOG.md](../CHANGELOG.md)); everything below is still open unless ticked. File references are as of that
review. Marked *unverified* where the finding was inferred rather than reproduced. Feature ideas also collect
requests from use (the "Dashboard and charts" section, added 2026-10-06).

## Things to improve

### Windows

- [x] **Analysis views treat paths as POSIX**: fixed with `src/core/paths.ts` (slash form, upper-case drive letter) and Windows fixtures. Follow-up: only the drive letter is case-folded, so `C:\Users\Me\x` and `C:\users\me\x` still count as two files.
- [ ] **Resume command is POSIX shell** (`src/core/adapter.ts:46-52`, shown on the session page): `cd '<C:\…>' && claude --resume …` fails in cmd.exe and Windows PowerShell 5.1. Emit `Set-Location -LiteralPath '…'; …` on win32.
- [ ] **Archive round trip depends on the drive letter's case** (`src/ingest/archive.ts`, `originalPath`): a root spelled `c:\…` comes back as `C:\…` and would be ingested twice (*unverified*). Upper-case the drive letter, compare paths case-insensitively on win32, add a `path.win32` round-trip test.
- [x] **CI never runs on Windows**: the matrix now has `windows-latest`, plus Node 22.13.0 and 24.x on Ubuntu.
- [ ] **`pnpm build:native` fails while the server runs** (`scripts/build-native.mjs:80,116`): the loaded addon cannot be replaced, the error reads "download failed" and it falls back to cargo. Detect EPERM/EBUSY and tell the user to stop the server first.
- [ ] **Stopping `pnpm demo` leaves `next dev` running** on Windows (`scripts/demo.ts`, `child.kill`): the grandchild keeps port 4200. Kill the process tree (`taskkill /T`) on win32.
- [ ] Data lives under `%USERPROFILE%\.local\share\agent-monitor` (`src/store/db.ts:119`, `src/core/pricing.ts:56`); `%LOCALAPPDATA%` is the Windows convention. Needs a migration of the archive and `user.db`.

### Performance (matters for always-on use)

- [ ] **Sync re-parses whole files** (`src/ingest/sync.ts`): the archive now appends a gzip member when only the tail changed, and the archive is listed only on the first sync per process. Still open: a grown log is decoded, parsed, hashed and auto-tagged in full on the Next server's event loop. Measured on a 14 MiB omp log: about 320 ms per sync (parse 105, write 66, decode 57, auto-tags 50, hashes 39 ms). The remaining fix is a byte offset plus resumable parser state per adapter, which changes the pure `parse(path, content)` contract, or running sync in a worker (needs a separate entry point next to the Next bundle).
- [x] **Every sync lists the whole archive**: only on the first sync per database and process, with `--full`, or after a rebuild. Not done: `fs.watch` instead of walking the roots every 5 s.
- [x] **Missing indexes**: `sessions(cwd, started_at, id)`, `sessions(ended_at)`, `events(ts, session_id)`, `events(kind, tool_name, is_error, ts, session_id)`, checked with `EXPLAIN QUERY PLAN` (full scans of `events` went from 15 to 1). The unused `events(tool_name)` index was dropped.
- [x] **Projects cache keyed on the database generation**: parsed touches are cached per session and keyed by `events_hash`.
- [x] **Every write refreshes every open page**: sync events carry the changed session ids (plus their ancestors) and cwds; a session page refreshes only for its own tree, a project map only for its project. Not done: memoizing session analyses per (id, generation).
- [x] **One `EventSource` per tab, hidden or not**: the stream closes while the tab is hidden and catches up through `hello` when it is shown again.
- [x] **The root layout waits for the first full sync**: the top bar renders at once; the content waits behind Suspense with an "Importing logs… N files" progress message.
- [x] **Unbounded session page payload**: `SessionActivity` no longer gets `resources` or per-action `res`; the timeline shows at most 1,000 events and "Show earlier" slides the window, with "Jump to latest".
- [x] **"Synced N ago" and the log counts went stale** on pages unrelated syncs no longer refresh: the time is rendered client-side, and file, deleted and failed counts refresh the top bar on any page. Back and Forward refresh once when a skipped sync could have changed the cached page. Still open: the session page's "Active" badge is time-based and only updates with the page's own changes.

### Correctness and robustness

- [x] **Clipped tool input breaks file tracking**: `clipToolInput` (`src/ingest/sync.ts`) shortens long string values so stored JSON stays valid, and keeps patch and omp-edit file header lines.
- [x] **Recursive CTEs without depth guard**: subtree walks go through `SUBTREE` (`src/store/tree.ts`), which never re-enters a session on its path, and sync breaks a parent cycle at ingest (the session that would close it is stored as a root), so cycle members also show up in the session list.
- [x] **Selections stored as array indices**: graph selections, flame zoom, hover and focus use stable keys (`app/components/graph/selection.ts`); `FileHeat` rows are keyed by path. Still index-based: agent colors (`slot` in `src/store/activity.ts`), so an inserted subagent recolors the agents after it.
- [x] **`decodeURIComponent` on the URL hash**: decoded safely; `app/global-error.tsx` covers the root layout.
- [x] **Unvalidated query parameters**: `app/lib/params.ts` (strict integers, `Object.hasOwn` lookups, slugged download names) in the sessions list, export route, usage and project map; the session page clamps `at`/`from`/`to`. Minor: `filtersFrom` does not cap the length of `q`, `tag`, `source` and `project`.
- [x] **Sync failures only reach the console**: the top bar shows a failing sync, "search unavailable" and "search behind"; "Sync now" no longer turns a failed sync into an error page.
- [x] **Empty state on a fresh install**: the overview and `/projects` list the scanned roots and their override variables. Not done: the same on `/sessions`.
- [x] **Corrupt archive copies are re-read every sync**: recorded and skipped until the copy changes. A damaged copy reads back every member that still decodes. When a log shrinks, the replaced copy is kept as `<copy>.<time>.prev`; the latest in-place rewrite of a growing log as `<copy>.prev`. An archived-only log whose import failed for a passing reason (a locked database) is retried.
- [x] **Two archived-only copies of one session**: the copy with more events wins, then the later end, then the path.
- [x] **Legacy Codex rollouts**: lines without the `payload` envelope are read (format inferred from the codex-rs history, no real legacy file tested); a file with no recognizable line now fails visibly instead of parsing to nothing.
- [x] **Two processes syncing at once** (server plus `pnpm watch`) appending the same archive tail: an append whose .gz does not end up the expected size is redone as a full rewrite. `pnpm watch` survives a failed sync.
- [x] **Overview `?q=`**: the search box appears when a search filters the overview, and its links keep it.
- [ ] **`.prev` copies are never cleaned up** and are not read back by the app; they need a place in the archive health view (Feature ideas) and a retention rule.
- [ ] **One remount after the first import** (`app/layout.tsx`): the page content is wrapped in Suspense only while importing (so unknown routes keep their 404), which resets client state once when the import ends.

### Security and privacy

- [ ] **No `frame-ancestors` / `X-Frame-Options`** (`proxy.ts`): any site can frame the dashboard and trick clicks on the tag editor.
- [ ] **Data dir and archive use the default umask** (`src/store/db.ts:144`, `src/ingest/archive.ts`); create them `0700` on POSIX.
- [ ] **Release integrity**: `SHA256SUMS` sits in the same release as the binaries, so it detects corruption, not tampering. Add build provenance (`actions/attest-build-provenance`), pin actions by commit SHA, add Dependabot for npm, cargo and actions.

### Install, release and CI

- [ ] **Linux glibc version not checked** (`scripts/build-native.mjs:45`): only presence is, but the prebuilt needs glibc ≥ 2.35, so Debian 11, RHEL 8/9 and Ubuntu 20.04 download an addon that then fails to load. Compare `glibcVersionRuntime` or trial-load in a child process.
- [ ] **Prebuilt keyed only to the package version** (`scripts/build-native.mjs:52`): on `main` after Rust changes the downloaded addon may not match `src/search/native.ts`. Key to a hash of `native/search` sources or export an `abiVersion()`.
- [ ] `cargo build` without `--locked` in `scripts/build-native.mjs:93`.
- [ ] **`release.yml` publishes untested**: no `pnpm check` gate before `publish`, no dry run (`workflow_dispatch` without publishing), Intel macOS never smoke-tested (`:42`).
- [ ] **Release notes** are only GitHub's "Full Changelog" link; generate them from the version's CHANGELOG section.
- [ ] **pnpm "approve-builds" banner** for esbuild on every fresh install; set `pnpm.onlyBuiltDependencies` or `ignoredBuiltDependencies`.
- [ ] **Docs**: README "Quick start" should name the other cases that need Rust (unreleased version, glibc < 2.35, VS Build Tools on Windows); `XDG_DATA_HOME` is honored but undocumented; mention `corepack enable`.
- [ ] `sourceColor` (`app/components/ui.tsx:9-11`) has 7 distinct colors; the 8th adapter onward shares one.

### UI polish and accessibility

- [ ] The Motion toggle is ignored by `.pulse-dot` (`app/features.css:40-65`), parts of `app/search.css` and `graph.css`, and the smooth scroll in `TargetEvent.tsx`; scope them under `:root[data-motion="on"]`.
- [ ] `app/components/StackedBarChart.tsx`: focusable `<g>` inside `<svg role="img">` has no role or name, one tab stop per column (up to 3,660 on "All time"), `key={label}` collides for yearless labels, `--axis-text` is about 3.4:1 on the light theme. One tab stop with arrow keys, index keys, darker tick token.
- [ ] Heatmap cells don't link to their sessions yet.

### Missing tests

- [ ] `proxy.ts` (the DNS-rebinding guard), `app/actions.ts` (tag writes), the API routes.
- [ ] `user.db` tags surviving a `SCHEMA_VERSION` rebuild (`src/store/db.ts:155-165`).
- [ ] `app/lib/server.ts`: `filtersFrom`, single-flight sync, the search-unavailable path.
- [ ] The asset-name and `SHA256SUMS` contract between `scripts/build-native.mjs` and `release.yml`.

## Feature ideas

### Easier install

- [ ] **Release archive (M)**: `output: "standalone"` plus a release job that zips `.next/static`, the addon and a launcher per platform: no pnpm, Rust or build step. The launcher must force `HOSTNAME=127.0.0.1` (the standalone `server.js` defaults to `0.0.0.0:3000`) and set `AGENT_MONITOR_NATIVE` (the addon path is resolved from the working directory). Winget, Scoop and Homebrew manifests can follow.
- [ ] **`npx agent-monitor` (L)**: publish to npm with a compiled CLI (`bin`, `serve` command), the prebuilt `.next`, and the addon as per-platform `optionalDependencies` (the napi-rs convention) instead of the GitHub download.
- [ ] **Autostart (M)**: `agent-monitor service install|uninstall` registering a Task Scheduler at-logon task (Windows), a LaunchAgent (macOS) or a `systemd --user` unit (Linux), capturing `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `AGENT_MONITOR_*` and the absolute node path. Wants the sync performance items first.
- [ ] **Opt-in update check (S)**: query GitHub releases (prereleases included) and show a banner with upgrade steps; off by default to keep the no-network promise.

### Dashboard and charts

- [ ] **Sessions first on the overview (S)**: the most-used thing (sessions) sits near the bottom of `app/page.tsx`, under the tiles, two charts, the heatmap, token mix, tools and models. Add a row of session cards (title, tool, project, last activity, cost, auto-tags) right under "Active now", sized to the viewport width. The next item builds on this; ship it on its own first.
- [ ] **Modular dashboard (M)**: one widget per card instead of one 375-line page.
  - *Registry*: `app/components/dashboard/widgets.ts` maps a stable id (`sessions`, `cost-per-day`, `heatmap`, `token-mix`, `tools`, `models`, `projects`, …) to a server component taking `(db, filters)`, a title and allowed sizes. Each widget runs only its own queries, so a hidden widget costs nothing.
  - *Layout*: an ordered list of `{ id, w, h }` on a 12-column CSS grid. `w` is one of 3/4/6/8/12 columns and `h` is one of S/M/L row heights (presets rather than free pixel sizes). It is stored in `user.db` (a new `dashboard_layout` table, like tags, so it survives `SCHEMA_VERSION` rebuilds), and the current layout is the default. Columns collapse to full width on narrow screens.
  - *Editing*: a "Customize" toggle shows per-card controls: move earlier or later, width and height presets, hide, add from the list, reset to default. They are keyboard accessible and saved through a server action. Drag-to-reorder (native HTML drag and drop, or `@dnd-kit` if that turns out too fiddly) is a later layer on top of the same layout model.
  - *Not planned*: free-form drag-resize grids such as `react-grid-layout`. They turn every card into a client component, which conflicts with server components reading SQLite directly. They are hard to use from the keyboard, and pixel layouts break between window sizes.
  - Later: several named layouts (for example "cost" and "activity"), and the same widgets on the project and session pages.
- [ ] **Clickable bars: "what was done on this day" (M)**: today `StackedBarChart` only shows a tooltip.
  - *Chart*: add an optional `hrefs?: string[]` prop (a link per column) and keep the component generic. Combine this with the accessibility item above: one tab stop, arrow keys move between columns, Enter opens the column, index keys.
  - *Overview / cost and tokens per day*: clicking a day sets `?day=YYYY-MM-DD`, which keeps all state in the URL like the other filters. A panel under the chart lists that day's sessions with their title, prompts (from `src/store/turns.ts`), auto-tags, top tools and files touched, plus cost and tokens; each row links to the session. The panel ends with "All N sessions on this day →", which needs a custom `from`/`to` in `Filters` (useful on its own).
  - *Session page / context per request* (`app/components/turns/ContextCard.tsx`): clicking a request jumps to its event in the timeline (`?at=<seq>#e-<seq>`, as `TurnsCard` already does). The tooltip shows the turn's prompt, so you can see what the agent was working on when context grew. This needs `seq` on `ContextAgent.requests`.
  - *Errors and usage charts*: the same `hrefs`, drilling into the errors or sessions of that bucket.
  - Related: heatmap cells linking to their sessions (above) can use the same day/hour drill-down.

### Product

- [ ] **Multi-machine history (M–L)**: add a `host` to sessions and let one PC import another PC's archive directory read-only, so laptop and desktop history merge. Today a Linux path read back on Windows would decode as a UNC path.
- [ ] **Budget and burn-rate alerts (S–M)**: daily or weekly thresholds, a top-bar badge and an optional desktop notification; builds on `burnRate` in `src/core/windows.ts` and `/api/live`.
- [ ] **Cache-efficiency view (S)**: cache hit ratio, 1h vs 5m write spend, cache writes that were never read, per session and model.
- [ ] **Read-time and what-if pricing (S–M)**: price usage at query time so `pricing.json` edits apply without `--full`, and re-price a session or project under another model.
- [ ] **Search CLI and MCP server (M)**: `agent-monitor search` and an MCP server over the tantivy index, so agents can recall how a past problem was solved.
- [ ] **Secrets report and redaction (M)**: find and optionally redact secrets in the database, index and archive, which keep them indefinitely today.
- [ ] **Notes and pinned sessions (S)**: free-text notes on sessions and events, stored in `user.db` like tags.
- [ ] **Single-session export (M)**: redacted Markdown/HTML for bug reports and reviews, from `/api/export`, the timeline and dispatch prompts.
- [ ] **Tool latency report (S/M)**: p50/p95 per tool and the slowest commands.
- [ ] **Cost per git branch or worktree (M)** from `sessions.git_branch`.
- [ ] **Live tail (M)**: one page streaming the events of all active sessions.
- [ ] **Archive health and retention (S)**: archive size per tool, failed copies, last archived time, optional retention.
- [ ] **Terminal reports (S)**: `stats --by day|month|session --json` and a statusline command (`stats` prints only per-model totals today).
- [ ] From the README roadmap: outcome check (S–M), date-based prices (S), OpenTelemetry export (lower priority).

### More agents

Log locations below come from the tools' own docs and are *unverified* here.

- [ ] **pi and its forks (S)**: omp is a pi fork, so `parseOmp` may work with new roots (`~/.pi/agent/sessions/`).
- [ ] **Gemini CLI (S–M)**: `~/.gemini/tmp/<project_hash>/chats/*.json`, whole-file JSON.
- [ ] **Cline / Roo / Kilo (M)**: VS Code globalStorage `…/tasks/<id>/{api_conversation_history,ui_messages}.json`; one session spans several files.
- [ ] **opencode, Copilot CLI, Goose, Zed, Crush (M–L)**: SQLite stores; the one-text-file adapter contract (`src/core/adapter.ts`) and per-file gzip archive need a database-source variant first.
- [ ] **Aider (M)**: `.aider.chat.history.md` in each repo, no central root; roots could come from known project directories.
- [ ] **Cursor (L, last)**: the local `state.vscdb` lacks reliable usage data.
