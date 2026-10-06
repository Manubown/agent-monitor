// Produces native/agent_monitor_search.node, the Rust/tantivy search addon (native/search).
//
// Default: download the prebuilt addon for this platform from the GitHub release matching the
// package.json version and verify it against the release's SHA256SUMS. If that fails for any
// reason (offline, unreleased version, unsupported platform, checksum mismatch) build from source
// with cargo instead.
//
// Build from source directly when AGENT_MONITOR_BUILD_FROM_SOURCE=1 (CI, addon development) or,
// unless AGENT_MONITOR_BUILD_FROM_SOURCE=0, when a previous cargo build exists in the target dir:
// someone who has built the addon before keeps getting their own build, Rust changes included.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "Manubown/agent-monitor";
const ASSET_BASE = "agent_monitor_search";
// Platforms the release workflow (.github/workflows/release.yml) publishes; Linux builds are glibc.
const PREBUILT = new Set(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crateDir = path.join(root, "native", "search");
const out = path.join(root, "native", "agent_monitor_search.node");
// Records which release asset `out` came from, so repeated runs need no network.
const stamp = path.join(root, "native", "prebuilt.json");
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(root, process.env.CARGO_TARGET_DIR)
  : path.join(crateDir, "target");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function fromSourceReason() {
  const flag = process.env.AGENT_MONITOR_BUILD_FROM_SOURCE;
  if (flag === "1") return "AGENT_MONITOR_BUILD_FROM_SOURCE=1";
  if (flag !== "0" && existsSync(path.join(targetDir, "release"))) return `previous cargo build in ${path.relative(root, targetDir)}`;
  return null;
}

/** Downloads and verifies the release asset; returns null on success, else why it could not. */
async function downloadPrebuilt() {
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const target = `${process.platform}-${process.arch}`;
  if (!PREBUILT.has(target)) return `no prebuilt addon for ${target}`;
  if (process.platform === "linux" && !process.report?.getReport?.().header?.glibcVersionRuntime) {
    return "prebuilt Linux addons need glibc (musl detected)";
  }
  const asset = `${ASSET_BASE}-${target}.node`;

  try {
    const prev = JSON.parse(readFileSync(stamp, "utf8"));
    if (prev.version === version && prev.asset === asset && existsSync(out) && sha256(readFileSync(out)) === prev.sha256) {
      console.log(`build:native: ${path.relative(root, out)} is up to date (prebuilt v${version}, ${target})`);
      return null;
    }
  } catch {
    // no stamp or unreadable: download
  }

  const base = `https://github.com/${REPO}/releases/download/v${version}`;
  const get = async (name) => {
    const res = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`GET ${base}/${name}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  try {
    console.log(`build:native: downloading prebuilt addon ${asset} (v${version})`);
    const sums = (await get("SHA256SUMS")).toString("utf8");
    const expected = sums
      .split(/\r?\n/)
      .map((line) => line.match(/^([0-9a-f]{64})\s+\*?(\S+)$/i))
      .find((m) => m && m[2] === asset)?.[1]
      .toLowerCase();
    if (!expected) return `${asset} is not listed in SHA256SUMS of v${version}`;
    const bin = await get(asset);
    const actual = sha256(bin);
    if (actual !== expected) return `checksum mismatch for ${asset}: expected ${expected}, got ${actual}`;
    const tmp = `${out}.download`;
    writeFileSync(tmp, bin, { mode: 0o755 });
    renameSync(tmp, out);
    writeFileSync(stamp, `${JSON.stringify({ version, asset, sha256: actual }, null, 2)}\n`);
    console.log(`build:native: wrote ${path.relative(root, out)} (prebuilt v${version}, sha256 verified)`);
    return null;
  } catch (error) {
    return `download failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function buildFromSource(why) {
  console.log(`build:native: building from source with cargo (${why})`);
  const build = spawnSync(
    "cargo",
    ["build", "--release", "--manifest-path", path.join(crateDir, "Cargo.toml")],
    { cwd: root, stdio: "inherit" },
  );
  if (build.error) {
    if (build.error.code === "ENOENT") {
      console.error("build:native: `cargo` not found. A Rust toolchain is required to build the addon from source: install it from https://rustup.rs");
    } else {
      console.error(`build:native: failed to run cargo: ${build.error.message}`);
    }
    process.exit(1);
  }
  if (build.status !== 0) process.exit(build.status ?? 1);

  const lib = {
    linux: "libagent_monitor_search.so",
    darwin: "libagent_monitor_search.dylib",
    win32: "agent_monitor_search.dll",
  }[process.platform] ?? "libagent_monitor_search.so";
  const built = path.join(targetDir, "release", lib);
  if (!existsSync(built)) {
    console.error(`build:native: expected build output not found: ${built}`);
    process.exit(1);
  }
  copyFileSync(built, out);
  rmSync(stamp, { force: true });
  console.log(`build:native: wrote ${path.relative(root, out)}`);
}

const forced = fromSourceReason();
if (forced) {
  buildFromSource(forced);
} else {
  const failure = await downloadPrebuilt();
  if (failure) buildFromSource(`no prebuilt addon: ${failure}`);
}
