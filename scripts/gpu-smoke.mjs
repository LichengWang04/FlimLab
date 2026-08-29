/**
 * Boots the production renderer twice and requires the real WebGPU Worker
 * shader path to render with shared and ordinary ArrayBuffer source transport.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const packagedExe = process.env.FILMLAB_PACKAGED_EXE;
const electronPath = packagedExe ?? require("electron");
const mainPath = join(process.cwd(), "out", "main", "index.js");
const variants = [
  { transport: "shared", argument: "--gpu-smoke" },
  { transport: "array-buffer", argument: "--gpu-smoke-array-buffer" },
];

for (const variant of variants) await runVariant(variant);
console.log("gpu smoke: WebGPU Worker preview rendered successfully with shared and ArrayBuffer transport");

async function runVariant({ transport, argument }) {
  const args = packagedExe === undefined ? [mainPath, argument] : [argument];
  const child = spawn(electronPath, args, {
    cwd: packagedExe === undefined ? process.cwd() : join(packagedExe, ".."),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FILMLAB_SMOKE: "1" },
  });

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  const expected = `[gpu-smoke] webgpu transport=${transport}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (output.includes(expected)) {
      await stopChild(child);
      return;
    }
    if (child.exitCode !== null) break;
    await delay(250);
  }

  await stopChild(child);
  throw new Error(`gpu smoke (${transport}) did not complete\n${output.slice(-5000)}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, delay(2000)]);
}
