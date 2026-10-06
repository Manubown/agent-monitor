import type { Metadata } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import { Suspense } from "react";
import { type SyncStatus, syncStatus } from "../src/store/queries";
import { syncNow } from "./actions";
import { ImportProgress, LiveRefresh, MotionToggle, Nav, SyncButton, SyncedAgo } from "./components/client";
import { Search, TargetEvent } from "./components/search";
import { ago } from "./lib/format";
import { healthKey } from "./lib/live";
import { lastSync, ready, storedFiles, syncHealth } from "./lib/server";
import "./globals.css";

/**
 * Geist Pixel Square from the `geist` package (OFL), for display type only. Loaded from the file rather than through
 * `geist/font/pixel`, which declares all five Geist Pixel variants and so preloads every one of them on every route.
 */
const geistPixel = localFont({
  src: "../node_modules/geist/dist/fonts/geist-pixel/GeistPixel-Square.woff2",
  variable: "--font-geist-pixel-square",
  weight: "500",
  adjustFontFallback: false,
});

export const metadata: Metadata = {
  title: "Agent Monitor",
  description: "Sessions, tool calls and token spend of your AI coding agents",
};

export const dynamic = "force-dynamic";

/**
 * The shell (top bar, navigation, search) renders at once. The sync summary and the page wait for this server's first
 * sync behind Suspense: on a fresh install that import can take minutes, and meanwhile the fallbacks show its progress.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  const last = lastSync();
  const importing = last === undefined;
  const files = importing ? storedFiles() : null;
  return (
    <html lang="en" className={geistPixel.variable}>
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            <span className="brand-mark" />
            Agent Monitor
          </Link>
          <Nav />
          <Search />
          <div className="sync">
            <LiveRefresh generation={last?.generation ?? null} health={healthKey(syncHealth())} />
            <Suspense fallback={<span className="muted">{importing ? <ImportProgress files={files} /> : "Loading…"}</span>}>
              <SyncSummary />
            </Suspense>
            <MotionToggle />
            <form action={syncNow}>
              <SyncButton />
            </form>
          </div>
        </header>
        <TargetEvent />
        <main className="main">
          {/*
            Pages call ready() themselves; until the first sync finishes they suspend into this fallback. Afterwards no
            boundary: a page that is not found must still answer 404, which a streamed boundary would turn into 200.
            Trade-off, accepted: the first render after the import has a different tree around `children`, so React
            remounts the page content once (client state such as an open <details> is lost, a single time per server).
          */}
          {importing ? <Suspense fallback={<Importing files={files} />}>{children}</Suspense> : children}
        </main>
      </body>
    </html>
  );
}

function Importing({ files }: { files: number | null }) {
  return (
    <section className="card" aria-busy="true">
      <div className="empty">
        <h2>
          <ImportProgress files={files} />
        </h2>
        <p className="muted">
          The first sync reads every agent log once and keeps a copy; with a lot of history this takes a while. The page
          appears when it is done; later syncs only read what changed.
        </p>
      </div>
    </section>
  );
}

/** Logs, failed files, last sync and search health. Never throws: a failed sync is reported here, not as an error page. */
async function SyncSummary() {
  let status: SyncStatus | null = null;
  try {
    status = syncStatus(await ready());
  } catch {
    // The failure is in syncHealth(); a database that cannot even be read leaves just that.
  }
  const last = lastSync();
  const now = Date.now();
  const { syncError, searchError } = syncHealth();
  return (
    <span title={status?.errors.map((e) => `${e.path}: ${e.error}`).join("\n") || undefined}>
      {status && (
        <>
          {status.files} logs
          {status.missing > 0 && ` (${status.missing} deleted by their tool, history kept)`}
          {status.errors.length > 0 && <span className="error-text"> · {status.errors.length} failed</span>}
        </>
      )}
      {syncError ? (
        <>
          {status && " · "}
          <span className="error-text" title={`Sync failed ${ago(syncError.at)}: ${syncError.message}`}>
            sync failing
          </span>
          {last ? (
            <>
              , last synced <SyncedAgo at={last.at} now={now} />
            </>
          ) : (
            ", never synced"
          )}
        </>
      ) : (
        last && (
          <>
            {" · synced "}
            <SyncedAgo at={last.at} now={now} />
          </>
        )
      )}
      {searchError && (
        <>
          {" · "}
          <span className="error-text" title={searchError.message}>
            search {searchError.unavailable ? "unavailable" : "behind"}
          </span>
        </>
      )}
    </span>
  );
}
