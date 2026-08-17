import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const root = await fs.mkdtemp(join(tmpdir(), "filmlab-export-smoke-"));
const mainPath = join(process.cwd(), "out", "main", "index.js");

try {
  const child = spawn(electronPath, [mainPath, `--release-export-smoke=${root}`], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exitCode = await Promise.race([
    new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1))),
    new Promise((resolve) => setTimeout(() => {
      child.kill();
      resolve(124);
    }, 60_000)),
  ]);
  if (exitCode !== 0 || !output.includes("[release-smoke] exports-complete")) {
    throw new Error(`export smoke failed (${exitCode})\n${output.slice(-4000)}`);
  }
  const files = await listFiles(root);
  const outputs = files.filter((path) => /positive.*\.(tiff|jpg)$/i.test(path));
  if (outputs.length !== 6) throw new Error(`expected 6 positive exports, found ${outputs.length}`);
  console.log("export smoke: single/roll TIFF/JPEG completed through packaged Workers");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

async function listFiles(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path));
    else result.push(path);
  }
  return result;
}
