import { type NextRequest, NextResponse } from "next/server";

/**
 * Binding to 127.0.0.1 does not stop DNS rebinding: a web page can point its
 * own hostname at 127.0.0.1 and read every response from this server
 * (transcripts included). Such requests carry the attacker's hostname in
 * Host, so anything not addressed to a loopback name is refused.
 */
const LOOPBACK: Record<string, true> = { "127.0.0.1": true, localhost: true, "[::1]": true };

export function proxy(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  if (LOOPBACK[hostname] !== true) return new NextResponse("Forbidden: unexpected Host header", { status: 403 });
  return NextResponse.next();
}
