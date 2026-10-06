"use client";

import "./globals.css";

/**
 * Last-resort boundary: the root layout itself threw (top bar, search, live updates), which `app/error.tsx` does not
 * cover. It replaces the whole document, so it brings its own <html>/<body> and the global styles.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body>
        <title>Agent Monitor: something went wrong</title>
        <main className="main">
          <section className="card">
            <div className="empty">
              <h2>Something went wrong</h2>
              <p>{error.message || "The dashboard could not be rendered."}</p>
              {error.digest && <p className="muted">Digest {error.digest} — the server log has the details.</p>}
              <button className="btn" type="button" onClick={() => retry()}>
                Try again
              </button>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
