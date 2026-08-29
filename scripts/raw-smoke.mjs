/** Runs metadata, preview decode and full JPEG export for a real camera RAW. */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";

const fixture = process.env.FILMLAB_RAW_FIXTURE;
if (fixture === undefined || fixture.length === 0) {
  throw new Error("Set FILMLAB_RAW_FIXTURE to a CR2, NEF, RW2 or ARW sample.");
}
await access(fixture);

const require = createRequire(import.meta.url);
const packagedExe = process.env.FILMLAB_PACKAGED_EXE;
const executable = packagedExe ?? require("electron");
const args = packagedExe === undefined
  ? [join(process.cwd(), "out", "main", "index.js"), `--raw-import-smoke=${fixture}`]
  : [`--raw-import-smoke=${fixture}`];
const child = spawn(executable, args, {
  cwd: packagedExe === undefined ? process.cwd() : join(packagedExe, ".."),
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
const exitCode = await new Promise((resolve) => {
  const timeout = setTimeout(() => {
    child.kill();
    resolve(124);
  }, 90_000);
  child.once("exit", (code) => {
    clearTimeout(timeout);
    resolve(code ?? 1);
  });
});
if (exitCode !== 0 || !output.includes("[raw-smoke] complete")) {
  throw new Error(`RAW smoke failed (${exitCode})\n${output.slice(-5000)}`);
}
console.log(output.match(/\[raw-smoke\] complete[^\r\n]*/)?.[0] ?? "RAW smoke complete");
