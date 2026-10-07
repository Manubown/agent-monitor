# Improvements and ideas

Backlog from the code review of 0.1.0-alpha.1 (2026-10-06). The eight most urgent findings are fixed in 0.1.0-alpha.2
(see [CHANGELOG.md](../CHANGELOG.md)); everything below is still open unless ticked. File references are as of that
review. Marked *unverified* where the finding was inferred rather than reproduced. Feature ideas also collect
requests from use (the "Dashboard and charts" section, added 2026-10-06).

## Things to improve

### Windows

- [x] **Analysis views treat paths as POSIX**: fixed with `src/core/paths.ts` (slash form, upper-case drive letter) and Windows fixtures. Follow-up: only the drive letter is case-folded, so `C:\Users\Me\x` and `C:\users\me\x` still count as two files.
- [x] **Resume command is POSIX shell**: the session page renders the command for the shell of the machine the dashboard runs on (`shellFor(process.platform)` in `src/core/adapter.ts`). On win32 that is `Set-Location -LiteralPath '<C:\…>' -ErrorAction Stop; claude --resume …` with PowerShell quoting (ASCII and typographic single quotes doubled), so a missing directory stops the line instead of starting the agent elsewhere. Not done: no cmd.exe form.
- [ ] **Archive round trip depends on the drive letter's case** (`src/ingest/archive.ts`, `originalPath`): a root spelled `c:\…` comes back as `C:\…` and would be ingested twice (*unverified*). Upper-case the drive letter, compare paths case-insensitively on win32, add a `path.win32` round-trip test.
- [x] **CI never runs on Windows**: the matrix now has `windows-latest`, plus Node 22.13.0 and 24.x on Ubuntu.
- [x] **`pnpm build:native` fails while the server runs**: replacing a loaded addon (EPERM/EACCES/EBUSY on win32, EBUSY/ETXTBSY elsewhere) stops with "stop the running server first" instead of "download failed", a cargo fallback and an EBUSY stack trace.
- [x] **Stopping `pnpm demo` leaves `next dev` running**: `serve` kills the process tree on win32 (`taskkill /T /F`, `child.kill` as fallback) and exits with the child's code. The leftover did not reproduce with Node 22.22 and Next 16.3.8 (libuv's job object takes the tree down with the parent); the tree kill covers descendants that leave that job.
- [ ] Data lives under `%USERPROFILE%\.local\share\agent-monitor` (`src/store/db.ts:119`, `src/core/pricing.ts:56`); `%LOCALAPPDATA%` is the Windows convention. Needs a migration of the archive and `user.db`.

### Performance (matters for always-on use)

- [x] **Sync re-parses whole files**: adapters are incremental parsers (`Adapter.parser(path)` → `push(line)` / `result()`; `parseLog` derives the whole-file parse), and `src/ingest/incremental.ts` keeps, for up to 16 logs per database (32 MiB of logs, 30 min idle), the parser, the byte offset, the archive copy's running sha1 and what the last write stored. A log that only grew is read from its offset (after checking its first 64 KiB and the 4 KiB before the offset), appended to its archive copy as one gzip member, and stored by extending the event hash chain, the counters, the usage rows and the auto-tags (`AutoTagScan`, `LoopScan`) over the new events. Anything else (a rewritten prefix such as omp's title line, a shrunk log, `--full`, a write by another process, an archive copy not as we left it) takes the whole-file path, which rebuilds the state. Measured on a synthetic 14 MiB omp log after one appended turn: 545–687 ms → 11–15 ms. Not done: the first growth of a log after a server start is still read whole, sync still runs on the Next server's event loop, and the roots are still walked every 5 s (`fs.watch`).
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
- [x] `app/components/StackedBarChart.tsx`: one tab stop (the plot is a named `role="group"`), arrow keys, Home and End move between columns with a persistent live region, Enter opens the column; index keys; `--axis-text` at 5.3:1 on the light theme.
- [ ] Heatmap cells don't link to their sessions yet.

### Missing tests

- [ ] `proxy.ts` (the DNS-rebinding guard), `app/actions.ts` (tag writes), the API routes.
- [ ] `user.db` tags surviving a `SCHEMA_VERSION` rebuild (`src/store/db.ts:155-165`).
- [ ] `app/lib/server.ts`: single-flight sync, the search-unavailable path (`filtersFrom` is covered in `test/day.test.ts`).
- [ ] The asset-name and `SHA256SUMS` contract between `scripts/build-native.mjs` and `release.yml`.

## Feature ideas

### Easier install

- [ ] **Release archive (M)**: `output: "standalone"` plus a release job that zips `.next/static`, the addon and a launcher per platform: no pnpm, Rust or build step. The launcher must force `HOSTNAME=127.0.0.1` (the standalone `server.js` defaults to `0.0.0.0:3000`) and set `AGENT_MONITOR_NATIVE` (the addon path is resolved from the working directory). Winget, Scoop and Homebrew manifests can follow.
- [ ] **`npx agent-monitor` (L)**: publish to npm with a compiled CLI (`bin`, `serve` command), the prebuilt `.next`, and the addon as per-platform `optionalDependencies` (the napi-rs convention) instead of the GitHub download.
- [ ] **Autostart (M)**: `agent-monitor service install|uninstall` registering a Task Scheduler at-logon task (Windows), a LaunchAgent (macOS) or a `systemd --user` unit (Linux), capturing `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `AGENT_MONITOR_*` and the absolute node path. Wants the sync performance items first.
- [ ] **Opt-in update check (S)**: query GitHub releases (prereleases included) and show a banner with upgrade steps; off by default to keep the no-network promise.

### Dashboard and charts

- [x] **Sessions first on the overview (S)**: a row of session cards (`app/components/SessionCards.tsx`: title, tool, project, last activity, cost, tags, subagents, a pulse while running) sits under the filter bar and replaces the "Recent sessions" table; container queries show one to five cards in a single row depending on the width.
- [x] **Modular dashboard (M)**: the overview is a 12-column grid of widgets. `app/components/dashboard/specs.ts` is the registry (stable id, title, allowed widths 3/4/6/8/12 and heights S/M/L); `widgets.tsx` holds one server component per id that runs its own queries, so a hidden widget costs nothing. The layout (`src/core/dashboard.ts`, pure) is an ordered list of `{ id, w, h }` stored in `user.dashboard_layout` (survives `SCHEMA_VERSION` rebuilds); without a stored row it is the old page order. "Customize" (`?customize=1`) shows per-card buttons (move earlier or later, width, height, hide) plus "Add widget" and "Reset to default", saved by the `updateDashboard` server action, which validates every edit against the registry. Cards fall back to 6 columns below 1100 px and to full width below 860 px; long tables scroll inside their height preset. The `?day=` panel follows the last visible per-day chart.
  - *Not planned*: free-form drag-resize grids such as `react-grid-layout`. They turn every card into a client component, which conflicts with server components reading SQLite directly. They are hard to use from the keyboard, and pixel layouts break between window sizes.
  - [ ] Later: drag-to-reorder on the same layout model (native HTML drag and drop, or `@dnd-kit`), several named layouts (the table is keyed by name already), the same widgets on the project and session pages.
- [x] **Clickable bars: "what was done on this day" (M)**: `StackedBarChart` takes `hrefs` (one link per column). On the overview a day opens `?day=YYYY-MM-DD` and a panel under the per-day charts (`app/components/DayPanel.tsx`, `src/store/day.ts`): that day's sessions with prompts, auto-tags, tools, changed files, tokens and cost, and "All N sessions on this day →". `Filters` gained an exclusive `to`; `from`/`to` local days in the URL override the range on every page (`filtersFrom`, `queryOf`), and inside such a window every query counts a session by its activity in the window (`SESSION_ACTIVE`), so tiles, panel, `/sessions` and projects agree. "Context per request" on the session page links each request to its event and shows the turn's prompt; the errors chart drills into that day's errors and the usage windows into their sessions.
  - [ ] Not done: a date picker for the custom window. Heatmap cells (above) can reuse the same `from`/`to` drill-down.

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
