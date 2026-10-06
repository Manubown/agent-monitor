# Agent Monitor

Local Next.js dashboard that ingests AI agent session logs (omp, Claude Code, Codex) into SQLite. See README.md for usage.

## Layout

- `src/core/types.ts`: normalized schema. Treat it as the stable contract between adapters and everything else.
- `src/adapters/`: one parser per tool, registered in `index.ts`. Adapters are pure (`parse(path, content)`) and must tolerate unknown or half-written lines.
- `src/ingest/sync.ts`: incremental sync (size + mtime); each file is written in one transaction, appending only new events when the stored prefix is unchanged (`events_hash`); keeps the search index at the database's `generation`. `archive.ts` keeps a gzip copy of every log; history survives tools pruning theirs.
- `src/store/`: `db.ts` (schema; the main database is a cache: bump `SCHEMA_VERSION` and it is rebuilt from live logs + archive; user data lives in the attached `user.db` and is never dropped) and `queries.ts` (core reads; every query takes the same `Filters`). Analysis is computed at read time, with one module per view: `activity.ts` (session tree tool calls, files and resources; feeds the graphs), `turns.ts`, `flame.ts`, `loops.ts`, `projects.ts`, `insights.ts` (heatmap, errors), `dispatch.ts` (subagent dispatch prompts via `sessions.dispatch_seq`). Pure logic lives in `src/core/` (`resources.ts`, `compaction.ts`, `loops.ts`, `errors.ts`, `heatmap.ts`, `filetree.ts`, `gource.ts`). Usage rows carry a `request_id`; sync keeps each request in exactly one session (forks and resumes copy them).
- `native/search` (Rust, tantivy, napi-rs) + `src/search/`: full-text index (`native.ts` is the only binding), query parser and search service.
- `app/`: Next.js App Router, server components read SQLite directly via `app/lib/server.ts`. Charts are hand-rolled SVG in `app/components/StackedBarChart.tsx` (bars masked into pixel cells; exact values in tooltip and table). `app/components/pixel/` holds the animated band (Canvas 2D in `field.ts`, colors from the `--field-*` tokens) and the Motion preference that also gates the stepped CSS hover animations via `<html data-motion>`. Display type (brand, h1, h2, tile figures) is Geist Pixel Square from the `geist` package; everything else stays sans/mono. `proxy.ts` rejects non-loopback `Host` headers.
- `scripts/demo.ts`: deterministic synthetic dataset for all three adapters (`pnpm demo` serves it on port 4200 with isolated storage under `.demo/`). README screenshots in `docs/screenshots/` come from it, never from real logs.

## Rules

- Use pnpm. Node >= 22.13 (built-in `node:sqlite`). The only native code is the search addon; build it with `pnpm build:native` (needs `cargo`).
- Run `pnpm check` (addon + typecheck + vitest) before finishing.
- Test fixtures are synthetic. Never copy real session logs into the repo; they contain private prompts and file contents.
- Costs: a tool's own recorded cost wins; otherwise estimate from `src/core/pricing.ts`; never guess prices for unknown models (leave them unpriced).
- Colors come from CSS tokens in `app/globals.css` (validated categorical palette, light + dark). Never hard-code hex values in components.
- The dev and prod servers bind to 127.0.0.1 and `proxy.ts` must keep refusing other hosts. Keep it that way.
- Rows from `node:sqlite` have a null prototype; copy them into plain objects before passing them to client components.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
