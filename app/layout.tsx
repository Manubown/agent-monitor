import type { Metadata } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import { syncStatus } from "../src/store/queries";
import { syncNow } from "./actions";
import { LiveRefresh, MotionToggle, Nav, SyncButton } from "./components/client";
import { Search, TargetEvent } from "./components/search";
import { ago } from "./lib/format";
import { lastSync, ready } from "./lib/server";
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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const status = syncStatus(await ready());
  const last = lastSync();
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
            <LiveRefresh />
            <span title={status.errors.map((e) => `${e.path}: ${e.error}`).join("\n") || undefined}>
              {status.files} logs
              {status.missing > 0 && ` (${status.missing} deleted by their tool, history kept)`}
              {status.errors.length > 0 && <span className="error-text"> · {status.errors.length} failed</span>}
              {last && ` · synced ${ago(last.at)}`}
            </span>
            <MotionToggle />
            <form action={syncNow}>
              <SyncButton />
            </form>
          </div>
        </header>
        <TargetEvent />
        <main className="main">{children}</main>
      </body>
    </html>
  );
}
