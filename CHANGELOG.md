# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: anything may change between alphas).

## [0.1.0-alpha.4] - 2026-10-07

### Added

- **Customizable overview**: the overview is a dashboard of widgets (recent sessions, summary tiles, cost and tokens per day, activity heatmap, token mix, tools, models, projects). "Customize layout" moves a card earlier or later, sets its width (3, 4, 6, 8 or 12 of 12 columns) and height preset, hides it, adds it back, or resets the layout. Every control is a keyboard-accessible button. The layout lives in `user.db`, so it survives database rebuilds; cards collapse to full width on narrow screens, and a hidden card runs no queries.
- **Filters in a side panel**: on the overview, the filter row and the Customize button no longer take two rows above the dashboard. A "Filters" tab on the right edge of the window opens a drawer with the time range, tool, project, the applied search and filter chips, and "Customize layout"; the tab's badge counts the active filters. The drawer stays open while filters change, and the tab, the close button, Escape or a click outside closes it. While customizing, the Done / Add widget / Reset bar sits above the grid. The other pages keep their filter row.
- **Sessions first**: the most recent sessions appear as a row of cards at the top of the dashboard (tool, project, last activity, cost, tags, subagents, a pulse while running), one to five depending on the window width. They replace the "Recent sessions" table at the bottom.
- **What happened on a day**: clicking a day in "Cost per day" or "Tokens per day" opens a panel with that day's sessions, their prompts, tools, changed files, tokens and cost, and a link to all of them. The errors chart drills into a day's errors and the usage windows into their sessions; on a session page, each bar of "Context per request" jumps to its event and shows the prompt that was running.
- **Custom date window**: `from`/`to` days in the URL (set by those drill-downs) override the range on every page, link and export; the filters show the window with a button to clear it.

### Fixed

- **Resume command on Windows**: the session page now shows PowerShell syntax (`Set-Location -LiteralPath '…' -ErrorAction Stop; claude --resume …`) when the dashboard runs on Windows; `cd '<C:\…>' && …` failed in cmd.exe and Windows PowerShell 5.1. Other systems are unchanged.
- **`pnpm build:native` while the server runs**: it now says to stop the server that has the search addon loaded, instead of reporting a failed download and crashing in the cargo fallback.
- **Charts and the keyboard**: a chart is one tab stop; arrow keys, Home and End move between days (announced to screen readers), Enter opens the day. Axis labels meet 4.5:1 contrast on the light theme.

### Changed

- **Sync reads only what an agent appended**: a log that only grew is read from where the last sync stopped; just the new bytes are parsed, hashed, auto-tagged, archived and stored. One sync after an appended turn of a 14 MiB session went from about 550–690 ms to 11–15 ms. A rewritten or shrunk log, `--full` and writes by another process still read the whole file.
- **Adapter contract**: adapters are incremental parsers (`Adapter.parser(path)` with `push(line)` and `result()`) instead of `parse(path, content)`; `parseLog` derives the whole-file parse. An event `result()` returned never changes.
- Stopping `pnpm demo` on Windows ends the whole `next dev` process tree.

## [0.1.0-alpha.3] - 2026-10-06

### Fixed

- **Windows paths in the analysis views**: file paths written as `C:\…`, `c:\…` or relative `src\a.ts` were treated as relative POSIX paths. The file tree, project map, file heat, resource map, turns and loop reasons now show them relative to the project (or under `~/`), and the different spellings of one file count as one file.
- **Large edits lost their files**: tool input clipped at 6,000 characters became invalid JSON, so big writes, omp edits and `apply_patch` calls dropped out of file tracking. Long values are now shortened inside the JSON, and patch file headers are kept.
- **Parent cycles**: a malformed log whose sessions are each other's parent could inflate counts, stall a page or hide the sessions from the list; the cycle is now broken when the sessions are stored, and every subagent tree lists each session once.
- **Timeline paging**: "Show earlier" could jump back to the newest events instead of reaching the start of a session.
- **Selections jumping**: a live refresh that added a file or subagent could make the selected file, zoomed flame agent or open file-heat row point at a different item.
- **Crashes on bad URLs**: `#e-%` in the address, `?view=constructor` on the export, fractional or huge page numbers and timeline positions now fall back instead of failing; download names are slugged. A root-layout failure shows a page with a retry button.
- **Archive**: an unreadable copy is recorded and skipped until it changes instead of being re-read every 5 s; a damaged copy reads back every part that still decodes; when two archived copies hold one session the fuller one wins; an archived log whose import failed because the database was busy is retried. When a tool shrinks or rewrites a log, the copy it replaces is kept next to it (`.prev`) instead of being overwritten.
- **Legacy Codex rollouts** (without the `payload` envelope) are read; a log with no recognizable line is reported as failed instead of silently storing nothing.

### Changed

- **Faster always-on syncing**: the archive appends only the new part of a grown log, the archive is listed once per server start, new indexes cover the overview, timeline, heatmap, tools and project filters, and the project file map re-parses only sessions that changed.
- **Live updates**: only pages affected by a sync refresh (a session page for its own tree, a project map for its project), Back and Forward catch up on changes made meanwhile, "synced N ago" keeps counting on every page, and hidden tabs close their live connection.
- `pnpm watch` keeps running after a failed sync.
- **First start**: the top bar appears at once and shows import progress while the first sync runs.
- **Sync health in the top bar**: a failing sync and an unavailable or lagging search index are shown, with the full message on hover.
- **Fresh install**: the overview and projects pages list the folders that were scanned and how to point agent-monitor elsewhere.
- **Session page**: the timeline shows at most 1,000 events at a time, with "Jump to latest"; the page sends less data to the browser.
- The database schema version is now 5. The cache rebuilds itself once from your logs and archive; tags in `user.db` are kept.
- CI also runs on Windows, and on Node 22.13.0 (the minimum) and 24.x.

## [0.1.0-alpha.2] - 2026-10-06

### Fixed

- **Windows addon without the Visual C++ runtime**: the search addon now links the C runtime statically, so it loads on PCs without the Visual C++ Redistributable.
- **Missing search addon**: when the addon is missing or fails to load, the dashboard keeps working and only search reports why it is unavailable (HTTP 503, and the message in the search palette). A page that fails to render now shows an error page with a retry button.
- **Auto-tag crash**: a command such as `pnpm pnpm i` made tag detection recurse until the stack overflowed, so that session was never stored.
- **Huge logs**: a log too large to read into memory (over about 512 MiB) stopped every sync. It is now reported as failed and skipped until it changes.
- **Unknown model versions**: a newer version of a known model (e.g. `claude-opus-5-6`) was priced like an older one; it now stays unpriced until you add its price. Variants such as `claude-opus-5-5-fast` are still priced.
- **"0 failed"**: a passing test summary in the output of a failed command was counted as a test failure.
- **Archive**: a failed archive copy is retried (at most once a minute) instead of waiting for the log to change, shows in the top bar's failed count, and no longer leaves a temporary file behind.
- **Moved logs**: when a tool moves a log (Codex archiving a session to `archived_sessions/`), rebuilding the database or `sync --full` no longer replaces the live session with the archived copy from the old path.

### Changed

- `pnpm dev`, `build`, `start` and `demo` run Next.js with its telemetry switched off (`scripts/next.mjs`).

## [0.1.0-alpha.1] - 2026-10-06

First public alpha. Everything below is new relative to the private prototype.

### Added

- **Resource map** (`/sessions/<id>/graph`): a full-page map of everything a session tree worked on: files by folder, shell commands by binary, web pages by domain, web searches, code searches, subagents, and other tools including MCP servers. Kind toggles, changed-only, errors-only, agent focus and a time-range brush, all kept in the URL.
- **Dispatch prompts**: each subagent shows the exact instructions its parent sent, on its own page, in the parent's subagent table, and in the flame and map tooltips.
- **Flame graph**: the session tree over time, with tool calls colored by category. "Width by cost" splits spend down to single model requests. Zoom, keyboard navigation and deep links.
- **Turns**: one row per prompt with active time, requests, tokens, cost, tool calls by category, files changed, errors and subagents.
- **Context & compaction**: context per request stacked by cache read, cache write and uncached input, with compaction markers. Markers come from Claude Code, omp and Codex records, or are inferred from large drops. Any agent in the tree can be picked.
- **File heat & retry loops**: files ranked by touches, with edit loops, failing-command loops and repeated failed calls flagged. New `loop` auto-tag.
- **Projects** (`/projects`, `/projects/map`): every working directory with its totals, plus a treemap of every file agents touched in a project, a file panel listing every call across sessions, and a hot-files table.
- **Gource export**: `/api/export?view=gource&session=…` or `&project=…` produces a log you can play back in Gource.
- **Errors page** (`/errors`): failures from all agents sorted into categories, with a daily trend, tool and agent breakdowns, and linked examples.
- **Activity heatmap** on the overview: calendar plus weekday × hour, by events, cost or sessions.
- **Demo dataset**: `pnpm demo` serves a deterministic synthetic dataset on port 4200 with isolated storage, and `pnpm demo:data` regenerates it.
- **Prebuilt search addon**: `pnpm build:native` downloads a SHA256-verified binary from the GitHub release and builds with cargo only as a fallback.
- MIT license, CI, release workflow, issue forms, CONTRIBUTING.md and SECURITY.md.

### Fixed

- **Timeline filter**: choosing an event type (e.g. Replies or Errors) could show an empty timeline, because it filtered only the loaded page. Filtering now runs on the server and paging moves through matching events only. Errors now also includes failed tool results.
- **Double-counted usage**: requests copied into forked or resumed Claude Code sessions (`/branch`, `--fork-session`) and forked Codex rollouts are counted once, in the original session.
- **Codex forks**: a forked rollout could take over its parent's session.
- **Codex 0.160+ usage**: usage is now read from `token_usage_record` lines (keyed by response id), and Codex cache-write tokens are counted.
- **Windows archive**: logs read back from the archive got a broken path (`\C\Users\…` instead of `C:\Users\…`), so every log was ingested twice, once live and once from the archive.

### Changed

- The database schema version is now 4. The cache rebuilds itself from your logs and archive on first start; tags in `user.db` are kept.
