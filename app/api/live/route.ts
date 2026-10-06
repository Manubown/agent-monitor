import { lastSync, onSync, storedFiles, type SyncEvent, syncHealth, syncRunning } from "../../lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;
const PROGRESS_MS = 1000;

/**
 * Server-Sent Events: a `hello` event with the current sync state and health on connect, then one `sync` event per
 * finished sync (a failed one too: it carries `changed: 0` and the new health). Clients decide from `sessions`/`cwds`
 * whether their page is affected (`affectsPage` in app/lib/live.ts). Until the first sync of this server finishes,
 * `progress` events report the log files stored so far for the import screen.
 */
export function GET(request: Request): Response {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup(); // stream already closed
        }
      };
      const event = (name: string, data: unknown) => send(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

      const last = lastSync();
      send("retry: 3000\n\n");
      event("hello", { generation: last?.generation ?? null, at: last?.at ?? null, health: syncHealth() });

      let progress: ReturnType<typeof setInterval> | undefined;
      const stopProgress = () => {
        clearInterval(progress);
        progress = undefined;
      };
      // Only while the first sync is importing: not once one finished, and not after it failed with none running (the
      // background retry would otherwise keep this ticking forever). Any sync event, failed or not, ends it too.
      const importing = () => !lastSync() && (syncRunning() || !syncHealth().syncError);
      if (importing()) {
        const report = () => (importing() ? event("progress", { files: storedFiles() }) : stopProgress());
        report();
        progress = setInterval(report, PROGRESS_MS);
      }
      const unsubscribe = onSync((e: SyncEvent) => {
        stopProgress();
        event("sync", e);
      });
      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
      let closed = false;
      cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        stopProgress();
        clearInterval(heartbeat);
        request.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      if (request.signal.aborted) cleanup();
      else request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
