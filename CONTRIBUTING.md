# Contributing to Agent Monitor

Thanks for helping. Agent Monitor is in **alpha** (`0.1.0-alpha.x`): the UI, the database schema and the CLI can change between releases. The database is a cache that is rebuilt from the logs and the archive on schema changes, so breaking changes there are cheap; your tags in `user.db` are kept.

## Setup

- Node **22.13 or newer** (the built-in `node:sqlite` is required) and **pnpm** (the version is pinned in `package.json` → `packageManager`; `corepack enable` picks it up).
- Rust (`cargo`, from <https://rustup.rs>) only if you change the search addon in `native/search`, or if no prebuilt addon is available for your platform.

```bash
pnpm install
pnpm build:native   # search addon: downloads the prebuilt binary, or builds it with cargo
pnpm dev            # http://127.0.0.1:4100
pnpm check          # addon + typecheck + tests; run before every PR
```

### The search addon

`pnpm build:native` writes `native/agent_monitor_search.node`:

1. It downloads the prebuilt addon for your platform from the GitHub release matching the `package.json` version and verifies it against that release's `SHA256SUMS`. Prebuilt binaries exist for Linux x64/arm64 (glibc), macOS arm64/x64 and Windows x64.
2. If that fails (offline, an unreleased version, an unsupported platform, a checksum mismatch), it builds from source with cargo.

It builds from source directly when `AGENT_MONITOR_BUILD_FROM_SOURCE=1` is set, or when a previous cargo build exists in `native/search/target` (so once you have built the addon yourself, your Rust changes are always used). `AGENT_MONITOR_BUILD_FROM_SOURCE=0` forces the download. CI always builds from source.

## Architecture

The data flow is: tool logs → adapter → normalized session → SQLite → Next.js UI / CLI, with a gzip archive of every log and a Rust/tantivy full-text index on the side. See [README → How it works](README.md#how-it-works) and the layout notes in [CLAUDE.md](CLAUDE.md):

- `src/core/types.ts`: the normalized schema, the stable contract between adapters and everything else.
- `src/adapters/`: one parser per tool, registered in `src/adapters/index.ts`.
- `src/ingest/`: incremental sync and the log archive.
- `src/store/`: schema (`db.ts`) and all reads (`queries.ts`; every query takes the same `Filters`).
- `native/search` + `src/search/`: the full-text index and query parser.
- `app/`: Next.js App Router; server components read SQLite directly.

## Adding an agent

1. Create `src/adapters/<tool>.ts` that implements `Adapter` (`roots`, `match`, `parse`, optionally `resumeCommand`). Adapters are pure (`parse(path, content)`). Parse leniently: skip lines you don't understand, and expect the last line to be half-written while the tool is running.
2. Register it in `src/adapters/index.ts`. Its color in the charts comes from its position in that list.
3. Add a small synthetic fixture under `test/fixtures/<tool>/` and tests in `test/adapters.test.ts`.

Storage, CLI and UI pick it up automatically. Costs: a tool's own recorded cost wins; otherwise the cost is estimated from `src/core/pricing.ts`. Never guess prices for unknown models; leave them unpriced.

## Fixtures and privacy

Session logs contain private prompts, file contents, paths and often secrets. **Never commit real session logs or real database content**, not even trimmed or "harmless" ones, and never paste them into issues or PRs. Fixtures are written by hand: copy the structure of the format and fill every value with placeholder text. The same applies to screenshots: use synthetic data.

## Conventions

- **Colors** come from CSS tokens in `app/globals.css` (a validated categorical palette, light and dark). Never hard-code hex values in components.
- **Charts** are hand-rolled SVG (see `app/components/StackedBarChart.tsx`); no chart libraries.
- **Pixel design language**: square corners; Geist Pixel Square only for display type (brand, h1, h2, tile figures), sans/mono everywhere else. Animations respect the Motion preference (`<html data-motion>`) and reduced motion.
- **Loopback only**: the dev and prod servers bind to `127.0.0.1`, and `proxy.ts` refuses requests whose `Host` header is not a loopback name. Keep both.
- Rows from `node:sqlite` have a null prototype; copy them into plain objects before passing them to client components.
- This project uses a recent Next.js with breaking changes; check `node_modules/next/dist/docs/` before using an API you are unsure about.
- Prefer small, boring code over abstractions. Add focused tests for parsing, query and aggregation logic.

## Commits and pull requests

- One topic per PR; open an issue first for larger changes or new views so the design can be discussed.
- Write commit messages in the imperative, describing what changes and why ("Parse Codex tool calls from function_call items").
- `pnpm check` must pass; CI runs it on Linux and macOS together with `next build`.
- Fill in the pull request template, including screenshots for UI changes (light and dark) and the privacy confirmation.
- Report security issues privately, see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
