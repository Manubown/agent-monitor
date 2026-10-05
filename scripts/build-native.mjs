// Builds the Rust search addon and copies it to native/agent_monitor_search.node.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crateDir = path.join(root, "native", "search");
const out = path.join(root, "native", "agent_monitor_search.node");

const build = spawnSync(
  "cargo",
  ["build", "--release", "--manifest-path", path.join(crateDir, "Cargo.toml")],
  { cwd: root, stdio: "inherit" },
);
if (build.error) {
  if (build.error.code === "ENOENT") {
    console.error("build:native: `cargo` not found. A Rust toolchain is required: install it from https://rustup.rs");
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
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(root, process.env.CARGO_TARGET_DIR)
  : path.join(crateDir, "target");
const built = path.join(targetDir, "release", lib);
if (!existsSync(built)) {
  console.error(`build:native: expected build output not found: ${built}`);
  process.exit(1);
}
copyFileSync(built, out);
console.log(`build:native: wrote ${path.relative(root, out)}`);
