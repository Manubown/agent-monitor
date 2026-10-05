import { lastSync, onSync, type SyncEvent } from "../../lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

/**
 * Server-Sent Events: a `hello` event with the current sync state on connect,
 * then one `sync` event per completed sync. Clients refresh when `changed > 0`.
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
      event("hello", { generation: last?.generation ?? null, at: last?.at ?? null });

      const unsubscribe = onSync((e: SyncEvent) => event("sync", e));
      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
      let closed = false;
      cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
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
