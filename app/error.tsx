"use client";

/**
 * Root error boundary: a page below the layout threw while rendering. Errors
 * from server components reach the client sanitized, with a digest that matches
 * the line in the server log.
 */
export default function RootError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <section className="card">
      <div className="empty">
        <h2>Something went wrong</h2>
        <p>{error.message || "This page could not be rendered."}</p>
        {error.digest && <p className="muted">Digest {error.digest} — the server log has the details.</p>}
        <button className="btn" type="button" onClick={() => retry()}>
          Try again
        </button>
      </div>
    </section>
  );
}
