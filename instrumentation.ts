/** Next.js calls this once per server start: keep the database in sync in the background. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startBackgroundSync } = await import("./app/lib/server");
  startBackgroundSync();
}
