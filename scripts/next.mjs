// The Next.js CLI with its anonymous telemetry (https://nextjs.org/telemetry) switched off, so Agent Monitor makes no
// network calls besides the optional addon download. The package.json scripts run `next` through this file: the
// variable has to be set before the CLI starts, because `next dev` records telemetry in its parent process, which
// loads neither .env nor next.config.ts.
import { createRequire } from "node:module";

process.env.NEXT_TELEMETRY_DISABLED = "1";
createRequire(import.meta.url)("next/dist/bin/next");
