/**
 * Synthetic demo dataset for Agent Monitor: invented projects, prompts and tool output, nothing real.
 *
 *   pnpm demo:data              write a fresh dataset to .demo/ (replaces the previous demo logs and demo database)
 *   pnpm demo                   generate it if missing, then serve it at http://127.0.0.1:4200 with isolated
 *                               storage (.demo/data: database, user.db, search index, archive)
 *   pnpm demo --live            regenerate, then keep appending to the most recent session every few seconds
 *   tsx scripts/demo.ts env     print shell exports pointing the CLI at the dataset:
 *                               eval "$(tsx scripts/demo.ts env)" && pnpm sync && pnpm stats
 *   --out <dir>                 dataset directory for any command (default .demo)
 *
 * Content is deterministic (seeded PRNG); timestamps are relative to now and cover four weeks with a weekday and
 * working-hours rhythm. Logs use each tool's on-disk format and layout under <out>/logs:
 *   omp/<cwd-slug>/<iso>_<id>.jsonl, subagents in <iso>_<id>/<Task>.jsonl (nested: <Task>/<Sub>.jsonl)
 *   claude/projects/<cwd-slug>/<uuid>.jsonl, subagents in <uuid>/subagents/agent-<id>.jsonl
 *   codex/sessions/YYYY/MM/DD/rollout-<local time>-<uuid>.jsonl, subagents linked via session_meta
 * Next.js allows one `next dev` per project directory, so stop `pnpm dev` before `pnpm demo`.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PRICES, normalizeModel } from "../src/core/pricing";

// ---------------------------------------------------------------------------------------------------------------
// Randomness and time

let seed = 0x5eeda11;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const chance = (p: number): boolean => rand() < p;
const hex = (n: number): string => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
const uuid = (): string => `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(["8", "9", "a", "b"])}${hex(3)}-${hex(12)}`;
const uuid7 = (ms: number): string => {
  const h = ms.toString(16).padStart(12, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${hex(3)}-${pick(["8", "9", "a", "b"])}${hex(3)}-${hex(12)}`;
};

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();
const pad2 = (n: number): string => String(n).padStart(2, "0");
const clock = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const tok = (s: string | undefined): number => (s ? Math.ceil(s.length / 3.7) : 0);

// ---------------------------------------------------------------------------------------------------------------
// Projects

const HOME = "/home/demo";

interface Project {
  key: "web" | "orbit" | "ledger" | "infra";
  name: string;
  cwd: string;
  test: string;
  lint: string;
  /** Files with a one-line description, used by the short "chore" sessions. */
  notes: Record<string, string>;
  /** [old name, new name, defining file, other files using it]. */
  symbols: [string, string, string, string[]][];
  /** [question topic, grep pattern, answer file]. */
  configs: [string, string, string][];
}

const WEB: Project = {
  key: "web",
  name: "acme-web",
  cwd: `${HOME}/src/acme-web`,
  test: "pnpm test",
  lint: "pnpm lint",
  notes: {
    "lib/db.ts": "wraps the Postgres pool and exposes typed helpers per table (`orders`, `products`, `users`)",
    "lib/auth.ts": "verifies the session cookie, loads the user and throws a 401 response when it is missing or expired",
    "app/api/orders/route.ts": "is the orders API: `POST` validates the cart with zod and creates an order, `GET` lists the caller's last 50 orders",
    "components/ProductCard.tsx": "renders one product tile with price, stock badge and the add-to-cart button",
    "lib/money.ts": "holds the money helpers: `roundCents`, `orderTotal` (subtotal plus tax) and `formatPrice`",
    "middleware.ts": "redirects signed-out users away from /account and /checkout and sets the locale cookie",
  },
  symbols: [
    ["getOrderById", "findOrderById", "lib/db.ts", ["app/api/orders/[id]/route.ts", "app/(shop)/account/orders/page.tsx"]],
    ["formatPrice", "formatMoney", "lib/money.ts", ["components/ProductCard.tsx", "components/CartDrawer.tsx", "app/(shop)/checkout/page.tsx"]],
    ["useCart", "useCartStore", "lib/cart.ts", ["components/CartDrawer.tsx", "components/ProductCard.tsx"]],
  ],
  configs: [
    ["the session cookie lifetime", "maxAge", "lib/auth.ts"],
    ["allowed image domains", "remotePatterns", "next.config.ts"],
    ["the database connection string", "DATABASE_URL", "lib/db.ts"],
  ],
};

const ORBIT: Project = {
  key: "orbit",
  name: "orbit-api",
  cwd: `${HOME}/src/orbit-api`,
  test: "cargo test",
  lint: "cargo clippy --all-targets -- -D warnings",
  notes: {
    "src/main.rs": "builds the axum router, opens the sqlx pool and starts the server with graceful shutdown",
    "src/routes/telemetry.rs": "accepts telemetry samples per satellite and writes them in batches",
    "src/db/pool.rs": "configures the Postgres pool (max 20 connections, 5 s acquire timeout) and runs migrations on boot",
    "src/auth/jwt.rs": "validates bearer tokens against the JWKS cache and extracts the tenant id",
    "src/error.rs": "defines `ApiError` and maps it to HTTP status codes and JSON bodies",
  },
  symbols: [
    ["fetch_orbit", "load_orbit", "src/db/orbits.rs", ["src/routes/orbits.rs", "src/routes/telemetry.rs"]],
    ["TenantId", "TenantKey", "src/auth/jwt.rs", ["src/routes/orbits.rs", "src/db/orbits.rs"]],
  ],
  configs: [
    ["the request timeout", "TimeoutLayer", "src/main.rs"],
    ["the pool size", "max_connections", "src/db/pool.rs"],
  ],
};

const LEDGER: Project = {
  key: "ledger",
  name: "ledger-py",
  cwd: `${HOME}/src/ledger-py`,
  test: "uv run pytest -q",
  lint: "uv run ruff check .",
  notes: {
    "ledger/reconcile.py": "matches bank transactions to ledger entries by amount, date window and reference",
    "ledger/importers/csv_import.py": "parses bank CSV exports into `Transaction` objects, one dialect per bank",
    "ledger/models.py": "defines the `Account`, `Entry` and `Transaction` dataclasses",
    "ledger/currency.py": "converts between currencies with daily rates and rounds with `Decimal`",
    "ledger/cli.py": "is the typer CLI: `import`, `reconcile` and `report` commands",
  },
  symbols: [
    ["match_entries", "pair_entries", "ledger/reconcile.py", ["ledger/cli.py", "tests/test_reconcile.py"]],
    ["parse_amount", "parse_money", "ledger/importers/csv_import.py", ["ledger/importers/ofx_import.py", "tests/test_csv_import.py"]],
  ],
  configs: [
    ["the date tolerance for matching", "DATE_WINDOW", "ledger/reconcile.py"],
    ["the default currency", "DEFAULT_CURRENCY", "ledger/currency.py"],
  ],
};

const INFRA: Project = {
  key: "infra",
  name: "infra",
  cwd: `${HOME}/src/infra`,
  test: "make test",
  lint: "make lint",
  notes: {
    "k8s/api/deployment.yaml": "runs the orbit API with 3 replicas, readiness probe on /healthz and resource limits",
    ".github/workflows/deploy.yml": "builds images on main, pushes them to the registry and rolls out to staging",
    "scripts/backup.sh": "dumps the Postgres databases nightly, compresses them and uploads to object storage",
    "docker-compose.yml": "starts Postgres, Redis and MinIO for local development",
  },
  symbols: [["BACKUP_BUCKET", "BACKUP_TARGET", "scripts/backup.sh", ["k8s/cron/backup.yaml", ".github/workflows/nightly.yml"]]],
  configs: [
    ["the API memory limit", "memory:", "k8s/api/deployment.yaml"],
    ["the staging namespace", "namespace:", "k8s/api/kustomization.yaml"],
  ],
};

const PROJECTS = [WEB, ORBIT, LEDGER, INFRA];

/** Plausible file content for a read; known files have fixed bodies so later edits quote real lines. */
const BODIES: Record<string, string> = {
  "acme-web/app/api/orders/route.ts": `import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";

const CreateOrder = z.object({
  items: z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })).min(1),
  couponCode: z.string().optional(),
});

export async function POST(req: Request) {
  const user = await requireUser(req);
  const body = CreateOrder.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
  const order = await db.orders.create({ userId: user.id, ...body.data });
  return NextResponse.json(order, { status: 201 });
}

export async function GET(req: Request) {
  const user = await requireUser(req);
  const orders = await db.orders.list({ userId: user.id, limit: 50 });
  return NextResponse.json(orders);
}`,
  "acme-web/lib/money.ts": `export function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function orderTotal(lines: { price: number; qty: number }[], taxRate: number, discount = 0): number {
  const subtotal = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
  return roundCents((subtotal - discount) * (1 + taxRate));
}

export const formatPrice = (cents: number, currency = "EUR") =>
  new Intl.NumberFormat("en-IE", { style: "currency", currency }).format(cents / 100);`,
  "orbit-api/src/routes/telemetry.rs": `use axum::{extract::{Path, State}, Json};
use serde::Deserialize;

use crate::{db, error::ApiError, AppState};

#[derive(Deserialize)]
pub struct Sample {
    pub ts: i64,
    pub altitude_km: f64,
    pub velocity_kms: f64,
}

pub async fn ingest(
    State(state): State<AppState>,
    Path(sat_id): Path<i64>,
    Json(sample): Json<Sample>,
) -> Result<(), ApiError> {
    db::telemetry::insert(&state.pool, sat_id, &sample).await?;
    Ok(())
}`,
  "ledger-py/ledger/reconcile.py": `from datetime import timedelta
from decimal import Decimal

from ledger.models import Entry, Transaction

DATE_WINDOW = timedelta(days=3)


def match_entries(transactions: list[Transaction], entries: list[Entry]) -> list[tuple[Transaction, Entry]]:
    matches = []
    for tx in transactions:
        for entry in entries:
            if abs(tx.amount) == abs(entry.amount) and abs(tx.date - entry.date) <= DATE_WINDOW:
                matches.append((tx, entry))
    return matches


def balance(entries: list[Entry]) -> Decimal:
    return sum((e.amount for e in entries), Decimal("0"))`,
  "infra/k8s/api/deployment.yaml": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: orbit-api
  labels:
    app: orbit-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: orbit-api
  template:
    metadata:
      labels:
        app: orbit-api
    spec:
      containers:
        - name: api
          image: registry.example.com/orbit-api:0.7.2
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
          resources:
            requests: { cpu: 250m, memory: 256Mi }
            limits: { cpu: "1", memory: 512Mi }`,
  "infra/scripts/backup.sh": `#!/usr/bin/env bash
set -euo pipefail

STAMP=$(date +%Y%m%d-%H%M)
BACKUP_BUCKET=\${BACKUP_BUCKET:-s3://example-backups/postgres}

for db in orbit ledger; do
  pg_dump --format=custom "$db" > /tmp/$db-$STAMP.dump
  gzip -f /tmp/$db-$STAMP.dump
  aws s3 cp /tmp/$db-$STAMP.dump.gz $BACKUP_BUCKET/
done`,
};

function fileBody(p: Project, rel: string): string {
  const known = BODIES[`${p.name}/${rel}`];
  if (known) return known;
  const base = path.posix.basename(rel).replace(/\.[^.]+$/, "");
  const camel = base.replace(/[-_.](\w)/g, (_, c: string) => c.toUpperCase());
  const ext = path.posix.extname(rel);
  if (ext === ".ts" || ext === ".tsx") {
    if (rel.includes("test")) {
      return `import { describe, expect, it } from "vitest";\nimport { ${camel} } from "@/lib/${base.replace(".test", "")}";\n\ndescribe("${camel}", () => {\n  it("handles the empty case", () => {\n    expect(${camel}([])).toEqual([]);\n  });\n\n  it("keeps input order", () => {\n    expect(${camel}([3, 1, 2])).toEqual([3, 1, 2]);\n  });\n});`;
    }
    if (ext === ".tsx") {
      const C = camel.charAt(0).toUpperCase() + camel.slice(1);
      return `"use client";\n\nimport { useState } from "react";\nimport { formatPrice } from "@/lib/money";\n\nexport function ${C}({ product }: { product: Product }) {\n  const [adding, setAdding] = useState(false);\n  return (\n    <article className="card">\n      <h3>{product.name}</h3>\n      <p className="price">{formatPrice(product.priceCents)}</p>\n      <button disabled={adding || product.stock === 0} onClick={() => setAdding(true)}>\n        Add to cart\n      </button>\n    </article>\n  );\n}`;
    }
    return `import { cache } from "react";\nimport { pool } from "./pool";\n\nexport const ${camel} = cache(async (id: string) => {\n  const { rows } = await pool.query("select * from ${base} where id = $1", [id]);\n  return rows[0] ?? null;\n});\n\nexport async function list${camel.charAt(0).toUpperCase() + camel.slice(1)}(limit = 50) {\n  const { rows } = await pool.query("select * from ${base} order by created_at desc limit $1", [limit]);\n  return rows;\n}`;
  }
  if (ext === ".rs") {
    return `use sqlx::PgPool;\n\nuse crate::error::ApiError;\n\npub async fn ${base}(pool: &PgPool, id: i64) -> Result<Option<Row>, ApiError> {\n    let row = sqlx::query_as!(Row, "select * from ${base} where id = $1", id)\n        .fetch_optional(pool)\n        .await?;\n    Ok(row)\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[sqlx::test]\n    async fn missing_row_is_none(pool: PgPool) {\n        assert!(${base}(&pool, 42).await.unwrap().is_none());\n    }\n}`;
  }
  if (ext === ".py") {
    if (rel.startsWith("tests/")) {
      return `import pytest\n\nfrom ledger.${base.replace("test_", "")} import *  # noqa: F403\n\n\ndef test_empty_input():\n    assert ${base.replace("test_", "")}_rows([]) == []\n\n\n@pytest.mark.parametrize("raw,expected", [("1,50", "1.50"), ("-3,00", "-3.00")])\ndef test_amounts(raw, expected):\n    assert str(parse_amount(raw)) == expected`;
    }
    return `from __future__ import annotations\n\nfrom dataclasses import dataclass\nfrom decimal import Decimal\n\n\n@dataclass(frozen=True)\nclass ${camel.charAt(0).toUpperCase() + camel.slice(1)}:\n    id: str\n    amount: Decimal\n    currency: str = "EUR"\n\n\ndef load(path: str) -> list[${camel.charAt(0).toUpperCase() + camel.slice(1)}]:\n    with open(path, encoding="utf-8") as fh:\n        return [parse(line) for line in fh if line.strip()]`;
  }
  if (ext === ".yaml" || ext === ".yml") {
    return `name: ${base}\non:\n  push:\n    branches: [main]\n\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: pnpm/action-setup@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - run: pnpm install --frozen-lockfile\n      - run: pnpm build`;
  }
  if (ext === ".sh") return `#!/usr/bin/env bash\nset -euo pipefail\n\nNAMESPACE=\${NAMESPACE:-staging}\nkubectl -n "$NAMESPACE" get secret ${base}-tls -o jsonpath='{.metadata.annotations}'`;
  if (ext === ".toml") return `[package]\nname = "orbit-api"\nversion = "0.7.2"\nedition = "2021"\n\n[dependencies]\naxum = "0.8"\nsqlx = { version = "0.8", features = ["postgres", "runtime-tokio", "macros"] }\ntokio = { version = "1", features = ["full"] }\nserde = { version = "1", features = ["derive"] }`;
  if (ext === ".json") return `{\n  "name": "acme-web",\n  "private": true,\n  "scripts": {\n    "dev": "next dev",\n    "build": "next build",\n    "test": "vitest run",\n    "lint": "eslint ."\n  }\n}`;
  if (ext === ".md") return `# ${base}\n\nLocal setup:\n\n1. Copy \`.env.example\` to \`.env\`.\n2. Start the services with \`docker compose up -d\`.\n3. Run the dev server.`;
  return `# ${rel}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Tool output

const vitestPass = (p: Project, t: number, files: [string, number][]): string => {
  const total = files.reduce((n, [, c]) => n + c, 0);
  return ` RUN  v3.2.4 ${p.cwd}\n\n${files.map(([f, n]) => ` ✓ ${f} (${n} tests) ${int(20, 300)}ms`).join("\n")}\n\n Test Files  ${files.length} passed (${files.length})\n      Tests  ${total} passed (${total})\n   Start at  ${clock(t)}\n   Duration  ${(1 + rand() * 2).toFixed(2)}s`;
};

const vitestFail = (p: Project, t: number, file: string, name: string, expected: string, received: string, line: number): string =>
  ` RUN  v3.2.4 ${p.cwd}\n\n ❯ ${file} (8 tests | 1 failed) ${int(20, 90)}ms\n   × ${name} ${int(3, 20)}ms\n     → expected ${received} to be ${expected} // Object.is equality\n\n FAIL  ${file} > ${name}\nAssertionError: expected ${received} to be ${expected} // Object.is equality\n\n- Expected\n+ Received\n\n- ${expected}\n+ ${received}\n\n ❯ ${file}:${line}:19\n\n Test Files  1 failed | 3 passed (4)\n      Tests  1 failed | 37 passed (38)\n   Start at  ${clock(t)}\n   Duration  ${(1 + rand() * 2).toFixed(2)}s\n\n ELIFECYCLE  Test failed. See above for more details.`;

const cargoTestPass = (n: number): string =>
  `   Compiling orbit-api v0.7.2 (${ORBIT.cwd})\n    Finished \`test\` profile [unoptimized + debuginfo] target(s) in ${(15 + rand() * 25).toFixed(2)}s\n     Running unittests src/main.rs (target/debug/deps/orbit_api-${hex(16)})\n\nrunning ${n} tests\ntest result: ok. ${n} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.${int(10, 90)}s\n\n     Running tests/telemetry.rs (target/debug/deps/telemetry-${hex(16)})\n\nrunning 6 tests\ntest result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.${int(10, 90)}s`;

const pytestPass = (n: number): string =>
  `============================= test session starts ==============================\nplatform linux -- Python 3.12.6, pytest-8.3.3, pluggy-1.5.0\nrootdir: ${LEDGER.cwd}\nconfigfile: pyproject.toml\ncollected ${n} items\n\ntests/test_csv_import.py ..........                                      [ 24%]\ntests/test_reconcile.py ...............                                  [ 60%]\ntests/test_currency.py ................                                  [100%]\n\n============================== ${n} passed in 0.${int(40, 99)}s ==============================`;

const pytestFail = (test: string, detail: string, n: number): string =>
  `============================= test session starts ==============================\nplatform linux -- Python 3.12.6, pytest-8.3.3, pluggy-1.5.0\nrootdir: ${LEDGER.cwd}\ncollected ${n} items\n\ntests/test_csv_import.py ....F.....                                      [ 24%]\ntests/test_reconcile.py ...............                                  [ 60%]\ntests/test_currency.py ................                                  [100%]\n\n=================================== FAILURES ===================================\n_________________________________ ${test} _________________________________\n\n${detail}\n=========================== short test summary info ============================\nFAILED tests/test_csv_import.py::${test}\n========================= 1 failed, ${n - 1} passed in 0.${int(40, 99)}s =========================`;

const testPass = (p: Project, t: number): string =>
  p.key === "web"
    ? vitestPass(p, t, [["tests/orders.test.ts", 14], ["tests/cart.test.ts", 9], ["tests/checkout-total.test.ts", 8], ["tests/auth.test.ts", 7]])
    : p.key === "orbit"
      ? cargoTestPass(int(20, 30))
      : p.key === "ledger"
        ? pytestPass(int(38, 46))
        : `kubeconform -summary -strict k8s/\nSummary: 23 resources found in 14 files - Valid: 23, Invalid: 0, Errors: 0, Skipped: 0\nbats tests/\n1..9\nok 1 backup.sh refuses to run without BACKUP_BUCKET\nok 2 backup.sh dumps every database\n...\nok 9 rotate-certs.sh is idempotent`;

const commitOut = (branch: string, msg: string, files: number, ins: number, del: number, created?: string): string =>
  `[${branch} ${hex(7)}] ${msg}\n ${files} file${files === 1 ? "" : "s"} changed, ${ins} insertions(+), ${del} deletions(-)${created ? `\n create mode 100644 ${created}` : ""}`;

const searchOut = (results: [string, string][]): string =>
  results.map(([title, url], i) => `${i + 1}. ${title}\n   ${url}`).join("\n");

// ---------------------------------------------------------------------------------------------------------------
// Session model

type Tool = "omp" | "claude" | "codex";

interface SubTask {
  name: string;
  task: string;
}

type Action =
  | { k: "read"; path: string }
  | { k: "write"; path: string; content: string }
  | { k: "edit"; path: string; old: string; neu: string }
  | { k: "rm"; path: string }
  | { k: "mv"; path: string; to: string }
  | { k: "grep"; pattern: string; path?: string }
  | { k: "glob"; pattern: string }
  | { k: "bash"; cmd: string; desc?: string }
  | { k: "search"; query: string }
  | { k: "fetch"; url: string; prompt?: string }
  | { k: "mcp"; name: string; args: Record<string, unknown> }
  | { k: "spawn"; context: string; agents: SubTask[] };

interface Call {
  id: string;
  a: Action;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

type Entry =
  | { k: "user"; ts: number; text: string }
  | { k: "inject"; ts: number; text: string }
  | { k: "model"; ts: number; model: string }
  | { k: "req"; ts: number; model: string; think?: string; say?: string; calls: Call[]; usage: Usage }
  | { k: "result"; ts: number; call: Call; part: number; text?: string; err: boolean; exit?: number; dur: number }
  | { k: "compact"; ts: number; preTokens: number; summary: string }
  | { k: "apiError"; ts: number; model: string; text: string };

interface Session {
  tool: Tool;
  id: string;
  /** Subagent name (omp file name, Codex agent role). */
  name?: string;
  project: Project;
  branch: string;
  model: string;
  title?: string;
  depth: number;
  start: number;
  end: number;
  entries: Entry[];
  children: Session[];
}

interface Spec {
  a: Action;
  out?: string;
  err?: boolean;
  exit?: number;
  dur?: number;
  extra?: number;
  /** Subagents: run them from `start`, returning each one's final report and end time. */
  run?: (start: number) => { text: string; end: number }[];
}

interface Step {
  think?: string;
  say?: string;
  calls?: Spec[];
}

interface Agent {
  name: string;
  task: string;
  model?: string;
  run: (c: Builder) => string;
}

/** Base prompt size per harness: system prompt, tool definitions, context files. */
const BASE: Record<Tool, number> = { omp: 15_500, claude: 21_000, codex: 9_000 };

const DUR: Record<Action["k"], [number, number]> = {
  read: [30, 180],
  write: [20, 120],
  edit: [20, 140],
  rm: [20, 80],
  mv: [20, 80],
  grep: [80, 700],
  glob: [50, 300],
  bash: [300, 3000],
  search: [1500, 4500],
  fetch: [900, 5000],
  mcp: [800, 2500],
  spawn: [0, 0],
};

const EXTRA: Record<Action["k"], [number, number]> = {
  read: [600, 4500],
  write: [60, 300],
  edit: [80, 400],
  rm: [10, 40],
  mv: [10, 40],
  grep: [200, 1200],
  glob: [100, 400],
  bash: [100, 900],
  search: [1200, 2600],
  fetch: [2500, 8000],
  mcp: [200, 600],
  spawn: [0, 0],
};

class Builder {
  readonly s: Session;
  t: number;
  private ctx = 0;
  private pending: number;
  private lastReq = 0;
  private cold = true;

  constructor(tool: Tool, project: Project, start: number, o: { model: string; title?: string; branch?: string; depth?: number; name?: string }) {
    const depth = o.depth ?? 0;
    this.s = {
      tool,
      id: tool === "omp" ? uuid7(start) : uuid(),
      name: o.name,
      project,
      branch: o.branch ?? "main",
      model: o.model,
      title: o.title,
      depth,
      start,
      end: start,
      entries: [],
      children: [],
    };
    this.t = start;
    this.pending = depth > 0 ? 7_000 : BASE[tool];
  }

  private push(e: Entry): void {
    this.s.entries.push(e);
    if (e.ts > this.s.end) this.s.end = e.ts;
  }

  /** A human prompt (a subagent's first prompt is the task its parent sent). */
  user(text: string, gapSec?: number): this {
    if (this.s.entries.length) this.t += (gapSec ?? int(40, 300)) * SEC;
    this.push({ k: "user", ts: this.t, text });
    this.pending += tok(text) + 20;
    this.t += int(400, 1500);
    return this;
  }

  /** Text the harness injected (reminders, todo nudges). */
  inject(text: string): this {
    this.push({ k: "inject", ts: this.t, text });
    this.pending += tok(text);
    return this;
  }

  idle(minutes: number): this {
    this.t += minutes * MIN + int(0, 59) * SEC;
    return this;
  }

  model(model: string): this {
    this.s.model = model;
    this.push({ k: "model", ts: this.t, model });
    return this;
  }

  /** One model request: optional thinking and text, then its tool calls run one after another. */
  step(o: Step): this {
    const specs = o.calls ?? [];
    const calls: Call[] = specs.map((sp) => ({ id: hex(24), a: sp.a }));
    const output = tok(o.think) + tok(o.say) + calls.reduce((n, c) => n + tok(JSON.stringify(c.a)), 0) + int(40, 260) + (o.think ? int(150, 900) : 0);
    this.t += int(1_500, 4_000) + Math.round((output / int(40, 80)) * SEC);
    const warm = !this.cold && this.t - this.lastReq < 5 * MIN;
    const cacheRead = warm ? this.ctx : 0;
    const fresh = (warm ? 0 : this.ctx) + this.pending;
    const usage: Usage =
      this.s.tool === "codex"
        ? { input: fresh, cacheRead, cacheWrite: 0, output, reasoning: o.think ? Math.round(output * 0.6) : int(0, 40) }
        : { input: int(1, 9), cacheRead, cacheWrite: fresh, output, reasoning: 0 };
    this.ctx += this.pending + output;
    this.pending = 0;
    this.lastReq = this.t;
    this.cold = false;
    this.push({ k: "req", ts: this.t, model: this.s.model, think: o.think, say: o.say, calls, usage });

    specs.forEach((sp, i) => {
      const call = calls[i];
      if (sp.run) {
        const start = this.t + int(300, 900);
        const parts = sp.run(start).map((p, part) => ({ ...p, part }));
        for (const p of [...parts].sort((x, y) => x.end - y.end)) {
          this.push({ k: "result", ts: p.end + int(100, 600), call, part: p.part, text: p.text, err: false, dur: p.end - start });
          this.pending += tok(p.text) + 40;
        }
        this.t = Math.max(...parts.map((p) => p.end)) + int(700, 1500);
        return;
      }
      const [lo, hi] = DUR[sp.a.k];
      const dur = sp.dur ?? int(lo, hi);
      this.t += dur;
      const text = sp.out ?? (sp.a.k === "read" ? fileBody(this.s.project, sp.a.path) : undefined);
      this.push({ k: "result", ts: this.t, call, part: 0, text, err: sp.err === true, exit: sp.exit, dur });
      const [elo, ehi] = EXTRA[sp.a.k];
      this.pending += tok(text) + (sp.extra ?? int(elo, ehi)) + 25;
      this.t += int(80, 400);
    });
    return this;
  }

  say(say: string, think?: string): this {
    return this.step({ say, think });
  }

  /** Spawn subagents in parallel from one call; each runs in its own session. */
  spawn(context: string, agents: Agent[], o: { think?: string; say?: string } = {}): this {
    return this.step({
      ...o,
      calls: [
        {
          a: { k: "spawn", context, agents: agents.map(({ name, task }) => ({ name, task })) },
          run: (start) =>
            agents.map((agent) => {
              const c = new Builder(this.s.tool, this.s.project, start + int(200, 1500), {
                model: agent.model ?? this.s.model,
                branch: this.s.branch,
                depth: this.s.depth + 1,
                name: agent.name,
              });
              c.user(agent.task);
              const report = agent.run(c);
              c.say(report);
              const child = c.done();
              this.s.children.push(child);
              return { text: report, end: child.end };
            }),
        },
      ],
    });
  }

  /** A failed model request (rate limit, overload), retried after a pause. */
  apiError(text: string): this {
    this.t += int(2, 8) * SEC;
    this.push({ k: "apiError", ts: this.t, model: this.s.model, text });
    this.t += int(8, 30) * SEC;
    return this;
  }

  /** Context compaction: the conversation is replaced by a summary. */
  compact(summary: string): this {
    this.t += int(30, 70) * SEC;
    this.push({ k: "compact", ts: this.t, preTokens: this.ctx + this.pending, summary });
    this.ctx = 0;
    this.pending = BASE[this.s.tool] + tok(summary) + int(8_000, 12_000);
    this.cold = true;
    return this;
  }

  // Spec helpers.
  read = (path: string, o: Partial<Spec> = {}): Spec => ({ a: { k: "read", path }, ...o });
  write = (path: string, content: string, o: Partial<Spec> = {}): Spec => ({ a: { k: "write", path, content }, ...o });
  edit = (path: string, old: string, neu: string, o: Partial<Spec> = {}): Spec => ({ a: { k: "edit", path, old, neu }, ...o });
  rm = (path: string): Spec => ({ a: { k: "rm", path } });
  mv = (path: string, to: string): Spec => ({ a: { k: "mv", path, to } });
  grep = (pattern: string, out: string, path?: string): Spec => ({ a: { k: "grep", pattern, path }, out });
  glob = (pattern: string, out: string): Spec => ({ a: { k: "glob", pattern }, out });
  sh = (cmd: string, out: string, o: Partial<Spec> & { desc?: string } = {}): Spec => ({ a: { k: "bash", cmd, desc: o.desc }, out, ...o });
  search = (query: string, out: string, o: Partial<Spec> = {}): Spec => ({ a: { k: "search", query }, out, ...o });
  fetch = (url: string, out: string, prompt?: string): Spec => ({ a: { k: "fetch", url, prompt }, out });
  mcp = (name: string, args: Record<string, unknown>, out: string, o: Partial<Spec> = {}): Spec => ({ a: { k: "mcp", name, args }, out, ...o });

  test = (o: { fail?: string; dur?: number } = {}): Spec =>
    this.sh(this.s.project.test, o.fail ?? testPass(this.s.project, this.t), { err: o.fail !== undefined, exit: o.fail ? 1 : 0, dur: o.dur ?? int(4_000, 25_000), desc: "Run the test suite" });

  commit = (msg: string, files: number, created?: string): Spec =>
    this.sh(`git add -A && git commit -m "${msg}"`, commitOut(this.s.branch, msg, files, int(12, 160), int(0, 40), created), { dur: int(200, 900), desc: "Commit the changes" });

  done(): Session {
    return this.s;
  }
}

function shiftSession(s: Session, delta: number): void {
  s.start += delta;
  s.end += delta;
  for (const e of s.entries) e.ts += delta;
  for (const c of s.children) shiftSession(c, delta);
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios: one function per scripted session

const NO_FILE = (p: Project, rel: string) => `ENOENT: no such file or directory, open '${p.cwd}/${rel}'`;

function rateLimit(b: Builder): void {
  const p = b.s.project;
  b.user("Add rate limiting to the /api/orders endpoint. Something simple: per user, maybe 30 requests a minute.");
  b.step({
    think: "Check whether there is already a limiter somewhere before writing one. Then look at the route.",
    calls: [b.grep("rateLimit|rate-limit|ratelimit", "No matches found", "lib"), b.read("lib/ratelimit.ts", { out: NO_FILE(p, "lib/ratelimit.ts"), err: true })],
  });
  b.apiError("overloaded_error: Overloaded");
  b.step({ calls: [b.read("app/api/orders/route.ts"), b.read("lib/db.ts")] });
  const limiter = `const WINDOW_MS = 60_000;\nconst buckets = new Map<string, { tokens: number; updated: number }>();\n\n/** Token bucket per key; returns false when the caller must wait. */\nexport function take(key: string, limit = 30): boolean {\n  const now = Date.now();\n  const b = buckets.get(key) ?? { tokens: limit, updated: now };\n  b.tokens = Math.min(limit, b.tokens + ((now - b.updated) / WINDOW_MS) * limit);\n  b.updated = now;\n  if (b.tokens < 1) return false;\n  b.tokens -= 1;\n  buckets.set(key, b);\n  return true;\n}`;
  b.step({
    think: "No limiter yet. An in-memory token bucket keyed by user id is enough for a single instance; mention Redis for multi-instance.",
    say: "There is no limiter yet. I'll add a small token bucket in `lib/rate-limit.ts` and use it in both handlers.",
    calls: [b.write("lib/rate-limit.ts", limiter)],
  });
  b.step({
    calls: [
      b.edit(
        "app/api/orders/route.ts",
        "  const user = await requireUser(req);\n  const body = CreateOrder.safeParse(await req.json());",
        '  const user = await requireUser(req);\n  if (!take(`orders:${user.id}`)) return NextResponse.json({ error: "Too many requests" }, { status: 429 });\n  const body = CreateOrder.safeParse(await req.json());',
      ),
    ],
  });
  b.step({
    calls: [
      b.edit("app/api/orders/route.ts", "  const orders = await db.orders.list({ userId: user.id, limit: 50 });", "  if (!take(`orders:${user.id}`)) return tooMany();\n  const orders = await db.orders.list({ userId: user.id, limit: 50 });", {
        err: true,
        out: "Edit rejected: line 21 changed since the last read (hash mismatch). Re-read the file and retry.",
      }),
    ],
  });
  b.step({ calls: [b.read("app/api/orders/route.ts:18-24", { out: "18:export async function GET(req: Request) {\n19:  const user = await requireUser(req);\n20:  const orders = await db.orders.list({ userId: user.id, limit: 50 });\n21:  return NextResponse.json(orders);\n22:}" })] });
  b.step({
    calls: [
      b.edit("app/api/orders/route.ts", "  const orders = await db.orders.list({ userId: user.id, limit: 50 });", '  if (!take(`orders:${user.id}`)) return NextResponse.json({ error: "Too many requests" }, { status: 429 });\n  const orders = await db.orders.list({ userId: user.id, limit: 50 });'),
      b.write(
        "tests/rate-limit.test.ts",
        `import { describe, expect, it, vi } from "vitest";\nimport { take } from "@/lib/rate-limit";\n\ndescribe("take", () => {\n  it("allows up to the limit, then refuses", () => {\n    for (let i = 0; i < 30; i++) expect(take("u1")).toBe(true);\n    expect(take("u1")).toBe(false);\n  });\n\n  it("refills over time", () => {\n    vi.useFakeTimers();\n    for (let i = 0; i < 30; i++) take("u2");\n    vi.advanceTimersByTime(2_000);\n    expect(take("u2")).toBe(true);\n  });\n});`,
      ),
    ],
  });
  b.step({ calls: [b.test({ fail: vitestFail(p, b.t, "tests/rate-limit.test.ts", "take > refills over time", "true", "false", 13) })] });
  b.step({
    think: "Fake timers are installed after the first take() stored Date.now() from the real clock... no, the bucket for u2 is created under fake time but the fake clock starts at the real now, fine. The issue: vi.useFakeTimers() must come before the loop - it does. Actually 2s refills 30*2/60 = 1 token, floating point gives 0.9999. Use >= with a small epsilon or advance 2_100.",
    calls: [b.edit("tests/rate-limit.test.ts", "    vi.advanceTimersByTime(2_000);", "    vi.advanceTimersByTime(2_100);")],
  });
  b.step({ calls: [b.test(), b.sh("pnpm exec tsc --noEmit", "", { dur: int(6_000, 14_000), desc: "Typecheck" })] });
  b.say("Done. `/api/orders` now answers 429 after 30 requests per minute per user (token bucket in `lib/rate-limit.ts`, tests in `tests/rate-limit.test.ts`). It is in-memory, so with several instances each one counts separately; a Redis bucket would fix that if you need it.");
  b.user("Make the limit configurable via env and commit");
  b.step({
    calls: [
      b.edit("lib/rate-limit.ts", "export function take(key: string, limit = 30): boolean {", "const DEFAULT_LIMIT = Number(process.env.ORDERS_RATE_LIMIT) || 30;\n\nexport function take(key: string, limit = DEFAULT_LIMIT): boolean {"),
      b.edit(".env.example", "DATABASE_URL=postgres://localhost:5432/acme", "DATABASE_URL=postgres://localhost:5432/acme\nORDERS_RATE_LIMIT=30"),
    ],
  });
  b.step({ calls: [b.test(), b.commit("Add per-user rate limiting to /api/orders", 4, "lib/rate-limit.ts")] });
  b.say("Committed on `feat/orders-rate-limit`. The limit comes from `ORDERS_RATE_LIMIT` (default 30) and is documented in `.env.example`.");
}

function flakyCheckout(b: Builder): void {
  const p = b.s.project;
  b.user("The checkout total test fails on CI about half the time. Can you make orderTotal deterministic and get tests green?");
  b.step({ calls: [b.read("lib/money.ts"), b.read("tests/checkout-total.test.ts")] });
  b.step({ calls: [b.test({ fail: vitestFail(p, b.t, "tests/checkout-total.test.ts", "orderTotal > applies tax after discounts", "107.1", "107.09", 41) })] });
  const attempts: [string, string, string][] = [
    ["  return roundCents((subtotal - discount) * (1 + taxRate));", "  return Math.round((subtotal - discount) * (1 + taxRate) * 100) / 100;", "107.09"],
    ["  return Math.round((subtotal - discount) * (1 + taxRate) * 100) / 100;", "  return Number(((subtotal - discount) * (1 + taxRate)).toFixed(2));", "107.09"],
    ["  return Number(((subtotal - discount) * (1 + taxRate)).toFixed(2));", "  return roundCents(roundCents(subtotal - discount) * (1 + taxRate));", "107.11"],
    ["  return Math.round(value * 100) / 100;", "  return Math.round((value + Number.EPSILON) * 100) / 100;", "107.11"],
    ["  return roundCents(roundCents(subtotal - discount) * (1 + taxRate));", "  const net = roundCents(subtotal - discount);\n  return roundCents(net + net * taxRate);", "107.11"],
    ["  const subtotal = lines.reduce((sum, l) => sum + l.price * l.qty, 0);", "  const subtotal = lines.reduce((sum, l) => sum + Math.round(l.price * 100) * l.qty, 0) / 100;", "107.09"],
    ["  const net = roundCents(subtotal - discount);\n  return roundCents(net + net * taxRate);", "  const netCents = Math.round((subtotal - discount) * 100);\n  return Math.round(netCents * (1 + taxRate)) / 100;", "107.11"],
    ["  return Math.round(netCents * (1 + taxRate)) / 100;", "  const taxCents = Math.round(netCents * taxRate);\n  return (netCents + taxCents) / 100;", "107.09"],
  ];
  const thoughts = [
    "Floating point: 89.99 * 1.19 = 107.0881 but with the discount path it is 107.09499999. Try rounding the product directly.",
    "Same result. toFixed rounds half-to-even-ish on binary values; try it anyway.",
    "Round the net amount first, then apply tax.",
    "Overshoots now. Maybe the EPSILON trick in roundCents.",
    "Still 107.11. Compute tax separately from the rounded net.",
    "Work in integer cents for the subtotal.",
    "Integer cents for net, multiply by 1+tax, round once.",
    "Round tax in cents separately and add. The expected value in the test assumes tax is rounded per line, not on the total.",
  ];
  attempts.forEach(([old, neu, got], i) => {
    b.step({ think: thoughts[i], calls: [b.edit("lib/money.ts", old, neu)] });
    b.step({ calls: [b.test({ fail: vitestFail(p, b.t, "tests/checkout-total.test.ts", "orderTotal > applies tax after discounts", "107.1", got, 41), dur: int(3_000, 6_000) })] });
  });
  b.step({
    think: "The test expects per-line tax rounding (that's what the invoice service does). Implement that: tax per line in cents, rounded, summed.",
    say: "The expectation is per-line tax rounding, which is what the invoices use. Switching `orderTotal` to that.",
    calls: [
      b.edit(
        "lib/money.ts",
        "  const taxCents = Math.round(netCents * taxRate);\n  return (netCents + taxCents) / 100;",
        "  const lineCents = lines.map((l) => Math.round(l.price * 100) * l.qty);\n  const share = (c: number) => c - Math.round((discount * 100 * c) / Math.max(1, netCents + Math.round(discount * 100)));\n  const taxCents = lineCents.reduce((sum, c) => sum + Math.round(share(c) * taxRate), 0);\n  return (netCents + taxCents) / 100;",
      ),
    ],
  });
  b.step({ calls: [b.test()] });
  b.step({ calls: [b.sh(`for i in $(seq 20); do pnpm vitest run tests/checkout-total.test.ts --silent || exit 1; done && echo "20/20 green"`, "20/20 green", { dur: int(40_000, 70_000), desc: "Run the test 20 times" })] });
  b.say("Fixed: `orderTotal` now works in integer cents and rounds tax per line, matching the invoice service, so the result no longer depends on float ordering. The test passed 20 runs in a row. It took a while because the test encodes per-line rounding, which I only spotted after trying several total-level roundings.");
  b.user("great, commit it");
  b.step({ calls: [b.commit("Compute order totals in integer cents with per-line tax", 2)] });
  b.say("Committed.");
}

function dialogMigration(b: Builder): void {
  b.user("Move the cart components into components/cart/ and replace the old Modal in CartDrawer with the new Dialog from components/ui");
  b.step({
    calls: [
      b.glob("components/**/*.tsx", "components/CartDrawer.tsx\ncomponents/CartLine.tsx\ncomponents/CartSummary.tsx\ncomponents/Modal.tsx\ncomponents/ProductCard.tsx\ncomponents/ui/Dialog.tsx\ncomponents/ui/Button.tsx"),
      b.grep("from \"@/components/(CartDrawer|CartLine|CartSummary|Modal)\"", "app/(shop)/layout.tsx:4:import { CartDrawer } from \"@/components/CartDrawer\";\ncomponents/CartDrawer.tsx:3:import { Modal } from \"@/components/Modal\";\ncomponents/CartDrawer.tsx:4:import { CartLine } from \"@/components/CartLine\";\ncomponents/CartDrawer.tsx:5:import { CartSummary } from \"@/components/CartSummary\";"),
    ],
  });
  b.step({ calls: [b.read("components/CartDrawer.tsx"), b.read("components/ui/Dialog.tsx")] });
  b.step({
    say: "Moving the three cart components first, then updating imports.",
    calls: [b.mv("components/CartDrawer.tsx", "components/cart/CartDrawer.tsx"), b.mv("components/CartLine.tsx", "components/cart/CartLine.tsx"), b.mv("components/CartSummary.tsx", "components/cart/CartSummary.tsx")],
  });
  b.step({
    calls: [
      b.write("components/cart/index.ts", 'export { CartDrawer } from "./CartDrawer";\nexport { CartLine } from "./CartLine";\nexport { CartSummary } from "./CartSummary";'),
      b.edit("app/(shop)/layout.tsx", 'import { CartDrawer } from "@/components/CartDrawer";', 'import { CartDrawer } from "@/components/cart";'),
      b.edit(
        "components/cart/CartDrawer.tsx",
        'import { Modal } from "@/components/Modal";\nimport { CartLine } from "@/components/CartLine";\nimport { CartSummary } from "@/components/CartSummary";',
        'import { Dialog, DialogContent, DialogTitle } from "@/components/ui/Dialog";\nimport { CartLine } from "./CartLine";\nimport { CartSummary } from "./CartSummary";',
      ),
      b.edit("components/cart/CartDrawer.tsx", "    <Modal open={open} onClose={onClose} title=\"Your cart\">", "    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>\n      <DialogContent side=\"right\">\n        <DialogTitle>Your cart</DialogTitle>"),
    ],
  });
  b.step({
    calls: [
      b.sh(
        "pnpm build",
        `   ▲ Next.js 16.3.8\n   Creating an optimized production build ...\nFailed to compile.\n\n./components/cart/CartDrawer.tsx:31:7\nType error: Property 'side' does not exist on type 'IntrinsicAttributes & DialogContentProps'.\n\n  29 |     <Dialog open={open} onOpenChange={(o) => !o && onClose()}>\n> 31 |       <DialogContent side="right">\n     |                      ^\n\nNext.js build worker exited with code: 1`,
        { err: true, exit: 1, dur: int(25_000, 50_000), desc: "Build" },
      ),
    ],
  });
  b.step({
    think: "Dialog has no side prop; the drawer variant is `variant=\"sheet\"` per components/ui/Dialog.tsx.",
    calls: [b.edit("components/cart/CartDrawer.tsx", '      <DialogContent side="right">', '      <DialogContent variant="sheet">'), b.grep("Modal", "No matches found outside components/Modal.tsx", "app")],
  });
  b.step({ say: "Nothing else uses the old Modal, removing it.", calls: [b.rm("components/Modal.tsx"), b.mv("tests/CartDrawer.test.tsx", "tests/cart/CartDrawer.test.tsx")] });
  b.step({ calls: [b.sh("pnpm build", "   ▲ Next.js 16.3.8\n   Creating an optimized production build ...\n ✓ Compiled successfully in 21.4s\n ✓ Generating static pages (18/18)\n\nRoute (app)                         Size  First Load JS\n┌ ○ /                              4.1 kB         118 kB\n├ ƒ /api/orders                       0 B            0 B\n└ ○ /checkout                      6.3 kB         127 kB", { dur: int(30_000, 55_000), desc: "Build" }), b.test()] });
  b.step({ calls: [b.commit("Move cart components to components/cart and use Dialog", 7, "components/cart/index.ts")] });
  b.say("Cart components now live in `components/cart/` with an index barrel; `CartDrawer` uses the `Dialog` sheet variant and the old `Modal` is gone. Build and tests pass.");
}

function cachingResearch(b: Builder): void {
  b.inject("<system-reminder>The user opened the file app/(shop)/products/[slug]/page.tsx in the IDE.</system-reminder>");
  b.user("Before we change anything: compare our options for caching the product pages (ISR, cache tags, full-route cache). Prices change a few times a day. No code changes, just a recommendation.");
  b.step({
    think: "Research first: how the page fetches today, then the current Next.js caching docs.",
    calls: [
      b.read("app/(shop)/products/[slug]/page.tsx", { out: 'import { getProduct } from "@/lib/db";\n\nexport const dynamic = "force-dynamic";\n\nexport default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {\n  const { slug } = await params;\n  const product = await getProduct(slug);\n  return <ProductView product={product} />;\n}' }),
      b.grep("revalidate|unstable_cache|\"use cache\"|cacheTag", "No matches found"),
    ],
  });
  b.spawn(
    "Research for product page caching in a Next.js 16 app",
    [
      {
        name: "Explore",
        task: "Find every place that reads product or price data (lib/db.ts helpers, route handlers, server components) and list which ones would need cache invalidation when a price changes.",
        model: "claude-haiku-4-5-20251001",
        run: (c) => {
          c.step({ calls: [c.grep("getProduct|listProducts|priceCents", "lib/db.ts:12:export async function getProduct(slug: string) {\nlib/db.ts:20:export async function listProducts(category?: string) {\napp/(shop)/products/[slug]/page.tsx:7:  const product = await getProduct(slug);\napp/(shop)/page.tsx:9:  const featured = await listProducts(\"featured\");\napp/api/admin/prices/route.ts:14:  await db.products.updatePrice(sku, priceCents);")] });
          c.step({ calls: [c.read("app/api/admin/prices/route.ts", { out: 'export async function PUT(req: Request) {\n  const { sku, priceCents } = await req.json();\n  await db.products.updatePrice(sku, priceCents);\n  return new Response(null, { status: 204 });\n}' })] });
          return "Product data is read in 3 places: product page (`getProduct`), home page featured list (`listProducts`), and the cart. Prices change only through `PUT /api/admin/prices`, which is the single place to invalidate.";
        },
      },
      {
        name: "docs-reader",
        task: "Summarize the current Next.js docs on `use cache`, cacheTag/revalidateTag and ISR (revalidate) with their trade-offs.",
        model: "claude-haiku-4-5-20251001",
        run: (c) => {
          c.step({ calls: [c.fetch("https://nextjs.org/docs/app/api-reference/directives/use-cache", "The `use cache` directive marks a route, component or function as cacheable. Cached output is reused until its cacheLife expires or a tag is revalidated...", "Summarize use cache and cacheLife")] });
          c.step({ calls: [c.fetch("https://nextjs.org/docs/app/api-reference/functions/revalidateTag", "revalidateTag purges cached data for a specific cache tag on demand. Call it from a Server Action or Route Handler after a mutation...", "How does revalidateTag interact with use cache")] });
          return "`use cache` + `cacheTag(product:<sku>)` caches per product; `revalidateTag` from the price route invalidates exactly the affected pages. ISR (`revalidate = 3600`) is simpler but serves stale prices for up to the window.";
        },
      },
    ],
    { say: "Splitting this: one agent maps where product data is read, another summarizes the docs." },
  );
  b.step({ calls: [b.search("next.js 16 use cache cacheTag revalidateTag product pages", searchOut([["Directives: use cache | Next.js", "https://nextjs.org/docs/app/api-reference/directives/use-cache"], ["Functions: cacheTag | Next.js", "https://nextjs.org/docs/app/api-reference/functions/cacheTag"], ["Guides: Caching | Next.js", "https://nextjs.org/docs/app/guides/caching"]]))] });
  b.step({ calls: [b.search("ISR vs on-demand revalidation ecommerce prices", "Error: 429 Too Many Requests (rate limit exceeded, retry after 20s)", { err: true })] });
  b.step({ calls: [b.search("ISR vs on-demand revalidation ecommerce prices", searchOut([["Incremental Static Regeneration | Next.js", "https://nextjs.org/docs/app/guides/incremental-static-regeneration"], ["On-demand revalidation patterns for commerce", "https://vercel.com/guides/on-demand-isr"]]))] });
  b.step({ calls: [b.fetch("https://nextjs.org/docs/app/guides/incremental-static-regeneration", "ISR lets you update static content without rebuilding the site. Set `export const revalidate = 60`...", "time-based vs on-demand"), b.fetch("https://nextjs.org/docs/app/guides/caching", "Next.js caches data and rendered output. This guide explains the full route cache, data cache and request memoization...", "full route cache behaviour with dynamic params")] });
  b.step({ calls: [b.read("lib/db.ts"), b.read("next.config.ts", { out: 'import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = {\n  images: { remotePatterns: [{ hostname: "cdn.example.com" }] },\n};\n\nexport default nextConfig;' })] });
  b.step({ calls: [b.search("cacheComponents next.config cacheLife profiles", searchOut([["next.config.js: cacheComponents", "https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheComponents"], ["Functions: cacheLife", "https://nextjs.org/docs/app/api-reference/functions/cacheLife"]]))] });
  b.say(
    "Recommendation: **`use cache` with per-product tags**.\n\n1. Mark `getProduct`/`listProducts` with `\"use cache\"` and `cacheTag(\\`product:${sku}\\`)`, `cacheLife(\"hours\")` as a safety net.\n2. In `PUT /api/admin/prices` call `revalidateTag(\\`product:${sku}\\`)` (and `products:featured` when needed).\n3. Drop `dynamic = \"force-dynamic\"` from the product page.\n\nWhy not plain ISR: a 1h window means stale prices after each update; a short window just moves the load back to the database. Full-route cache alone has no per-product invalidation. Prices change a few times a day, so on-demand tags give fresh prices with near-static cost.",
    "Synthesize: on-demand tags win given a single mutation point.",
  );
  b.user("What breaks if the admin route forgets to revalidate?");
  b.say("Pages keep the old price until `cacheLife` expires (hours with the profile above). Cart and checkout recompute totals server-side from the database, so customers would never be charged the stale price, only see it on the product page. A test that calls the admin route and asserts `revalidateTag` was called would guard it.");
}

function zodUpgrade(b: Builder): void {
  b.user("Upgrade zod to v4 and fix whatever breaks");
  b.step({ think: "**Checking current zod usage**", calls: [b.sh("rg -n \"from \\\"zod\\\"\" --stats | tail -n 3", "app/api/orders/route.ts:2:import { z } from \"zod\";\nlib/env.ts:1:import { z } from \"zod\";\napp/api/admin/prices/route.ts:2:import { z } from \"zod\";\n\n3 matches\n3 files contained matches")] });
  b.step({ calls: [b.sh("pnpm add zod@^4", "Packages: +1 -1\n+-\nProgress: resolved 412, reused 398, downloaded 1, added 1, done\n\ndependencies:\n- zod 3.24.1\n+ zod 4.1.5\n\nDone in 3.8s", { dur: int(3_000, 9_000) })] });
  b.step({
    calls: [
      b.sh(
        "pnpm exec tsc --noEmit",
        "app/api/orders/route.ts(14,72): error TS2339: Property 'flatten' does not exist on type 'ZodError<{ items: { sku: string; qty: number; }[]; couponCode?: string | undefined; }>'.\nlib/env.ts(6,34): error TS2554: Expected 1-2 arguments, but got 0.\napp/api/admin/prices/route.ts(9,22): error TS2339: Property 'nonempty' does not exist on type 'ZodString'.\n\nFound 3 errors in 3 files.",
        { err: true, exit: 2, dur: int(7_000, 15_000) },
      ),
    ],
  });
  b.step({
    think: "**Applying v4 migrations**\n\n`error.flatten()` → `z.flattenError(error)`; `z.string().url()` → `z.url()`; `.nonempty()` → `.min(1)`.",
    calls: [
      b.edit("app/api/orders/route.ts", "  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 });", "  if (!body.success) return NextResponse.json({ error: z.flattenError(body.error) }, { status: 400 });"),
      b.edit("lib/env.ts", "  DATABASE_URL: z.string().url(),", "  DATABASE_URL: z.url(),"),
      b.edit("app/api/admin/prices/route.ts", "  sku: z.string().nonempty(),", "  sku: z.string().min(1),"),
    ],
  });
  b.step({ calls: [b.sh("pnpm exec tsc --noEmit", "", { dur: int(7_000, 15_000) }), b.test()] });
  b.step({ calls: [b.commit("Upgrade zod to v4", 4)] });
  b.say("zod is on 4.1.5. Three call sites needed the v4 API (`z.flattenError`, `z.url()`, `.min(1)`); typecheck and tests pass, committed.");
}

function openPr(b: Builder): void {
  b.user("Open a PR for feat/orders-rate-limit against main, mention the env var");
  b.step({ calls: [b.sh("git status -sb && git log --oneline main..HEAD", "## feat/orders-rate-limit...origin/feat/orders-rate-limit [ahead 1]\n3f9c2a1 Add per-user rate limiting to /api/orders", { dur: 150 })] });
  b.step({ calls: [b.sh("git push -u origin feat/orders-rate-limit", "To github.com:acme-demo/acme-web.git\n   a41be07..3f9c2a1  feat/orders-rate-limit -> feat/orders-rate-limit", { dur: int(1_500, 3_000) })] });
  b.step({
    calls: [
      b.mcp(
        "mcp__github__create_pull_request",
        { owner: "acme-demo", repo: "acme-web", head: "feat/orders-rate-limit", base: "main", title: "Rate limit /api/orders per user", body: "Adds a token bucket (30 req/min per user, `ORDERS_RATE_LIMIT`) to both order handlers.\n\n- 429 with JSON error when exceeded\n- tests in tests/rate-limit.test.ts" },
        '{"number":128,"html_url":"https://github.com/acme-demo/acme-web/pull/128","state":"open"}',
      ),
    ],
  });
  b.step({ calls: [b.mcp("mcp__github__add_labels", { owner: "acme-demo", repo: "acme-web", issue_number: 128, labels: ["backend", "security"] }, '{"labels":["backend","security"]}')] });
  b.say("Opened https://github.com/acme-demo/acme-web/pull/128 with the `backend` and `security` labels; the description mentions `ORDERS_RATE_LIMIT`.");
}

function authRefactor(b: Builder): void {
  const p = b.s.project;
  b.user("Refactor the auth middleware so API routes accept either the session cookie or an API key (header `x-api-key`, keys hashed in the api_keys table). Keep the cookie flow unchanged.");
  b.step({ think: "Large change. Map current auth usage first.", calls: [b.read("lib/auth.ts"), b.read("middleware.ts"), b.grep("requireUser\\(", "app/api/orders/route.ts:12\napp/api/orders/route.ts:20\napp/api/orders/[id]/route.ts:8\napp/api/admin/prices/route.ts:6\napp/api/account/route.ts:5\napp/api/cart/route.ts:9\napp/api/cart/route.ts:22")] });
  b.spawn(
    "API key auth for acme-web",
    [
      {
        name: "Explore",
        task: "List every API route handler, which auth helper it calls and whether it needs user context or only a tenant.",
        model: "claude-haiku-4-5-20251001",
        run: (c) => {
          c.step({ calls: [c.glob("app/api/**/route.ts", "app/api/account/route.ts\napp/api/admin/prices/route.ts\napp/api/cart/route.ts\napp/api/orders/[id]/route.ts\napp/api/orders/route.ts\napp/api/webhooks/payments/route.ts")] });
          c.step({ calls: [c.read("app/api/cart/route.ts"), c.read("app/api/webhooks/payments/route.ts", { out: "export async function POST(req: Request) {\n  verifySignature(req);\n  ..." })] });
          return "6 route files. 5 use `requireUser` (orders x2, account, cart, admin/prices); webhooks/payments verifies a signature instead and must stay as is. admin/prices also checks `user.role === \"admin\"`.";
        },
      },
      {
        name: "test-planner",
        task: "Draft a test plan for API key auth: valid key, revoked key, wrong key, cookie still works, both present.",
        model: "claude-haiku-4-5-20251001",
        run: (c) => {
          c.step({ calls: [c.read("tests/auth.test.ts")] });
          return "Plan: (1) valid key resolves the key owner, (2) revoked key → 401, (3) unknown key → 401 without timing difference, (4) cookie-only unchanged, (5) both present → cookie wins, (6) admin route rejects non-admin key owner.";
        },
      },
    ],
    { say: "I'll have one agent map the routes and another draft the test plan while I read the schema." },
  );
  b.step({ calls: [b.read("db/schema.sql", { out: "create table users (...);\ncreate table api_keys (\n  id uuid primary key,\n  user_id uuid references users(id),\n  hash bytea not null,\n  revoked_at timestamptz\n);" })] });
  const editAuth = (n: number) => {
    for (let i = 0; i < n; i++) {
      const f = pick(["lib/auth.ts", "lib/api-keys.ts", "app/api/cart/route.ts", "app/api/account/route.ts", "app/api/orders/[id]/route.ts", "tests/auth.test.ts"]);
      b.step({ calls: [b.read(f, { extra: int(3_000, 6_000) }), b.edit(f, "  const user = await requireUser(req);", "  const user = await authenticate(req);")] });
    }
  };
  b.step({
    calls: [
      b.write("lib/api-keys.ts", 'import { createHash, timingSafeEqual } from "node:crypto";\nimport { db } from "./db";\n\nexport async function userForApiKey(key: string) {\n  const hash = createHash("sha256").update(key).digest();\n  const row = await db.apiKeys.findByHash(hash);\n  if (!row || row.revokedAt) return null;\n  return timingSafeEqual(row.hash, hash) ? db.users.get(row.userId) : null;\n}'),
      b.edit("lib/auth.ts", "export async function requireUser(req: Request) {", "export async function authenticate(req: Request) {\n  const key = req.headers.get(\"x-api-key\");\n  const fromCookie = await userFromCookie(req);\n  if (fromCookie) return fromCookie;\n  if (key) {\n    const user = await userForApiKey(key);\n    if (user) return user;\n  }\n  throw unauthorized();\n}\n\nexport async function requireUser(req: Request) {"),
    ],
  });
  editAuth(9);
  b.step({ calls: [b.sh("pnpm test:e2e", "Running 34 tests using 4 workers\n  34 passed (9.1m)", { dur: int(8 * MIN, 10 * MIN), desc: "Run the end-to-end tests" })] });
  b.step({ calls: [b.test({ fail: vitestFail(p, b.t, "tests/auth.test.ts", "authenticate > revoked key is rejected", "401", "200", 58) })] });
  b.step({ calls: [b.read("lib/db.ts"), b.edit("lib/db.ts", "    findByHash: (hash: Buffer) => one(\"select * from api_keys where hash = $1\", [hash]),", "    findByHash: (hash: Buffer) => one(\"select id, user_id as \\\"userId\\\", hash, revoked_at as \\\"revokedAt\\\" from api_keys where hash = $1\", [hash]),")] });
  b.step({ calls: [b.test()] });
  b.say("API keys work for all five protected routes; the revoked-key test caught a snake_case column that was never mapped. Next: the admin role check and docs.");
  b.user("ok continue with the admin check, and add a script to create keys", int(5 * 60, 9 * 60));
  b.apiError("API Error: 429 rate_limit_error: This request would exceed your organization's rate limit of 400,000 input tokens per minute");
  editAuth(5);
  b.inject("<system-reminder>Remember to keep the todo list up to date.</system-reminder>");
  editAuth(7);
  b.step({ calls: [b.sh("pnpm test:e2e", "Running 34 tests using 4 workers\n\n  1) [chromium] › account.spec.ts:22:7 › account page shows API keys\n    Error: Timed out 5000ms waiting for expect(locator).toBeVisible()\n\n  1 failed\n  33 passed (9.4m)", { err: true, exit: 1, dur: int(8 * MIN, 10 * MIN), desc: "Run the end-to-end tests" })] });
  b.step({ think: "The account page test expects an API keys section that is part of the follow-up; mark it as fixme for now and tell the user.", calls: [b.edit("e2e/account.spec.ts", '  test("account page shows API keys", async ({ page }) => {', '  test.fixme("account page shows API keys", async ({ page }) => {')] });
  b.user("fine, skip that one for now. keep going", int(4 * 60, 8 * 60));
  b.step({ calls: [b.grep("authenticate|requireUser", "app/api/webhooks/payments/route.ts: no matches", "app/api/webhooks")] });
  b.say("Noted. The payments webhook still only verifies its signature; it never calls `authenticate`.");
  b.user("good. now the admin route", int(5 * 60, 8 * 60));
  b.compact("The user asked to let API routes accept either the session cookie or an `x-api-key` header. Done so far: `lib/api-keys.ts` (sha256 lookup, revoked keys rejected), `authenticate()` in lib/auth.ts used by orders, account, cart, admin/prices; tests 1-5 of the plan pass. Remaining: admin role check for key owners, `scripts/create-api-key.ts`, README section.");
  b.step({ calls: [b.read("app/api/admin/prices/route.ts"), b.read("lib/auth.ts")] });
  b.step({ calls: [b.edit("app/api/admin/prices/route.ts", "  const user = await requireUser(req);\n  if (user.role !== \"admin\") return forbidden();", "  const user = await authenticate(req);\n  if (user.role !== \"admin\") return forbidden();")] });
  b.step({
    calls: [
      b.write("scripts/create-api-key.ts", 'import { randomBytes, createHash } from "node:crypto";\nimport { db } from "../lib/db";\n\nconst [email] = process.argv.slice(2);\nconst key = `ak_${randomBytes(24).toString("base64url")}`;\nconst user = await db.users.byEmail(email);\nawait db.apiKeys.insert({ userId: user.id, hash: createHash("sha256").update(key).digest() });\nconsole.log(key);'),
      b.sh("pnpm tsx scripts/create-api-key.ts dev@example.com", "Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1611:16)", { err: true, exit: 1, dur: int(1_500, 3_000) }),
    ],
  });
  b.step({ calls: [b.sh("docker compose up -d db && sleep 3 && pnpm tsx scripts/create-api-key.ts dev@example.com", " ✔ Container acme-web-db-1  Started\nak_3VxQm0dRkq9h2s8pZ1yL7cEw4nTfBuGa", { dur: int(6_000, 12_000) })] });
  b.step({ calls: [b.edit("README.md", "## Local setup", "## API keys\n\nCreate one with `pnpm tsx scripts/create-api-key.ts <email>` and send it as `x-api-key`.\n\n## Local setup")] });
  b.step({ calls: [b.test(), b.sh("pnpm exec tsc --noEmit", "", { dur: int(7_000, 14_000) })] });
  b.step({ calls: [b.sh("pnpm test:e2e", "Running 34 tests using 4 workers\n  33 passed\n  1 skipped (8.9m)", { dur: int(8 * MIN, 10 * MIN), desc: "Run the end-to-end tests" })] });
  b.idle(int(14, 22));
  b.user("Run the whole thing once more and commit in two commits: the auth change, then script+docs");
  b.step({ calls: [b.sh("pnpm test:e2e", "Running 34 tests using 4 workers\n  33 passed\n  1 skipped (9.0m)", { dur: int(8 * MIN, 10 * MIN), desc: "Run the end-to-end tests" })] });
  b.step({ calls: [b.test(), b.sh("git add lib app tests && git commit -m \"Accept API keys on API routes\"", commitOut(b.s.branch, "Accept API keys on API routes", 9, 214, 37, "lib/api-keys.ts"), { dur: 600 })] });
  b.step({ calls: [b.sh("git add scripts README.md && git commit -m \"Add create-api-key script and docs\"", commitOut(b.s.branch, "Add create-api-key script and docs", 2, 31, 0, "scripts/create-api-key.ts"), { dur: 500 })] });
  b.say("Two commits on `feat/api-keys`: the auth change (cookie first, then `x-api-key`, revoked keys rejected, admin route checks the key owner's role) and the key script plus README section. All tests and the typecheck pass.");
}

function telemetryBatch(b: Builder): void {
  b.user("Add a POST /v1/satellites/:id/telemetry/batch endpoint that takes up to 500 samples and inserts them in one query");
  b.step({ calls: [b.read("src/routes/telemetry.rs"), b.read("src/db/telemetry.rs"), b.grep("route\\(\"/v1/satellites", "src/main.rs:41:        .route(\"/v1/satellites/{id}/telemetry\", post(routes::telemetry::ingest))", "src")] });
  b.step({
    think: "Use UNNEST with arrays for one round trip. Validate length <= 500 and return 413 beyond.",
    calls: [
      b.edit("src/routes/telemetry.rs", "pub async fn ingest(", "#[derive(Deserialize)]\npub struct Batch {\n    pub samples: Option<Vec<Sample>>,\n}\n\npub async fn ingest_batch(\n    State(state): State<AppState>,\n    Path(sat_id): Path<i64>,\n    Json(payload): Json<Batch>,\n) -> Result<StatusCode, ApiError> {\n    let batch: Vec<Sample> = payload.samples;\n    if batch.len() > 500 {\n        return Err(ApiError::PayloadTooLarge);\n    }\n    db::telemetry::insert_many(&state.pool, sat_id, &batch).await?;\n    Ok(StatusCode::CREATED)\n}\n\npub async fn ingest("),
      b.edit("src/db/telemetry.rs", "pub async fn insert(", "pub async fn insert_many(pool: &PgPool, sat_id: i64, samples: &[Sample]) -> Result<(), ApiError> {\n    let ts: Vec<i64> = samples.iter().map(|s| s.ts).collect();\n    let alt: Vec<f64> = samples.iter().map(|s| s.altitude_km).collect();\n    let vel: Vec<f64> = samples.iter().map(|s| s.velocity_kms).collect();\n    sqlx::query!(\"insert into telemetry (sat_id, ts, altitude_km, velocity_kms) select $1, * from unnest($2::bigint[], $3::float8[], $4::float8[])\", sat_id, &ts, &alt, &vel)\n        .execute(pool)\n        .await?;\n    Ok(())\n}\n\npub async fn insert("),
      b.edit("src/main.rs", '        .route("/v1/satellites/{id}/telemetry", post(routes::telemetry::ingest))', '        .route("/v1/satellites/{id}/telemetry", post(routes::telemetry::ingest))\n        .route("/v1/satellites/{id}/telemetry/batch", post(routes::telemetry::ingest_batch))'),
    ],
  });
  b.step({
    calls: [
      b.sh(
        "cargo build",
        `   Compiling orbit-api v0.7.2 (${ORBIT.cwd})\nerror[E0308]: mismatched types\n  --> src/routes/telemetry.rs:31:30\n   |\n31 |     let batch: Vec<Sample> = payload.samples;\n   |                -----------   ^^^^^^^^^^^^^^^ expected \`Vec<Sample>\`, found \`Option<Vec<Sample>>\`\n   |                |\n   |                expected due to this\n   |\n   = note: expected struct \`Vec<_>\`\n              found enum \`Option<Vec<_>>\`\nhelp: consider using \`Option::expect\` to unwrap the \`Option<Vec<Sample>>\` value, panicking if the value is an \`Option::None\`\n\nerror[E0599]: no variant or associated item named \`PayloadTooLarge\` found for enum \`ApiError\` in the current scope\n  --> src/routes/telemetry.rs:33:32\n\nerror: could not compile \`orbit-api\` (bin "orbit-api") due to 2 previous errors`,
        { err: true, exit: 101, dur: int(25_000, 60_000) },
      ),
    ],
  });
  b.step({
    calls: [
      b.edit("src/routes/telemetry.rs", "    let batch: Vec<Sample> = payload.samples;", "    let batch = payload.samples.unwrap_or_default();"),
      b.read("src/error.rs"),
      b.edit("src/error.rs", "    #[error(\"not found\")]\n    NotFound,", "    #[error(\"not found\")]\n    NotFound,\n    #[error(\"payload too large\")]\n    PayloadTooLarge,"),
      b.edit("src/error.rs", "            ApiError::NotFound => StatusCode::NOT_FOUND,", "            ApiError::NotFound => StatusCode::NOT_FOUND,\n            ApiError::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,"),
    ],
  });
  b.step({ calls: [b.sh("cargo build", `   Compiling orbit-api v0.7.2 (${ORBIT.cwd})\n    Finished \`dev\` profile [unoptimized + debuginfo] target(s) in 38.12s`, { dur: int(25_000, 45_000) })] });
  b.step({ calls: [b.write("tests/telemetry_batch.rs", "#[sqlx::test]\nasync fn batch_inserts_all_samples(pool: PgPool) {\n    let app = test_app(pool.clone());\n    let res = app.post(\"/v1/satellites/7/telemetry/batch\").json(&batch(120)).await;\n    assert_eq!(res.status(), 201);\n    assert_eq!(count(&pool, 7).await, 120);\n}\n\n#[sqlx::test]\nasync fn batch_over_limit_is_rejected(pool: PgPool) {\n    let res = test_app(pool).post(\"/v1/satellites/7/telemetry/batch\").json(&batch(501)).await;\n    assert_eq!(res.status(), 413);\n}"), b.test({ dur: int(30_000, 70_000) })] });
  b.step({ calls: [b.commit("Add telemetry batch endpoint", 5, "tests/telemetry_batch.rs")] });
  b.say("Added `POST /v1/satellites/{id}/telemetry/batch`: up to 500 samples, inserted with one `UNNEST` query, 413 above the limit (new `ApiError::PayloadTooLarge`). Two integration tests cover the happy path and the limit.");
}

function slowStartup(b: Builder): void {
  b.user("The API takes ~40s to become ready in staging. Find out why and fix what you can.");
  b.step({ think: "**Profiling startup**", calls: [b.read("src/main.rs"), b.read("src/db/pool.rs")] });
  b.step({ calls: [b.sh("cargo build --release --timings", "", { err: true, exit: 124, out: "Command timed out after 120000 ms", dur: 120_000 })] });
  b.step({ think: "**Narrowing down**\n\nRelease build is too slow for the sandbox; time the startup phases with tracing instead.", calls: [b.sh("RUST_LOG=orbit_api=debug timeout 60 cargo run 2>&1 | grep -E 'phase|ready'", "DEBUG orbit_api: phase=config elapsed_ms=3\nDEBUG orbit_api: phase=pool elapsed_ms=212\nDEBUG orbit_api: phase=migrations elapsed_ms=31877\nDEBUG orbit_api: phase=jwks elapsed_ms=4820\nINFO  orbit_api: ready addr=0.0.0.0:8080", { dur: int(40_000, 58_000) })] });
  b.step({ calls: [b.search("sqlx migrate run slow on startup many migrations", "")] });
  b.step({ calls: [b.fetch("https://docs.rs/sqlx/latest/sqlx/migrate/struct.Migrator.html", "Migrator: set_locking(false) disables the advisory lock; run() checks every applied migration checksum...")] });
  b.step({ calls: [b.sh("ls migrations | wc -l && rg -n 'create index' migrations | head", "64\nmigrations/0031_telemetry_ts_idx.sql:1:create index telemetry_ts_idx on telemetry (sat_id, ts);\nmigrations/0052_orbit_epoch_idx.sql:1:create index orbit_epoch_idx on orbits (epoch);", {})] });
  b.step({
    think: "**Applying the fix**\n\nMigrations run on every replica at boot and wait on the advisory lock; move them to a job and fetch JWKS lazily.",
    calls: [
      b.edit("src/main.rs", "    db::pool::migrate(&pool).await?;", "    if std::env::var(\"RUN_MIGRATIONS\").as_deref() == Ok(\"1\") {\n        db::pool::migrate(&pool).await?;\n    }"),
      b.edit("src/auth/jwt.rs", "    let jwks = Jwks::fetch(&config.jwks_url).await?;", "    let jwks = Jwks::lazy(config.jwks_url.clone());"),
    ],
  });
  b.step({ calls: [b.test({ dur: int(30_000, 60_000) })] });
  b.say("Startup was dominated by migrations (32s: every replica runs all 64 and waits on the advisory lock) and the JWKS fetch (5s). Migrations now only run with `RUN_MIGRATIONS=1` (meant for a pre-deploy job) and JWKS loads on first use. Locally the API is ready in ~0.3s. You'll need a migration Job in the infra repo before deploying this.");
}

function clippy(b: Builder): void {
  b.user("Fix the clippy warnings, CI started failing on them after the toolchain bump");
  b.step({
    calls: [
      b.sh(
        ORBIT.lint,
        "warning: this `if` statement can be collapsed\n  --> src/routes/orbits.rs:52:9\nwarning: redundant clone\n  --> src/db/orbits.rs:18:31\nwarning: using `clone` on type `TenantId` which implements the `Copy` trait\n  --> src/auth/jwt.rs:77:20\nwarning: manual implementation of `Option::map`\n  --> src/routes/health.rs:23:5\nerror: could not compile `orbit-api` (bin \"orbit-api\") due to 4 previous errors",
        { err: true, exit: 101, dur: int(20_000, 45_000) },
      ),
    ],
  });
  b.step({
    calls: [
      b.edit("src/routes/orbits.rs", "        if let Some(epoch) = q.epoch {\n            if epoch > now {", "        if let Some(epoch) = q.epoch && epoch > now {"),
      b.edit("src/db/orbits.rs", "    let name = row.name.clone();", "    let name = row.name;"),
      b.edit("src/auth/jwt.rs", "    let tenant = claims.tenant.clone();", "    let tenant = claims.tenant;"),
      b.edit("src/routes/health.rs", "    match version {\n        Some(v) => Some(v.to_string()),\n        None => None,\n    }", "    version.map(|v| v.to_string())"),
    ],
  });
  b.step({ calls: [b.sh(ORBIT.lint, "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 19.87s", { dur: int(20_000, 40_000) }), b.test({ dur: int(30_000, 60_000) })] });
  b.step({ calls: [b.commit("Fix clippy warnings for Rust 1.90", 4)] });
  b.say("Clippy is clean: collapsed an `if let`, removed two needless clones and replaced a manual `Option::map`. Tests pass; committed.");
}

function errorAudit(b: Builder): void {
  b.user("Audit error handling across the crate: where do we unwrap, leak internal errors to clients, or lose context? Then fix the worst offenders.");
  b.spawn(
    "orbit-api is an axum + sqlx service. ApiError lives in src/error.rs. Report findings with file:line and a severity.",
    [
      {
        name: "ScanRoutes",
        task: "Review src/routes/** for unwrap/expect and for errors returned to clients with internal details.",
        run: (c) => {
          c.step({ calls: [c.grep("unwrap\\(\\)|expect\\(", "src/routes/orbits.rs:88:    let tle = parse_tle(&body).unwrap();\nsrc/routes/telemetry.rs:12:    let ts = chrono::DateTime::from_timestamp(s.ts, 0).expect(\"valid ts\");", "src/routes")] });
          c.step({ calls: [c.read("src/routes/orbits.rs")] });
          return "HIGH src/routes/orbits.rs:88 `parse_tle(&body).unwrap()` panics on malformed TLE input (client-controlled). MEDIUM src/routes/telemetry.rs:12 `expect` on a client timestamp.";
        },
      },
      {
        name: "ScanDb",
        task: "Review src/db/** for sqlx errors mapped to ApiError and for context lost in `?` conversions.",
        run: (c) => {
          c.step({ calls: [c.read("src/db/pool.rs"), c.grep("impl From<sqlx::Error>", "src/error.rs:41:impl From<sqlx::Error> for ApiError {", "src")] });
          c.spawn(
            "Trace sqlx error paths",
            [
              {
                name: "TraceSqlxErrors",
                task: "Follow `From<sqlx::Error> for ApiError` and list which database errors end up as 500 with the raw message in the body.",
                run: (g) => {
                  g.step({ calls: [g.read("src/error.rs")] });
                  g.step({ calls: [g.grep("Database\\(e\\)", "src/error.rs:44:            sqlx::Error::Database(e) => ApiError::Internal(e.to_string()),", "src")] });
                  return "Every `sqlx::Error::Database` becomes `ApiError::Internal(e.to_string())`, and `Internal` is serialized as-is: unique violations leak constraint names and SQL to clients.";
                },
              },
            ],
            { say: "Delegating the trace through the From impl." },
          );
          return "HIGH src/error.rs:44 database errors serialized verbatim (constraint names, SQL). Unique violations should map to 409. LOW src/db/pool.rs migrations error has no context.";
        },
      },
      {
        name: "ScanAuth",
        task: "Review src/auth/** for errors that reveal whether a token or tenant exists.",
        run: (c) => {
          c.step({ calls: [c.read("src/auth/jwt.rs")] });
          return "MEDIUM src/auth/jwt.rs:61 different messages for unknown kid vs bad signature (token oracle). Use one generic 401.";
        },
      },
    ],
    { think: "Three independent areas; scan in parallel.", say: "Running three reviewers in parallel: routes, database, auth." },
  );
  b.step({
    say: "Fixing the two HIGH findings and the auth oracle.",
    calls: [
      b.edit("src/error.rs", "            sqlx::Error::Database(e) => ApiError::Internal(e.to_string()),", "            sqlx::Error::Database(e) if e.is_unique_violation() => ApiError::Conflict,\n            e => {\n                tracing::error!(error = %e, \"database error\");\n                ApiError::Internal(\"internal error\".into())\n            }"),
      b.edit("src/routes/orbits.rs", "    let tle = parse_tle(&body).unwrap();", "    let tle = parse_tle(&body).map_err(|_| ApiError::BadRequest(\"invalid TLE\".into()))?;"),
      b.edit("src/auth/jwt.rs", "        return Err(AuthError::UnknownKey(kid));", "        return Err(AuthError::Invalid);"),
    ],
  });
  b.step({ calls: [b.test({ dur: int(30_000, 60_000) })] });
  b.say("Fixed: database errors no longer reach clients (unique violations → 409, the rest logged and returned as a generic 500), malformed TLEs return 400 instead of panicking, and auth failures share one 401. Remaining MEDIUM/LOW items: the timestamp `expect` in telemetry and missing context on migration errors.");
}

function migration(b: Builder): void {
  b.user("Add a migration for an `orbits` history table (orbit_id, epoch, tle, created_at) and run it locally");
  b.step({ think: "**Writing migration**", calls: [b.sh("ls migrations | tail -n 3", "0062_add_satellite_owner.sql\n0063_telemetry_partition.sql\n0064_orbit_epoch_default.sql")] });
  b.step({ calls: [b.write("migrations/0065_orbit_history.sql", "create table orbit_history (\n  id bigserial primary key,\n  orbit_id bigint not null references orbits(id) on delete cascade,\n  epoch timestamptz not null,\n  tle text not null,\n  created_at timestamptz not null default now()\n);\n\ncreate index orbit_history_orbit_epoch_idx on orbit_history (orbit_id, epoch desc);")] });
  b.apiError("stream disconnected before completion: 429 Too Many Requests");
  b.step({ calls: [b.sh("sqlx migrate run", "error: error communicating with database: Connection refused (os error 111)", { err: true, exit: 1, dur: 400 })] });
  b.step({ calls: [b.sh("docker compose up -d postgres", "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock", { err: true, exit: 1, dur: 300 })] });
  b.step({ calls: [b.sh("podman compose up -d postgres && sleep 2 && sqlx migrate run", "orbit-api_postgres_1\nApplied 65/migrate orbit history (18.402ms)", { dur: int(5_000, 9_000) })] });
  b.spawn("Review the new migration", [
    {
      name: "schema-reviewer",
      task: "Review migrations/0065_orbit_history.sql for locking, index and retention issues on a table that will grow by ~2M rows a month.",
      run: (c) => {
        c.step({ calls: [c.read("migrations/0065_orbit_history.sql")] });
        c.spawn("Check index usage", [
          {
            name: "index-checker",
            task: "Check which queries in src/db would use orbit_history_orbit_epoch_idx and whether a BRIN index on created_at would be cheaper.",
            run: (g) => {
              g.step({ calls: [g.sh("rg -n orbit_history src/db", "src/db/orbits.rs:61:        \"select epoch, tle from orbit_history where orbit_id = $1 order by epoch desc limit $2\",")] });
              return "Only the latest-N-by-orbit query exists; the btree (orbit_id, epoch desc) fits it. A BRIN on created_at only helps retention deletes.";
            },
          },
        ]);
        return "Fine to ship. The btree matches the only query; consider a BRIN on created_at plus a monthly retention job later. No locking concerns: new table.";
      },
    },
  ]);
  b.step({ calls: [b.test({ dur: int(30_000, 60_000) }), b.commit("Add orbit_history table", 1, "migrations/0065_orbit_history.sql")] });
  b.say("Migration `0065_orbit_history.sql` is applied locally (Docker's socket was not accessible, so I used podman). The reviewer agent found no issues; it suggested a BRIN index plus a retention job once the table grows.");
}

function csvSemicolon(b: Builder): void {
  b.user("Support semicolon-delimited CSV exports in the importer, some banks use `;` and comma decimals (1.234,56)");
  b.step({ calls: [b.read("ledger/importers/csv_import.py", { out: "import csv\nfrom decimal import Decimal\n\n\ndef parse_amount(raw: str) -> Decimal:\n    return Decimal(raw.replace(\",\", \"\"))\n\n\ndef read_rows(path: str):\n    with open(path, newline=\"\", encoding=\"utf-8\") as fh:\n        yield from csv.DictReader(fh)" }), b.read("tests/test_csv_import.py")] });
  b.step({
    think: "Sniff the dialect from the first line; parse amounts according to the decimal separator. Careful: `1.234,56` vs `1,234.56`.",
    calls: [
      b.edit("ledger/importers/csv_import.py", "def parse_amount(raw: str) -> Decimal:\n    return Decimal(raw.replace(\",\", \"\"))", "def parse_amount(raw: str, decimal: str = \".\") -> Decimal:\n    thousands = \",\" if decimal == \".\" else \".\"\n    return Decimal(raw.replace(thousands, \"\").replace(decimal, \".\"))"),
      b.edit("ledger/importers/csv_import.py", "        yield from csv.DictReader(fh)", "        sample = fh.read(2048)\n        fh.seek(0)\n        dialect = csv.Sniffer().sniff(sample, delimiters=\",;\")\n        yield from csv.DictReader(fh, dialect=dialect)"),
    ],
  });
  b.step({ calls: [b.write("tests/fixtures/semicolon.csv", "Datum;Buchungstext;Betrag\n01.09.2026;Miete;-1.200,00\n03.09.2026;Gehalt;3.456,78"), b.test({ fail: pytestFail("test_semicolon_amounts", "    def test_semicolon_amounts():\n        rows = list(import_csv(FIXTURES / \"semicolon.csv\"))\n>       assert rows[0].amount == Decimal(\"-1200.00\")\nE       decimal.InvalidOperation: [<class 'decimal.ConversionSyntax'>]\n\nledger/importers/csv_import.py:7: InvalidOperation", 43) })] });
  b.step({ think: "The caller never passes decimal=','. Derive it from the dialect delimiter.", calls: [b.edit("ledger/importers/csv_import.py", "    amount = parse_amount(row[\"amount\"])", "    amount = parse_amount(row[\"amount\"], decimal=\",\" if dialect.delimiter == \";\" else \".\")")] });
  b.step({ calls: [b.test()] });
  b.step({ calls: [b.commit("Import semicolon-delimited CSV with comma decimals", 3, "tests/fixtures/semicolon.csv")] });
  b.say("The importer sniffs `,` vs `;` and parses comma decimals when the file uses semicolons (`-1.200,00` → `-1200.00`). New fixture and test; all 43 tests pass.");
}

function refundDoubleCount(b: Builder): void {
  b.user("Why does reconcile() double count refunds? Customer report: a 49.90 refund shows as matched twice in September.");
  b.step({ calls: [b.read("ledger/reconcile.py"), b.grep("refund", "ledger/models.py:22:    is_refund: bool = False\nledger/importers/csv_import.py:31:        is_refund=amount < 0 and \"REFUND\" in text.upper(),", "ledger")] });
  b.step({
    think: "match_entries compares abs(amount) and never removes matched entries: a refund of -49.90 matches both the original +49.90 purchase entry and the refund entry. Need one-to-one matching and sign check.",
    say: "Found it: `match_entries` compares `abs()` amounts and never consumes an entry, so a refund matches both the purchase and the refund entry.",
    calls: [b.sh("uv run pytest -q -k reconcile", ".................\n17 passed in 0.31s", { dur: int(1_500, 3_000) })],
  });
  b.step({
    calls: [
      b.edit("ledger/reconcile.py", "    matches = []\n    for tx in transactions:\n        for entry in entries:\n            if abs(tx.amount) == abs(entry.amount) and abs(tx.date - entry.date) <= DATE_WINDOW:\n                matches.append((tx, entry))", "    matches = []\n    unmatched = list(entries)\n    for tx in transactions:\n        for entry in unmatched:\n            if tx.amount == entry.amount and abs(tx.date - entry.date) <= DATE_WINDOW:\n                matches.append((tx, entry))\n                unmatched.remove(entry)\n                break"),
      b.edit("tests/test_reconcile.py", "def test_simple_match():", "def test_refund_matches_once():\n    purchase = entry(\"49.90\", \"2026-09-02\")\n    refund = entry(\"-49.90\", \"2026-09-05\")\n    txs = [tx(\"49.90\", \"2026-09-02\"), tx(\"-49.90\", \"2026-09-05\")]\n    assert match_entries(txs, [purchase, refund]) == [(txs[0], purchase), (txs[1], refund)]\n\n\ndef test_simple_match():"),
    ],
  });
  b.step({ calls: [b.test()] });
  b.say("Fixed: matching is now one-to-one and sign-sensitive, so a refund only pairs with the refund entry. Added `test_refund_matches_once`; all tests pass. September will reconcile correctly after a re-run of `ledger reconcile --month 2026-09`.");
}

function uvMigration(b: Builder): void {
  b.user("Switch the project from pip + requirements.txt to uv with a lockfile");
  b.step({ think: "**Inspecting packaging**", calls: [b.read("requirements.txt", { out: "typer==0.12.5\nrich==13.9.2\npython-dateutil==2.9.0\npytest==8.3.3\nruff==0.6.9" }), b.read("pyproject.toml", { out: "[project]\nname = \"ledger\"\nversion = \"0.4.0\"\nrequires-python = \">=3.11\"" })] });
  b.step({ calls: [b.sh("uv add typer rich python-dateutil && uv add --dev pytest ruff mypy", "Resolved 14 packages in 412ms\nPrepared 3 packages in 220ms\nInstalled 14 packages in 18ms\n + typer==0.12.5\n + rich==13.9.2\n + python-dateutil==2.9.0\n + pytest==8.3.3\n + ruff==0.6.9\n + mypy==1.13.0", { dur: int(3_000, 8_000) })] });
  b.step({ calls: [b.rm("requirements.txt"), b.edit("README.md", "pip install -r requirements.txt", "uv sync"), b.edit(".github/workflows/ci.yml", "      - run: pip install -r requirements.txt\n      - run: pytest", "      - uses: astral-sh/setup-uv@v5\n      - run: uv sync --locked\n      - run: uv run pytest -q")] });
  b.step({ calls: [b.test(), b.commit("Use uv with a lockfile", 5)] });
  b.say("Done: dependencies are in `pyproject.toml` with `uv.lock`, `requirements.txt` is gone, README and CI use `uv sync`. Tests pass under `uv run`.");
}

function decimalResearch(b: Builder): void {
  b.user("What's the right way to handle currency rounding in Python for our reports? Banker's rounding or half-up? Just research, don't change code.");
  b.step({ calls: [b.read("ledger/currency.py"), b.grep("quantize|ROUND_", "ledger/currency.py:18:    return amount.quantize(CENT)\nledger/report.py:44:    total = sum(amounts).quantize(Decimal(\"0.01\"), rounding=ROUND_HALF_UP)", "ledger")] });
  b.step({ calls: [b.search("python decimal quantize ROUND_HALF_EVEN vs ROUND_HALF_UP accounting", searchOut([["decimal — Decimal fixed point and floating point arithmetic", "https://docs.python.org/3/library/decimal.html"], ["Rounding modes in financial reporting", "https://en.wikipedia.org/wiki/Rounding#Rounding_half_to_even"]]))] });
  b.step({ calls: [b.fetch("https://docs.python.org/3/library/decimal.html", "The decimal module provides support for fast correctly rounded decimal floating point arithmetic... The default rounding is ROUND_HALF_EVEN...")] });
  b.step({ calls: [b.search("EU invoice VAT rounding rules per line or per total", searchOut([["VAT invoicing rules - European Commission", "https://taxation-customs.ec.europa.eu/vat-invoicing-rules_en"]]))] });
  b.step({ calls: [b.search("python decimal localcontext rounding per thread", searchOut([["decimal.localcontext — Python docs", "https://docs.python.org/3/library/decimal.html#decimal.localcontext"]])), b.fetch("https://peps.python.org/pep-0327/", "PEP 327 – Decimal Data Type... rounding algorithms: ROUND_HALF_EVEN, ROUND_HALF_UP...")] });
  b.step({ calls: [b.fetch("https://taxation-customs.ec.europa.eu/vat-invoicing-rules_en", "Member States may require rounding... amounts are rounded to the nearest cent, half up, at the level of the VAT amount...")] });
  b.step({ calls: [b.grep("Decimal\\(.*float|float\\(", "ledger/report.py:61:    share = float(part) / float(total)", "ledger"), b.read("ledger/report.py")] });
  b.say("Recommendation:\n\n- **Reports and invoices: `ROUND_HALF_UP`** at the cent, once per VAT amount; that's what tax authorities and customers expect.\n- **Internal aggregates: keep full precision**, round only for display. `Decimal`'s default context is `ROUND_HALF_EVEN`, which `currency.py:18` currently inherits implicitly; pass the mode explicitly.\n- One real bug risk: `report.py:61` converts to `float` for shares. Use `Decimal` division there.\n\nI didn't change any code.");
}

function mypy(b: Builder): void {
  b.user("Add type hints to ledger/currency.py and make mypy --strict pass for it");
  b.step({ calls: [b.read("ledger/currency.py"), b.sh("uv run mypy --strict ledger/currency.py", "ledger/currency.py:9: error: Function is missing a type annotation  [no-untyped-def]\nledger/currency.py:15: error: Function is missing a return type annotation  [no-untyped-def]\nledger/currency.py:24: error: Returning Any from function declared to return \"Decimal\"  [no-any-return]\nFound 3 errors in 1 file (checked 1 source file)", { err: true, exit: 1, dur: int(3_000, 7_000) })] });
  b.step({
    calls: [
      b.edit("ledger/currency.py", "def convert(amount, rate):", "def convert(amount: Decimal, rate: Decimal) -> Decimal:"),
      b.edit("ledger/currency.py", "def rate_for(day, currency):", "def rate_for(day: date, currency: str) -> Decimal:"),
      b.edit("ledger/currency.py", "    return RATES[(day, currency)]", "    return Decimal(RATES[(day, currency)])"),
    ],
  });
  b.step({ calls: [b.sh("uv run mypy --strict ledger/currency.py", "Success: no issues found in 1 source file", { dur: int(3_000, 6_000) }), b.test()] });
  b.say("`ledger/currency.py` is fully annotated and passes `mypy --strict`; tests still pass.");
}

function hpa(b: Builder): void {
  b.user("Add a HorizontalPodAutoscaler for the orbit-api deployment: 3-10 replicas at 70% CPU");
  b.step({ calls: [b.read("k8s/api/deployment.yaml"), b.read("k8s/api/kustomization.yaml", { out: "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nnamespace: staging\nresources:\n  - deployment.yaml\n  - service.yaml" })] });
  b.step({
    calls: [
      b.write("k8s/api/hpa.yaml", "apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata:\n  name: orbit-api\nspec:\n  scaleTargetRef:\n    apiVersion: apps/v1\n    kind: Deployment\n    name: orbit-api\n  minReplicas: 3\n  maxReplicas: 10\n  metrics:\n    - type: Resource\n      resource:\n        name: cpu\n        target:\n          type: Utilization\n          averageUtilization: 70"),
      b.edit("k8s/api/kustomization.yaml", "  - service.yaml", "  - service.yaml\n  - hpa.yaml"),
      b.edit("k8s/api/deployment.yaml", "spec:\n  replicas: 3\n", "spec:\n"),
    ],
  });
  b.step({ calls: [b.sh("kubectl apply -k k8s/api --dry-run=server", 'Error from server (Forbidden): horizontalpodautoscalers.autoscaling "orbit-api" is forbidden: User "demo@example.com" cannot create resource "horizontalpodautoscalers" in API group "autoscaling" in the namespace "staging"', { err: true, exit: 1, dur: int(1_000, 3_000) })] });
  b.step({ think: "Wrong context: the read-only user. CI applies with the deployer; validate offline instead.", calls: [b.sh("kubectl config current-context && kustomize build k8s/api | kubeconform -strict -summary", "staging-readonly\nSummary: 4 resources found parsing stdin - Valid: 4, Invalid: 0, Errors: 0, Skipped: 0", { dur: int(1_000, 2_000) })] });
  b.step({ calls: [b.test({ dur: int(4_000, 9_000) }), b.commit("Autoscale orbit-api between 3 and 10 replicas", 3, "k8s/api/hpa.yaml")] });
  b.say("Added `k8s/api/hpa.yaml` (3-10 replicas at 70% CPU) and removed the fixed `replicas` from the deployment so they don't fight. Your kube context is read-only, so I validated offline with kubeconform; CI will apply it.");
}

function backupScript(b: Builder): void {
  b.user("The nightly backup job fails with permission denied, can you look at scripts/backup.sh?");
  b.step({ calls: [b.sh("./scripts/backup.sh", "bash: ./scripts/backup.sh: Permission denied", { err: true, exit: 126, dur: 40 }), b.sh("ls -l scripts/backup.sh && git log --oneline -3 -- scripts/backup.sh", "-rw-r--r-- 1 demo demo 412 Sep 14 10:02 scripts/backup.sh\nb72d1e0 Quote bucket variable\n4a1f9c3 Add nightly backup script", { dur: 80 })] });
  b.step({ say: "The executable bit was lost in the last commit. Restoring it and checking the script itself.", calls: [b.sh("chmod +x scripts/backup.sh && git update-index --chmod=+x scripts/backup.sh && shellcheck scripts/backup.sh", "In scripts/backup.sh line 8:\n  pg_dump --format=custom \"$db\" > /tmp/$db-$STAMP.dump\n                                     ^-- SC2086 (info): Double quote to prevent globbing and word splitting.\n\nIn scripts/backup.sh line 10:\n  aws s3 cp /tmp/$db-$STAMP.dump.gz $BACKUP_BUCKET/\n                                    ^-- SC2086 (info): Double quote to prevent globbing and word splitting.", { err: true, exit: 1 })] });
  b.step({
    calls: [
      b.read("scripts/backup.sh"),
      b.edit("scripts/backup.sh", '  pg_dump --format=custom "$db" > /tmp/$db-$STAMP.dump\n  gzip -f /tmp/$db-$STAMP.dump\n  aws s3 cp /tmp/$db-$STAMP.dump.gz $BACKUP_BUCKET/', '  out="/tmp/$db-$STAMP.dump"\n  pg_dump --format=custom "$db" > "$out"\n  gzip -f "$out"\n  aws s3 cp "$out.gz" "$BACKUP_BUCKET/"\n  rm -f "$out.gz"'),
    ],
  });
  b.step({ calls: [b.sh("shellcheck scripts/backup.sh && DRY_RUN=1 ./scripts/backup.sh", "would dump orbit -> s3://example-backups/postgres/\nwould dump ledger -> s3://example-backups/postgres/", { dur: 600 })] });
  b.step({ calls: [b.commit("Restore executable bit on backup.sh and quote paths", 1)] });
  b.say("Root cause: `b72d1e0` dropped the executable bit (mode 644), so cron got `Permission denied`. Restored it in git, fixed the shellcheck warnings and made the script clean up its temp file. Dry run works; committed.");
}

function certRotation(b: Builder): void {
  b.user("Rotate the staging TLS certs, the current ones expire next week");
  b.step({ think: "**Checking expiry**", calls: [b.read("scripts/rotate-certs.sh"), b.sh("./scripts/rotate-certs.sh --check", "api.staging.example.com    expires 2026-10-12 (7 days)\nauth.staging.example.com   expires 2026-10-12 (7 days)")] });
  b.step({ calls: [b.sh("./scripts/rotate-certs.sh --renew", "", { err: true, exit: 124, out: "waiting for certificate api-staging-tls to become Ready...\nCommand timed out after 300000 ms", dur: 300_000 })] });
  b.step({ calls: [b.search("cert-manager certificate stuck not ready http01 challenge pending", searchOut([["Troubleshooting Problems with ACME / Let's Encrypt Certificates", "https://cert-manager.io/docs/troubleshooting/acme/"]]))] });
  b.step({ calls: [b.fetch("https://cert-manager.io/docs/troubleshooting/acme/", "Check the Challenge resource: kubectl describe challenge... A common cause is an ingress class mismatch on the solver...")] });
  b.step({ calls: [b.sh("kubectl -n staging describe challenge | grep -A3 Reason", "Reason:  Waiting for HTTP-01 challenge propagation: wrong status code '404', expected '200'\n  Solver ingress class: nginx\n  Cluster ingress class: traefik", { dur: 1500 })] });
  b.step({ calls: [b.edit("k8s/cert-manager/issuer-staging.yaml", "            ingressClassName: nginx", "            ingressClassName: traefik"), b.edit("scripts/rotate-certs.sh", 'kubectl wait --for=condition=Ready certificate --all -n "$NAMESPACE" --timeout=600s', 'kubectl wait --for=condition=Ready certificate --all -n "$NAMESPACE" --timeout=240s || { kubectl -n "$NAMESPACE" describe challenge; exit 1; }')] });
  b.step({ calls: [b.sh("kubectl apply -f k8s/cert-manager/issuer-staging.yaml && ./scripts/rotate-certs.sh --renew", "clusterissuer.cert-manager.io/letsencrypt-staging configured\ncertificate.cert-manager.io/api-staging-tls condition met\ncertificate.cert-manager.io/auth-staging-tls condition met", { dur: int(40_000, 90_000) })] });
  b.step({ calls: [b.commit("Use traefik solver for staging issuer; fail fast in rotate-certs", 2)] });
  b.say("Both staging certificates are renewed (valid until January). The renewal hung because the HTTP-01 solver still used the `nginx` ingress class after the traefik migration; the issuer now uses `traefik`, and the script prints the challenge status instead of waiting 10 minutes.");
}

function deployCache(b: Builder): void {
  b.user("Update the deploy workflow to cache the pnpm store, builds take 6 minutes. Open a PR when done.");
  b.step({ calls: [b.read(".github/workflows/deploy.yml")] });
  b.step({ calls: [b.fetch("https://github.com/actions/setup-node#caching-global-packages-data", "setup-node can cache the package manager store: with: cache: pnpm. Requires pnpm to be installed first (pnpm/action-setup)...", "How to enable pnpm caching")] });
  b.step({ calls: [b.edit(".github/workflows/deploy.yml", "      - uses: actions/setup-node@v4\n        with:\n          node-version: 20", "      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          cache: pnpm", { err: true, out: "<tool_use_error>String to replace not found in file.\nString:       - uses: actions/setup-node@v4\n        with:\n          node-version: 20</tool_use_error>" })] });
  b.step({ think: "The file pins node 22 already, re-read the exact lines.", calls: [b.edit(".github/workflows/deploy.yml", "      - uses: actions/setup-node@v4\n        with:\n          node-version: 22", "      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          cache: pnpm")] });
  b.step({ calls: [b.sh("git switch -c ci/pnpm-cache && git commit -am \"Cache pnpm store in deploy workflow\" && git push -u origin ci/pnpm-cache", "Switched to a new branch 'ci/pnpm-cache'\n[ci/pnpm-cache 9e04b1c] Cache pnpm store in deploy workflow\n 1 file changed, 1 insertion(+)\nTo github.com:acme-demo/infra.git\n * [new branch]      ci/pnpm-cache -> ci/pnpm-cache", { dur: int(2_000, 4_000) })] });
  b.step({ calls: [b.mcp("mcp__github__create_pull_request", { owner: "acme-demo", repo: "infra", head: "ci/pnpm-cache", base: "main", title: "Cache pnpm store in deploy workflow", body: "Enables `cache: pnpm` on setup-node. Expected to cut install time from ~3 min to ~30 s on warm cache." }, '{"number":57,"html_url":"https://github.com/acme-demo/infra/pull/57","state":"open"}')] });
  b.say("Opened https://github.com/acme-demo/infra/pull/57: setup-node now caches the pnpm store. The first run warms the cache; later installs should drop from ~3 minutes to well under one.");
}

/** The session that is still running: its last event lands within the last minute. */
function livePagination(b: Builder): void {
  b.user("Add server-side pagination to the admin orders table, 25 per page, keep the filters in the URL");
  b.step({ calls: [b.read("app/admin/orders/page.tsx", { out: 'import { listOrders } from "@/lib/db";\n\nexport default async function AdminOrders({ searchParams }: { searchParams: Promise<{ status?: string }> }) {\n  const { status } = await searchParams;\n  const orders = await listOrders({ status });\n  return <OrdersTable orders={orders} />;\n}' }), b.read("lib/db.ts")] });
  b.step({
    think: "Keyset pagination would be nicer but the table sorts by several columns; offset is fine for an admin view at this size.",
    calls: [b.edit("lib/db.ts", "export async function listOrders({ status }: { status?: string }) {", "export async function listOrders({ status, page = 1, perPage = 25 }: { status?: string; page?: number; perPage?: number }) {")],
  });
  b.step({ calls: [b.edit("app/admin/orders/page.tsx", "  const { status } = await searchParams;\n  const orders = await listOrders({ status });", "  const { status, page } = await searchParams;\n  const current = Math.max(1, Number(page) || 1);\n  const { orders, total } = await listOrders({ status, page: current });")] });
  b.step({ calls: [b.write("components/admin/Pager.tsx", 'import Link from "next/link";\n\nexport function Pager({ page, pages, params }: { page: number; pages: number; params: URLSearchParams }) {\n  const href = (p: number) => `?${new URLSearchParams({ ...Object.fromEntries(params), page: String(p) })}`;\n  return (\n    <nav aria-label="Pagination">\n      {page > 1 && <Link href={href(page - 1)}>Previous</Link>}\n      <span>{page} / {pages}</span>\n      {page < pages && <Link href={href(page + 1)}>Next</Link>}\n    </nav>\n  );\n}')] });
  b.step({ calls: [b.test()] });
}

/** Endless follow-up work for `--live`: one small step per tick. */
const LIVE_STEPS: ((b: Builder) => void)[] = [
  (b) => b.step({ calls: [b.read("app/admin/orders/page.tsx")] }),
  (b) => b.step({ calls: [b.grep("searchParams", "app/admin/orders/page.tsx:3\napp/admin/orders/Filters.tsx:12", "app/admin")] }),
  (b) => b.step({ think: "Keep the status filter when changing pages.", calls: [b.edit("app/admin/orders/Filters.tsx", "  router.push(`?status=${value}`);", "  router.push(`?${new URLSearchParams({ ...current, status: value, page: \"1\" })}`);")] }),
  (b) => b.step({ calls: [b.test({ dur: 3_000 })] }),
  (b) => b.say("Filters now reset to page 1 and keep the other query parameters."),
  (b) => b.user("also show the total count above the table", 5),
  (b) => b.step({ calls: [b.edit("app/admin/orders/page.tsx", "  return <OrdersTable orders={orders} />;", "  return (\n    <>\n      <p className=\"muted\">{total} orders</p>\n      <OrdersTable orders={orders} />\n    </>\n  );")] }),
  (b) => b.step({ calls: [b.sh("pnpm exec tsc --noEmit", "", { dur: 2_500 })] }),
  (b) => b.say("Added the total above the table."),
];

// ---------------------------------------------------------------------------------------------------------------
// Short chores, generated per project to fill the calendar

type Chore = (b: Builder, first: boolean) => void;

const CHORES: Chore[] = [
  // Explain a file.
  (b) => {
    const p = b.s.project;
    const [file, note] = pick(Object.entries(p.notes));
    b.user(pick([`Explain how ${file} works`, `What does ${file} do? I'm new to this part of the code`, `Give me a quick tour of ${file}`]));
    b.step({ calls: [b.read(file)] });
    b.step({ calls: [b.grep(path.posix.basename(file).replace(/\.[^.]+$/, ""), `${pick(Object.keys(p.notes))}:${int(2, 40)}\n${pick(Object.keys(p.notes))}:${int(2, 40)}`)] });
    b.say(`\`${file}\` ${note}. It is used from two places; the interesting part is the error path near the bottom, which callers rely on to return early.`);
  },
  // Run the tests.
  (b) => {
    b.user(pick(["Run the tests and tell me if anything fails", "Are the tests green on this branch?", "run the test suite"]));
    b.step({ calls: [b.test()] });
    b.say("All tests pass.");
  },
  // Commit staged work.
  (b) => {
    const p = b.s.project;
    const file = pick(Object.keys(p.notes));
    b.user("Write a commit message for the staged changes and commit them");
    b.step({ calls: [b.sh("git diff --staged --stat", ` ${file} | ${int(4, 40)} ++++++----\n 1 file changed, ${int(4, 30)} insertions(+), ${int(1, 10)} deletions(-)`, { dur: 120 })] });
    const msg = `Tidy ${path.posix.basename(file)} error handling`;
    b.step({ calls: [b.commit(msg, 1)] });
    b.say(`Committed as "${msg}".`);
  },
  // Rename a symbol.
  (b) => {
    const p = b.s.project;
    const [from, to, def, users] = pick(p.symbols);
    b.user(`Rename \`${from}\` to \`${to}\` everywhere`);
    b.step({ calls: [b.grep(`\\b${from}\\b`, [def, ...users].map((f) => `${f}:${int(3, 80)}`).join("\n"))] });
    b.step({ calls: [def, ...users].map((f) => b.edit(f, from, to)) });
    b.step({ calls: [b.test()] });
    b.say(`Renamed in ${users.length + 1} files; tests pass.`);
  },
  // Add a unit test.
  (b) => {
    const p = b.s.project;
    const [, , def] = pick(p.symbols);
    const base = path.posix.basename(def).replace(/\.[^.]+$/, "");
    const testFile = p.key === "web" ? `tests/${base}.test.ts` : p.key === "orbit" ? `tests/${base}.rs` : p.key === "ledger" ? `tests/test_${base}.py` : `tests/${base}.bats`;
    b.user(`Add unit tests for ${def}, especially the edge cases`);
    b.step({ calls: [b.read(def)] });
    b.step({ calls: [b.write(testFile, fileBody(p, testFile))] });
    if (chance(0.5)) {
      b.step({ calls: [b.test({ fail: p.key === "ledger" ? pytestFail(`test_${base}_empty`, "E       assert None == []", 44) : p.key === "web" ? vitestFail(p, b.t, testFile, `${base} > handles the empty case`, "[]", "undefined", 6) : "test result: FAILED. 22 passed; 1 failed", dur: int(3_000, 20_000) })] });
      b.step({ think: "The function returns nothing for empty input; the test expectation is right, fix the function.", calls: [b.edit(def, "  return rows[0] ?? null;", "  return rows[0] ?? [];")] });
    }
    b.step({ calls: [b.test()] });
    b.say(`Added \`${testFile}\` covering empty input, ordering and the error path. Tests pass.`);
  },
  // Lint fixes.
  (b) => {
    const p = b.s.project;
    const file = pick(Object.keys(p.notes));
    b.user(`Fix the lint errors in ${file}`);
    b.step({ calls: [b.sh(`${p.lint}`, `${file}\n  ${int(3, 60)}:${int(1, 30)}  error  'unused' is defined but never used  no-unused-vars\n  ${int(3, 60)}:${int(1, 30)}  warning  Prefer const  prefer-const\n\n✖ 2 problems (1 error, 1 warning)`, { err: true, exit: 1, dur: int(3_000, 12_000) })] });
    b.step({ calls: [b.edit(file, "let unused = config;\n", ""), b.edit(file, "let result =", "const result =")] });
    b.step({ calls: [b.sh(p.lint, "", { dur: int(3_000, 12_000) })] });
    b.say("Lint is clean.");
  },
  // Where is X configured?
  (b) => {
    const p = b.s.project;
    const [topic, pattern, file] = pick(p.configs);
    b.user(`Where is ${topic} configured?`);
    b.step({ calls: [b.grep(pattern, `${file}:${int(3, 40)}`)] });
    b.step({ calls: [b.read(file)] });
    b.say(`In \`${file}\` (\`${pattern}\`). It is not overridable per environment yet.`);
  },
  // Doc comments.
  (b) => {
    const p = b.s.project;
    const file = pick(Object.keys(p.notes).filter((f) => !f.endsWith(".yaml") && !f.endsWith(".yml")));
    b.user(`Add doc comments to the public functions in ${file}`);
    b.step({ calls: [b.read(file)] });
    const c = p.key === "orbit" ? "///" : p.key === "ledger" ? '"""' : p.key === "infra" ? "#" : "/**";
    b.step({ calls: [b.edit(file, "export async function", `${c} Loads the record or returns null when it does not exist.\nexport async function`)] });
    b.say(`Documented the public functions in \`${file}\`.`);
  },
];

const CHORE_MODELS: Record<Tool, string[]> = {
  omp: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5"],
  claude: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  codex: ["gpt-5.1-codex", "gpt-5.1-codex-mini"],
};

// ---------------------------------------------------------------------------------------------------------------
// Writers: one per tool, emitting that tool's JSONL lines

interface Writer {
  head(): string[];
  entry(e: Entry): string[];
  tail(): string[];
}

const abs = (s: Session, p: string) => `${s.project.cwd}/${p}`;

function costOf(model: string, u: Usage) {
  const price = DEFAULT_PRICES[normalizeModel(model)];
  if (!price) return undefined;
  const r = (n: number) => Math.round(n * 1e8) / 1e8;
  const parts = {
    input: r((u.input * price.input) / 1e6),
    output: r((u.output * price.output) / 1e6),
    cacheRead: r((u.cacheRead * price.cacheRead) / 1e6),
    cacheWrite: r((u.cacheWrite * (price.cacheWrite5m ?? price.input * 1.25)) / 1e6),
  };
  return { ...parts, total: r(parts.input + parts.output + parts.cacheRead + parts.cacheWrite) };
}

const editInputs = (a: Extract<Action, { k: "edit" }>) => a.neu.split("\n").map((l) => `+${l}`).join("\n");

class OmpWriter implements Writer {
  private last: string | null = null;
  private parts = new Map<string, string[]>();
  constructor(
    private s: Session,
    private parentRef?: string,
  ) {}

  private line(type: string, ts: number, body: Record<string, unknown>): string {
    const id = hex(8);
    const l = JSON.stringify({ type, id, parentId: this.last, timestamp: iso(ts), ...body });
    this.last = id;
    return l;
  }

  head(): string[] {
    const s = this.s;
    return [
      JSON.stringify({ type: "session", version: 3, id: s.id, timestamp: iso(s.start), cwd: s.project.cwd, ...(s.depth === 0 ? { title: s.title, titleSource: "auto" } : {}), ...(this.parentRef ? { parentSession: this.parentRef } : {}) }),
      JSON.stringify({ type: "title", v: 1, title: s.depth === 0 ? (s.title ?? "") : "", source: "auto", updatedAt: iso(s.end), pad: " ".repeat(48) }),
      this.line("model_change", s.start, { model: `anthropic/${s.model}`, resolvedModelIsFallback: false }),
    ];
  }

  private call(c: Call): { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } {
    const a = c.a;
    const tag = () => hex(4).toUpperCase();
    const id = `toolu_${c.id}`;
    const tc = (name: string, args: Record<string, unknown>) => ({ type: "toolCall" as const, id, name, arguments: args });
    switch (a.k) {
      case "read":
        return tc("read", { path: a.path });
      case "write":
        return tc("write", { path: a.path, content: a.content });
      case "edit": {
        const line = int(4, 80);
        return tc("edit", { input: `[${a.path}#${tag()}]\nPUT ${line}.=${line + a.old.split("\n").length - 1}:\n${editInputs(a)}` });
      }
      case "rm":
        return tc("edit", { input: `[${a.path}#${tag()}]\nREM` });
      case "mv":
        return tc("edit", { input: `[${a.path}#${tag()}]\nMV ${a.to}` });
      case "grep":
        return tc("grep", { pattern: a.pattern, path: a.path ?? "." });
      case "glob":
        return tc("glob", { path: a.pattern });
      case "bash":
        return tc("bash", { command: a.cmd });
      case "search":
        return tc("web_search", { query: a.query });
      case "fetch":
        return tc("read", { path: a.url });
      case "mcp":
        return tc(a.name, a.args);
      case "spawn":
        return tc("task", { context: a.context, tasks: a.agents.map((t) => ({ name: t.name, task: t.task })) });
    }
  }

  private resultText(e: Extract<Entry, { k: "result" }>): string {
    if (e.text !== undefined) return e.text;
    const a = e.call.a;
    if (a.k === "edit") return `Applied edit to ${a.path}`;
    if (a.k === "write") return `Wrote ${a.content.split("\n").length} lines to ${a.path}`;
    if (a.k === "rm") return `Deleted ${a.path}`;
    if (a.k === "mv") return `Moved ${a.path} → ${a.to}`;
    return "";
  }

  entry(e: Entry): string[] {
    const s = this.s;
    switch (e.k) {
      case "user": {
        const agent = s.depth > 0 && !s.entries.slice(0, s.entries.indexOf(e)).some((x) => x.k === "user");
        return [this.line("message", e.ts, { message: { role: "user", attribution: agent ? "agent" : "user", content: [{ type: "text", text: e.text }], timestamp: e.ts } })];
      }
      case "inject":
        return [this.line("custom_message", e.ts, { customType: "mid-run-todo-nudge", content: e.text, display: false, attribution: "agent" })];
      case "model":
        return [this.line("model_change", e.ts, { model: `anthropic/${e.model}` })];
      case "req": {
        const content: unknown[] = [];
        if (e.think) content.push({ type: "thinking", thinking: e.think, thinkingSignature: hex(32) });
        if (e.say) content.push({ type: "text", text: e.say });
        for (const c of e.calls) content.push(this.call(c));
        const cost = costOf(e.model, e.usage);
        const u = e.usage;
        return [
          this.line("message", e.ts, {
            message: {
              role: "assistant",
              model: e.model,
              provider: "anthropic",
              api: "anthropic-messages",
              content,
              usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite, ...(cost ? { cost } : {}) },
              stopReason: e.calls.length ? "toolUse" : "stop",
              timestamp: e.ts,
            },
          }),
        ];
      }
      case "result": {
        const a = e.call.a;
        let text = this.resultText(e);
        if (a.k === "spawn") {
          const got = this.parts.get(e.call.id) ?? [];
          got[e.part] = `## ${a.agents[e.part].name}\n${text}`;
          this.parts.set(e.call.id, got);
          if (got.filter(Boolean).length < a.agents.length) return [];
          text = got.join("\n\n");
        }
        return [this.line("message", e.ts, { message: { role: "toolResult", toolCallId: `toolu_${e.call.id}`, toolName: this.call(e.call).name, content: [{ type: "text", text }], isError: e.err, timestamp: e.ts } })];
      }
      case "compact":
        return [this.line("compaction", e.ts, { summary: e.summary, tokensBefore: e.preTokens })];
      case "apiError":
        return [
          this.line("message", e.ts, {
            message: { role: "assistant", model: e.model, provider: "anthropic", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: e.text, timestamp: e.ts },
          }),
        ];
    }
  }

  tail(): string[] {
    return [];
  }
}

class ClaudeWriter implements Writer {
  private last: string | null = null;
  constructor(
    private s: Session,
    private sessionId: string,
    private agentId?: string,
  ) {}

  private line(ts: number, body: Record<string, unknown>, parentUuid: string | null = this.last): string {
    const id = uuid();
    const l = JSON.stringify({
      parentUuid,
      isSidechain: this.agentId !== undefined,
      userType: "external",
      cwd: this.s.project.cwd,
      sessionId: this.sessionId,
      version: "2.1.288",
      gitBranch: this.s.branch,
      ...(this.agentId ? { agentId: this.agentId } : {}),
      ...body,
      uuid: id,
      timestamp: iso(ts),
    });
    this.last = id;
    return l;
  }

  head(): string[] {
    return this.agentId ? [] : [JSON.stringify({ type: "permission-mode", permissionMode: "default", sessionId: this.sessionId })];
  }

  private uses(c: Call): { id: string; name: string; input: Record<string, unknown> }[] {
    const a = c.a;
    const s = this.s;
    const id = `toolu_01${c.id.slice(0, 22)}`;
    const one = (name: string, input: Record<string, unknown>) => [{ id, name, input }];
    switch (a.k) {
      case "read":
        return one("Read", { file_path: abs(s, a.path.replace(/:\d.*$/, "")) });
      case "write":
        return one("Write", { file_path: abs(s, a.path), content: a.content });
      case "edit":
        return one("Edit", { file_path: abs(s, a.path), old_string: a.old, new_string: a.neu });
      case "rm":
        return one("Bash", { command: `git rm ${a.path}`, description: `Delete ${path.posix.basename(a.path)}` });
      case "mv":
        return one("Bash", { command: `git mv ${a.path} ${a.to}`, description: `Move ${path.posix.basename(a.path)}` });
      case "grep":
        return one("Grep", { pattern: a.pattern, ...(a.path ? { path: abs(s, a.path) } : {}), output_mode: "content", "-n": true });
      case "glob":
        return one("Glob", { pattern: a.pattern });
      case "bash":
        return one("Bash", { command: a.cmd, ...(a.desc ? { description: a.desc } : {}) });
      case "search":
        return one("WebSearch", { query: a.query });
      case "fetch":
        return one("WebFetch", { url: a.url, prompt: a.prompt ?? "Summarize the relevant parts" });
      case "mcp":
        return one(a.name, a.args);
      case "spawn":
        return a.agents.map((t, i) => ({ id: `${id.slice(0, -1)}${i}`, name: "Task", input: { description: t.name, prompt: t.task, subagent_type: t.name === "Explore" ? "Explore" : "general-purpose" } }));
    }
  }

  private resultText(e: Extract<Entry, { k: "result" }>): string {
    const a = e.call.a;
    if (e.text !== undefined) {
      if (a.k === "read" && !e.err) return e.text.split("\n").map((l, i) => `${String(i + 1).padStart(6)}\t${l.replace(/^\d+:/, "")}`).join("\n");
      return e.text || "(no output)";
    }
    if (a.k === "edit") return `The file ${abs(this.s, a.path)} has been updated successfully.`;
    if (a.k === "write") return `File created successfully at: ${abs(this.s, a.path)}`;
    if (a.k === "rm") return `rm '${a.path}'`;
    return "(no output)";
  }

  entry(e: Entry): string[] {
    switch (e.k) {
      case "user":
        return [this.line(e.ts, { type: "user", message: { role: "user", content: e.text } })];
      case "inject":
        return [this.line(e.ts, { type: "user", message: { role: "user", content: e.text }, isMeta: true })];
      case "model":
        return [];
      case "req": {
        const blocks: unknown[] = [];
        if (e.think) blocks.push({ type: "thinking", thinking: e.think, signature: hex(64) });
        if (e.say) blocks.push({ type: "text", text: e.say });
        for (const c of e.calls) for (const u of this.uses(c)) blocks.push({ type: "tool_use", ...u });
        const id = `msg_01${hex(22)}`;
        const requestId = `req_011${hex(21)}`;
        const u = e.usage;
        const usage = {
          input_tokens: u.input,
          cache_creation_input_tokens: u.cacheWrite,
          cache_read_input_tokens: u.cacheRead,
          cache_creation: { ephemeral_5m_input_tokens: u.cacheWrite, ephemeral_1h_input_tokens: 0 },
          output_tokens: u.output,
          service_tier: "standard",
        };
        // One line per content block, each repeating the message id and usage.
        return blocks.map((block, i) =>
          this.line(e.ts - (blocks.length - 1 - i) * 150, {
            type: "assistant",
            message: { model: e.model, id, type: "message", role: "assistant", content: [block], stop_reason: i === blocks.length - 1 ? (e.calls.length ? "tool_use" : "end_turn") : null, stop_sequence: null, usage },
            requestId,
          }),
        );
      }
      case "result": {
        const use = this.uses(e.call)[e.part];
        return [this.line(e.ts, { type: "user", message: { role: "user", content: [{ tool_use_id: use.id, type: "tool_result", content: this.resultText(e), ...(e.err ? { is_error: true } : {}) }] } })];
      }
      case "compact": {
        const boundary = this.line(e.ts, { type: "system", subtype: "compact_boundary", content: "Conversation compacted", isMeta: false, level: "info", logicalParentUuid: this.last, compactMetadata: { trigger: "auto", preTokens: e.preTokens } }, null);
        const summary = this.line(e.ts + 50, {
          type: "user",
          message: { role: "user", content: `This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\n${e.summary}` },
          isCompactSummary: true,
          isVisibleInTranscriptOnly: true,
        });
        return [boundary, summary];
      }
      case "apiError":
        return [this.line(e.ts, { type: "system", subtype: "api_error", level: "error", content: e.text, retryInMs: int(5, 30) * 1000, retryAttempt: 1, maxRetries: 10 })];
    }
  }

  tail(): string[] {
    return this.agentId || !this.s.title ? [] : [JSON.stringify({ type: "ai-title", aiTitle: this.s.title, sessionId: this.sessionId })];
  }
}

class CodexWriter implements Writer {
  private totals = { input: 0, cached: 0, output: 0, reasoning: 0 };
  constructor(
    private s: Session,
    private parent?: Session,
  ) {}

  private line(ts: number, type: string, payload: Record<string, unknown>): string {
    return JSON.stringify({ timestamp: iso(ts), type, payload });
  }

  private turnContext(ts: number, model: string): string {
    return this.line(ts, "turn_context", { cwd: this.s.project.cwd, approval_policy: "on-request", sandbox_policy: { mode: "workspace-write", network_access: false }, model, effort: "medium", summary: "auto" });
  }

  head(): string[] {
    const s = this.s;
    const source = this.parent ? { subagent: { thread_spawn: { parent_thread_id: this.parent.id, depth: s.depth } } } : "cli";
    return [
      this.line(s.start, "session_meta", {
        id: s.id,
        timestamp: iso(s.start),
        cwd: s.project.cwd,
        originator: "codex_cli_rs",
        cli_version: "0.58.0",
        instructions: null,
        source,
        model_provider: "openai",
        git: { commit_hash: hex(40), branch: s.branch, repository_url: `git@github.com:acme-demo/${s.project.name}.git` },
      }),
      this.line(s.start + 5, "response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `<environment_context>\n  <cwd>${s.project.cwd}</cwd>\n  <approval_policy>on-request</approval_policy>\n  <sandbox_mode>workspace-write</sandbox_mode>\n  <network_access>restricted</network_access>\n  <shell>bash</shell>\n</environment_context>` }],
      }),
    ];
  }

  private shell(a: Action): string | undefined {
    switch (a.k) {
      case "read":
        return `sed -n '1,200p' ${a.path.replace(/:\d.*$/, "")}`;
      case "grep":
        return `rg -n "${a.pattern.replace(/"/g, '\\"')}" ${a.path ?? "."}`;
      case "glob":
        return `rg --files -g '${a.pattern}'`;
      case "bash":
        return a.cmd;
      case "fetch":
        return `curl -sL ${a.url} | sed -n '1,120p'`;
      default:
        return undefined;
    }
  }

  private patch(a: Action): string | undefined {
    const body = (s: string, sign: string) => s.split("\n").map((l) => `${sign}${l}`).join("\n");
    switch (a.k) {
      case "write":
        return `*** Begin Patch\n*** Add File: ${a.path}\n${body(a.content, "+")}\n*** End Patch`;
      case "edit":
        return `*** Begin Patch\n*** Update File: ${a.path}\n@@\n${body(a.old, "-")}\n${body(a.neu, "+")}\n*** End Patch`;
      case "rm":
        return `*** Begin Patch\n*** Delete File: ${a.path}\n*** End Patch`;
      case "mv":
        return `*** Begin Patch\n*** Update File: ${a.path}\n*** Move to: ${a.to}\n*** End Patch`;
      default:
        return undefined;
    }
  }

  private callItems(c: Call): Record<string, unknown>[] {
    const a = c.a;
    const call_id = `call_${c.id}`;
    const cmd = this.shell(a);
    if (cmd !== undefined) return [{ type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", cmd], workdir: this.s.project.cwd, timeout_ms: 120_000 }), call_id }];
    const patch = this.patch(a);
    if (patch !== undefined) return [{ type: "custom_tool_call", status: "completed", call_id, name: "apply_patch", input: patch }];
    if (a.k === "search") return [{ type: "web_search_call", id: `ws_${c.id}`, status: "completed", action: { type: "search", query: a.query } }];
    if (a.k === "mcp") return [{ type: "function_call", name: a.name, arguments: JSON.stringify(a.args), call_id }];
    if (a.k === "spawn") return a.agents.map((t, i) => ({ type: "function_call", name: "spawn_agent", arguments: JSON.stringify({ message: t.task, agent_type: t.name }), call_id: `${call_id}_${i}` }));
    return [];
  }

  entry(e: Entry): string[] {
    switch (e.k) {
      case "user":
        return [
          this.turnContext(e.ts - 20, this.s.model),
          this.line(e.ts, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: e.text }] }),
          this.line(e.ts + 5, "event_msg", { type: "user_message", message: e.text, images: [] }),
        ];
      case "inject":
        return [];
      case "model":
        return [this.turnContext(e.ts, e.model)];
      case "req": {
        const out: string[] = [];
        const at = (i: number) => e.ts - 200 + i * 10;
        let i = 0;
        if (e.think) {
          out.push(this.line(at(i++), "response_item", { type: "reasoning", summary: [{ type: "summary_text", text: e.think }], content: null, encrypted_content: `gAAAAA${hex(80)}` }));
          out.push(this.line(at(i++), "event_msg", { type: "agent_reasoning", text: e.think }));
        }
        if (e.say) {
          out.push(this.line(at(i++), "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: e.say }] }));
          out.push(this.line(at(i++), "event_msg", { type: "agent_message", message: e.say }));
        }
        for (const c of e.calls) for (const item of this.callItems(c)) out.push(this.line(at(i++), "response_item", item));
        const u = e.usage;
        const last = { input_tokens: u.input + u.cacheRead, cached_input_tokens: u.cacheRead, output_tokens: u.output, reasoning_output_tokens: u.reasoning, total_tokens: u.input + u.cacheRead + u.output };
        this.totals.input += last.input_tokens;
        this.totals.cached += last.cached_input_tokens;
        this.totals.output += last.output_tokens;
        this.totals.reasoning += last.reasoning_output_tokens;
        const total = {
          input_tokens: this.totals.input,
          cached_input_tokens: this.totals.cached,
          output_tokens: this.totals.output,
          reasoning_output_tokens: this.totals.reasoning,
          total_tokens: this.totals.input + this.totals.output,
        };
        out.push(this.line(e.ts, "event_msg", { type: "token_count", info: { total_token_usage: total, last_token_usage: last, model_context_window: 272_000 }, rate_limits: { primary: { used_percent: int(5, 60), window_minutes: 300 } } }));
        return out;
      }
      case "result": {
        const a = e.call.a;
        const call_id = `call_${e.call.id}`;
        if (a.k === "search") return [];
        if (a.k === "spawn") return [this.line(e.ts, "response_item", { type: "function_call_output", call_id: `${call_id}_${e.part}`, output: e.text ?? "" })];
        if (a.k === "mcp") return [this.line(e.ts, "response_item", { type: "function_call_output", call_id, output: { content: e.text ?? "", success: !e.err } })];
        const exit = e.exit ?? (e.err ? 1 : 0);
        const metadata = { exit_code: exit, duration_seconds: Math.round(e.dur / 100) / 10 };
        if (this.patch(a) !== undefined && "path" in a) {
          const verb = a.k === "write" ? "A" : a.k === "rm" ? "D" : "M";
          const text = e.err ? (e.text ?? "Failed to apply patch") : `Success. Updated the following files:\n${verb} ${a.path}\n`;
          return [this.line(e.ts, "response_item", { type: "custom_tool_call_output", call_id, output: JSON.stringify({ output: text, metadata }) })];
        }
        return [this.line(e.ts, "response_item", { type: "function_call_output", call_id, output: JSON.stringify({ output: e.text ?? "", metadata }) })];
      }
      case "compact":
        return [this.line(e.ts, "compacted", { message: e.summary })];
      case "apiError":
        return [this.line(e.ts, "event_msg", { type: "error", message: e.text })];
    }
  }

  tail(): string[] {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Layout on disk

interface Layout {
  out: string;
  omp: string;
  claude: string;
  codex: string;
  data: string;
}

const layout = (out: string): Layout => ({
  out,
  omp: path.join(out, "logs", "omp"),
  claude: path.join(out, "logs", "claude", "projects"),
  codex: path.join(out, "logs", "codex", "sessions"),
  data: path.join(out, "data"),
});

const MARKER = ".agent-monitor-demo";

function demoEnv(l: Layout): Record<string, string> {
  return {
    AGENT_MONITOR_DB: path.join(l.data, "monitor.db"),
    AGENT_MONITOR_USER_DB: path.join(l.data, "user.db"),
    AGENT_MONITOR_ARCHIVE: path.join(l.data, "archive"),
    AGENT_MONITOR_PRICING: path.join(l.out, "pricing.json"),
    AGENT_MONITOR_OMP_DIRS: l.omp,
    AGENT_MONITOR_CLAUDE_CODE_DIRS: l.claude,
    AGENT_MONITOR_CODEX_DIRS: l.codex,
  };
}

const fileStamp = (ms: number): string => iso(ms).replace(/:/g, "-").replace(".", "-");
const localStamp = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
};
/** omp names project folders after the cwd relative to home; Claude Code after the absolute path. */
const ompSlug = (cwd: string): string => `-${path.posix.relative(HOME, cwd).replace(/\//g, "-")}`;
const claudeSlug = (cwd: string): string => cwd.replace(/[/.]/g, "-");

interface Written {
  file: string;
  writer: Writer;
}

function writeFile(file: string, lines: string[], end: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  const t = new Date(end);
  fs.utimesSync(file, t, t);
}

function render(writer: Writer, s: Session): string[] {
  return [...writer.head(), ...s.entries.flatMap((e) => writer.entry(e)), ...writer.tail()];
}

/** Write a session and its subagents; returns where the top-level session went. */
function writeTree(l: Layout, s: Session): Written {
  if (s.tool === "omp") {
    const file = path.join(l.omp, ompSlug(s.project.cwd), `${fileStamp(s.start)}_${s.id}.jsonl`);
    const writer = new OmpWriter(s);
    writeFile(file, render(writer, s), s.end);
    const children = (parent: Session, parentFile: string) => {
      for (const c of parent.children) {
        const file = path.join(parentFile.slice(0, -".jsonl".length), `${c.name}.jsonl`);
        // Direct subagents point at the parent's log path; deeper ones at the parent's session id.
        const ref = parent.depth === 0 ? parentFile.replace(l.omp, `${HOME}/.omp/agent/sessions`) : parent.id;
        writeFile(file, render(new OmpWriter(c, ref), c), c.end);
        children(c, file);
      }
    };
    children(s, file);
    return { file, writer };
  }
  if (s.tool === "claude") {
    const dir = path.join(l.claude, claudeSlug(s.project.cwd));
    const file = path.join(dir, `${s.id}.jsonl`);
    const writer = new ClaudeWriter(s, s.id);
    writeFile(file, render(writer, s), s.end);
    const children = (parent: Session) => {
      for (const c of parent.children) {
        const agentId = hex(17);
        writeFile(path.join(dir, s.id, "subagents", `agent-${agentId}.jsonl`), render(new ClaudeWriter(c, s.id, agentId), c), c.end);
        children(c);
      }
    };
    children(s);
    return { file, writer };
  }
  const codexFile = (c: Session) => {
    const d = new Date(c.start);
    return path.join(l.codex, String(d.getFullYear()), pad2(d.getMonth() + 1), pad2(d.getDate()), `rollout-${localStamp(c.start)}-${c.id}.jsonl`);
  };
  const file = codexFile(s);
  const writer = new CodexWriter(s);
  writeFile(file, render(writer, s), s.end);
  const children = (parent: Session) => {
    for (const c of parent.children) {
      writeFile(codexFile(c), render(new CodexWriter(c, parent), c), c.end);
      children(c);
    }
  };
  children(s);
  return { file, writer };
}

// ---------------------------------------------------------------------------------------------------------------
// The calendar

interface Planned {
  tool: Tool;
  model: string;
  project: Project;
  title?: string;
  branch?: string;
  run: (b: Builder) => void;
}

const SCRIPTED: Planned[] = [
  { tool: "omp", model: "claude-opus-5-5", project: WEB, title: "Rate limiting for /api/orders", branch: "feat/orders-rate-limit", run: rateLimit },
  { tool: "claude", model: "claude-sonnet-5-5", project: WEB, title: "Fix flaky checkout total test", branch: "fix/checkout-total", run: flakyCheckout },
  { tool: "omp", model: "claude-sonnet-5-5", project: WEB, title: "Move cart components, adopt Dialog", branch: "refactor/cart-dialog", run: dialogMigration },
  { tool: "claude", model: "claude-opus-5-5", project: WEB, title: "Product page caching options", run: cachingResearch },
  { tool: "codex", model: "gpt-5.1-codex", project: WEB, branch: "chore/zod-4", run: zodUpgrade },
  { tool: "claude", model: "claude-sonnet-5-5", project: WEB, title: "Open PR for rate limiter", branch: "feat/orders-rate-limit", run: openPr },
  { tool: "claude", model: "claude-opus-5-5", project: WEB, title: "API key auth for API routes", branch: "feat/api-keys", run: authRefactor },
  { tool: "omp", model: "claude-opus-5-5", project: ORBIT, title: "Telemetry batch endpoint", branch: "feat/telemetry-batch", run: telemetryBatch },
  { tool: "codex", model: "gpt-5.1-codex", project: ORBIT, branch: "perf/startup", run: slowStartup },
  { tool: "claude", model: "claude-sonnet-4-6", project: ORBIT, title: "Fix clippy warnings", branch: "chore/clippy", run: clippy },
  { tool: "omp", model: "claude-opus-5-5", project: ORBIT, title: "Error handling audit", branch: "fix/error-leaks", run: errorAudit },
  { tool: "codex", model: "gpt-5.1-codex", project: ORBIT, branch: "feat/orbit-history", run: migration },
  { tool: "claude", model: "claude-sonnet-5-5", project: LEDGER, title: "Semicolon CSV import", branch: "feat/semicolon-csv", run: csvSemicolon },
  { tool: "omp", model: "claude-sonnet-5-5", project: LEDGER, title: "Refunds matched twice in reconcile", branch: "fix/refund-matching", run: refundDoubleCount },
  { tool: "codex", model: "gpt-5.1-codex", project: LEDGER, branch: "chore/uv", run: uvMigration },
  { tool: "omp", model: "claude-sonnet-5-5", project: LEDGER, title: "Currency rounding research", run: decimalResearch },
  { tool: "claude", model: "claude-haiku-4-5-20251001", project: LEDGER, title: "Type hints for currency.py", run: mypy },
  { tool: "omp", model: "claude-sonnet-5-5", project: INFRA, title: "HPA for orbit-api", branch: "main", run: hpa },
  { tool: "claude", model: "claude-sonnet-5-5", project: INFRA, title: "Backup script permission denied", run: backupScript },
  { tool: "codex", model: "gpt-5.1-codex", project: INFRA, branch: "fix/staging-certs", run: certRotation },
  { tool: "claude", model: "claude-opus-5-5", project: INFRA, title: "Cache pnpm store in deploy workflow", branch: "ci/pnpm-cache", run: deployCache },
];

const CHORE_COUNT = 32;
const DAYS = 28;
const HOUR_WEIGHTS = [0.15, 0.05, 0, 0, 0, 0, 0.05, 0.3, 0.9, 1.6, 2, 1.8, 0.7, 1.2, 1.9, 2, 1.7, 1.1, 0.5, 0.4, 0.8, 0.9, 0.6, 0.3];

function weighted(weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

/** A start time in the last four weeks, weighted to weekdays and working hours (local time). */
function slot(now: number): number {
  const dayWeights = Array.from({ length: DAYS }, (_, d) => {
    const day = new Date(now - d * DAY).getDay();
    return day === 0 || day === 6 ? 0.25 : 1;
  });
  for (;;) {
    const d = new Date(now - weighted(dayWeights) * DAY);
    d.setHours(weighted(HOUR_WEIGHTS), int(0, 59), int(0, 59), int(0, 999));
    if (d.getTime() < now - 20 * MIN) return d.getTime();
  }
}

function choreSession(now: number, i: number): Builder {
  const tool: Tool = pick(["omp", "omp", "claude", "claude", "claude", "codex"]);
  const project = PROJECTS[i % PROJECTS.length];
  const b = new Builder(tool, project, slot(now), { model: pick(CHORE_MODELS[tool]), branch: pick(["main", "main", "dev"]) });
  if (tool === "claude" && chance(0.3)) b.inject("<command-name>/clear</command-name>\n<command-message>clear</command-message>");
  const n = int(1, 3);
  for (let k = 0; k < n; k++) {
    if (k > 0 && chance(0.3)) b.idle(int(6, 25));
    if (k > 0 && chance(0.12)) b.apiError(b.s.tool === "codex" ? "stream error: 429 Too Many Requests: rate limit reached, retrying in 12s" : "429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit");
    pick(CHORES)(b, k === 0);
  }
  const first = b.s.entries.find((e): e is Extract<Entry, { k: "user" }> => e.k === "user");
  b.s.title = first ? first.text.replace(/`/g, "").slice(0, 60) : undefined;
  return b;
}

interface Generated {
  sessions: Session[];
  live: { builder: Builder; file: string; writer: Writer };
}

function generate(l: Layout, now: number): Generated {
  if (fs.existsSync(l.out) && fs.readdirSync(l.out).length && !fs.existsSync(path.join(l.out, MARKER))) {
    throw new Error(`${l.out} exists and is not a demo dataset (no ${MARKER}); refusing to overwrite it`);
  }
  fs.rmSync(path.join(l.out, "logs"), { recursive: true, force: true });
  fs.rmSync(l.data, { recursive: true, force: true });
  fs.mkdirSync(l.out, { recursive: true });
  fs.writeFileSync(path.join(l.out, MARKER), `Synthetic Agent Monitor demo data, generated ${iso(now)} by scripts/demo.ts\n`);
  fs.writeFileSync(path.join(l.out, "pricing.json"), "{}\n");

  const builders = SCRIPTED.map((p) => {
    const b = new Builder(p.tool, p.project, slot(now), { model: p.model, title: p.title, branch: p.branch });
    p.run(b);
    return b;
  });
  for (let i = 0; i < CHORE_COUNT; i++) builders.push(choreSession(now, i));
  const live = new Builder("omp", WEB, now - 25 * MIN, { model: "claude-opus-5-5", title: "Paginate the admin orders table", branch: "feat/admin-pagination" });
  livePagination(live);

  const latest = now - 2 * MIN;
  for (const b of builders) {
    if (b.s.end > latest) shiftSession(b.s, latest - b.s.end - int(5, 120) * MIN);
  }
  shiftSession(live.s, now - int(5, 20) * SEC - live.s.end);
  live.t = live.s.end;

  const sessions = [...builders.map((b) => b.s), live.s];
  let liveWritten: Written | undefined;
  for (const s of sessions) {
    const w = writeTree(l, s);
    if (s === live.s) liveWritten = w;
  }
  if (!liveWritten) throw new Error("live session was not written");
  return { sessions, live: { builder: live, ...liveWritten } };
}

function countTree(sessions: Session[]): { top: number; sub: number; requests: number; byTool: Record<Tool, number> } {
  const r = { top: sessions.length, sub: 0, requests: 0, byTool: { omp: 0, claude: 0, codex: 0 } as Record<Tool, number> };
  const walk = (s: Session) => {
    r.requests += s.entries.filter((e) => e.k === "req").length;
    for (const c of s.children) {
      r.sub++;
      walk(c);
    }
  };
  for (const s of sessions) {
    r.byTool[s.tool]++;
    walk(s);
  }
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// Commands

function runLive(g: Generated) {
  const { builder: b, file, writer } = g.live;
  let i = 0;
  return setInterval(() => {
    if (b.t > Date.now() - 1_000) return;
    b.t = Math.max(b.t, Date.now() - 12_000);
    const from = b.s.entries.length;
    LIVE_STEPS[i++ % LIVE_STEPS.length](b);
    const lines = b.s.entries.slice(from).flatMap((e) => writer.entry(e));
    if (lines.length) fs.appendFileSync(file, `${lines.join("\n")}\n`);
  }, 6_000);
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args.find((a) => !a.startsWith("--")) ?? "generate";
  const outIndex = args.indexOf("--out");
  const out = path.resolve(outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : ".demo");
  const l = layout(out);
  const env = demoEnv(l);

  if (command === "env") {
    for (const [k, v] of Object.entries(env)) console.log(`export ${k}=${JSON.stringify(v)}`);
    return;
  }

  if (command === "generate") {
    const g = generate(l, Date.now());
    const c = countTree(g.sessions);
    console.log(`demo data in ${out}: ${c.top} sessions (omp ${c.byTool.omp}, Claude Code ${c.byTool.claude}, Codex ${c.byTool.codex}) + ${c.sub} subagents, ${c.requests} model requests`);
    console.log(`ingest with: eval "$(pnpm -s tsx scripts/demo.ts env${outIndex >= 0 ? ` --out ${out}` : ""})" && pnpm sync`);
    return;
  }

  if (command === "serve") {
    const live = args.includes("--live");
    let g: Generated | undefined;
    if (live || !fs.existsSync(path.join(out, "logs"))) {
      g = generate(l, Date.now());
      console.log(`generated demo data in ${out}`);
    }
    // Through scripts/next.mjs, like the package.json scripts: Next.js telemetry stays off.
    const next = path.join(import.meta.dirname, "next.mjs");
    const child = spawn(process.execPath, [next, "dev", "--hostname", "127.0.0.1", "--port", "4200"], { stdio: "inherit", env: { ...process.env, ...env } });
    const timer = live && g ? runLive(g) : undefined;
    let stopping = false;
    const stop = (signal: NodeJS.Signals) => {
      stopping = true;
      // `kill` reaches the Next CLI only; on Windows its server runs as a grandchild that would keep port 4200.
      const tree =
        process.platform === "win32" && child.pid !== undefined &&
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }).status === 0;
      if (!tree) child.kill(signal);
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop(signal));
    child.on("error", (error) => {
      clearInterval(timer);
      console.error(`demo: could not start the dev server: ${error.message}`);
      process.exit(1);
    });
    child.on("exit", (code) => {
      clearInterval(timer);
      // A signal (or the hard kill above) leaves no code; that is a normal stop, a non-zero code is the server's.
      process.exit(stopping ? 0 : (code ?? 0));
    });
    return;
  }

  console.error(`unknown command "${command}"; use generate, serve or env (see the comment at the top of scripts/demo.ts)`);
  process.exitCode = 1;
}

main();
