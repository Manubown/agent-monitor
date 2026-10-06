# Improvements and ideas

Backlog from the code review of 0.1.0-alpha.1 (2026-10-06). The eight most urgent findings are fixed under
`[Unreleased]` in [CHANGELOG.md](../CHANGELOG.md); everything below is still open. File references are as of that
review. Marked *unverified* where the finding was inferred rather than reproduced.

## Things to improve

### Windows

- [ ] **Analysis views treat paths as POSIX** (`src/core/activity.ts:40-46`, `src/store/activity.ts:208-216`, `src/core/filetree.ts:39-42`). `C:\…` is not absolute to `path.posix`, so the file tree and project map come out flat, `displayPath` never shortens, and `src\a.ts` plus its absolute form count as two files. Fix: one helper that turns `\` into `/`, treats `^[A-Za-z]:/` as absolute and case-folds the drive letter; Windows fixtures.
- [ ] **Resume command is POSIX shell** (`src/core/adapter.ts:46-52`, shown on the session page): `cd '<C:\…>' && claude --resume …` fails in cmd.exe and Windows PowerShell 5.1. Emit `Set-Location -LiteralPath '…'; …` on win32.
- [ ] **Archive round trip depends on the drive letter's case** (`src/ingest/archive.ts`, `originalPath`): a root spelled `c:\…` comes back as `C:\…` and would be ingested twice (*unverified*). Upper-case the drive letter, compare paths case-insensitively on win32, add a `path.win32` round-trip test.
- [ ] **CI never runs on Windows** (`.github/workflows/ci.yml:22`). Add `windows-latest`; also the Node 22.13 floor and Node 24 (only `22.x` today).
- [ ] **`pnpm build:native` fails while the server runs** (`scripts/build-native.mjs:80,116`): the loaded addon cannot be replaced, the error reads "download failed" and it falls back to cargo. Detect EPERM/EBUSY and tell the user to stop the server first.
- [ ] Data lives under `%USERPROFILE%\.local\share\agent-monitor` (`src/store/db.ts:119`, `src/core/pricing.ts:56`); `%LOCALAPPDATA%` is the Windows convention. Needs a migration of the archive and `user.db`.

### Performance (matters for always-on use)

- [ ] **Sync re-processes whole files** (`src/ingest/sync.ts`, live loop): any growth re-reads, re-gzips and re-parses the entire log and recomputes hashes, auto-tags and usage, on the Next server's event loop every 5 s. Keep a byte offset and parser state per append-only log, append gzip members to the archive, run sync in a worker.
- [ ] **Every sync walks all roots and lists the whole archive** (`listArchive`). List the archive only at startup or with `--full`; consider `fs.watch` plus a periodic full scan.
- [ ] **Missing indexes** (`src/store/db.ts:60-77`): nothing on `events(ts, session_id, kind)` or `sessions(cwd)`, so the overview, heatmap, timeline and `byTool` scan the largest table on every render. Needs a `SCHEMA_VERSION` bump.
- [ ] **Projects cache keyed on the database generation** (`src/store/projects.ts:125-139,351-352`), which changes every 5 s while an agent works, so `/projects` re-parses every project's file operations. Cache per session keyed by `events_hash`.
- [ ] **Every write refreshes every open page** (`app/components/client.tsx:130-134`, `app/lib/server.ts` listeners): the sync event carries only a count. Send the changed session ids and cwds and refresh only affected pages; memoize the session analyses per (id, generation).
- [ ] **One `EventSource` per tab, hidden or not** (`app/components/client.tsx:114,140`): with about 6 tabs the HTTP/1.1 connection limit stalls navigation and search. Close the stream while hidden (the `hello` generation check already catches up).
- [ ] **The root layout waits for the first full sync** (`app/layout.tsx:31`): a fresh install with GBs of logs shows a blank tab for minutes. Render the shell at once and stream content behind Suspense with import progress.
- [ ] **Unbounded session page payload** (`app/sessions/[id]/page.tsx:311,469`): `SessionActivity` receives `resources` it never uses, and "Show earlier" grows the window by 200 events per click without a cap.

### Correctness and robustness

- [ ] **Clipped tool input breaks file tracking** (`MAX_TOOL_TEXT` in `src/ingest/sync.ts`, `src/core/activity.ts:82-92,113-115`): clipping at 6,000 characters makes the JSON invalid, so large omp edits and `apply_patch` calls lose their file operations in activity, turns, project map and loops. Extract file operations before clipping, or clip inside string values.
- [ ] **Two recursive CTEs lack the depth guard** (`src/store/queries.ts:395,483`) every other tree query has; a parent cycle in a malformed log would hang the server (*unverified*).
- [ ] **Selections stored as array indices** (`app/components/graph/SessionActivity.tsx:20-24`, NodeGraph, ResourceMap, FlameGraph `root`): a live refresh that adds a file in an earlier subagent shifts them, and the panel shows another file's calls. Key by path or agent id.
- [ ] **`decodeURIComponent` on the URL hash** (`app/components/search/TargetEvent.tsx:29-35`) throws on `#e-%`; it runs in the root layout, which `app/error.tsx` does not cover. Wrap it in try/catch; consider `app/global-error.tsx`.
- [ ] **Unvalidated query parameters**: `?page=1.01` (`app/sessions/page.tsx:26`), `?view=constructor` (`app/api/export/route.ts:103`), the raw `source` in `Content-Disposition`. Clamp, use `Object.hasOwn`, slug.
- [ ] **Sync failures only reach the console** (`app/lib/server.ts`): a thrown sync or `indexError` never shows in the UI, and "synced N ago" just grows. Keep the last error in state and show it (and "search unavailable") in the top bar.
- [ ] **Empty state on a fresh install** (`app/page.tsx:142-147`, `/projects`): "No agent activity in this range" with no hint. When there are no files, list the roots that were scanned.
- [ ] **Corrupt archive copies are re-read every sync** (archive pass in `syncAll`): the read error is reported but not recorded, so the gunzip repeats every 5 s.
- [ ] **Two archived-only copies of one session**: whichever the archive pass reads last wins.
- [ ] **Legacy Codex rollouts** without the `payload` wrapper parse to nothing without an error (`src/adapters/codex.ts:141-142`, *unverified*).

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
