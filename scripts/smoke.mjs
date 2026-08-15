/**
 * Headless smoke test for the packaged app: boots the built main process with
 * a hidden window, waits for the renderer to mount, then exits 0/1.
 * Run with: npm run build && node scripts/smoke.mjs
 * On Linux without a display server prefix with xvfb-run.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// The electron npm package exports the path to its executable.
const electronPath = require("electron");
const mainPath = join(process.cwd(), "out", "main", "index.js");

const child = spawn(electronPath, [mainPath, "--smoke"], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, FILMLAB_SMOKE: "1" },
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});

const deadline = Date.now() + 30_000;
let mounted = false;
while (Date.now() < deadline) {
  if (output.includes("[smoke] renderer-mounted")) {
    mounted = true;
    break;
  }
  if (child.exitCode !== null) break;
  await delay(250);
}

if (mounted) {
  console.log("smoke: renderer mounted, app healthy");
  child.kill();
  process.exit(0);
} else {
  console.error("smoke: renderer did not mount in time");
  console.error(output.slice(-4000));
  child.kill();
  process.exit(1);
}
