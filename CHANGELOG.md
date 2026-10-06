# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: anything may change between alphas).

## [0.1.0-alpha.1] - 2026-10-05

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

### Changed

- The database schema version is now 4. The cache rebuilds itself from your logs and archive on first start; tags in `user.db` are kept.
