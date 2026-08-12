#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const { statSync } = require("node:fs");
const { basename, extname, resolve } = require("node:path");

const maximumTrackedBytes = 20 * 1024 * 1024;
const forbiddenExtensions = new Set([
  ".arw", ".cr2", ".cr3", ".dng", ".iiq", ".nef", ".orf", ".pef", ".raf", ".rw2", ".srw",
  ".tif", ".tiff", ".exe", ".dll", ".dmg", ".appimage", ".node",
]);
const forbiddenDirectoryPrefixes = [
  "A7R5_RAW/",
  "node_modules/",
  "out/",
  "release/",
  "native/raw-worker/build/",
  "native/raw-worker/out/",
  "native/raw-worker/vcpkg_installed/",
];
const forbiddenBasenames = new Set(["{console.error(e", ".DS_Store"]);
const mode = process.argv.includes("--staged") ? "staged" : "tracked";
const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const gitArguments = mode === "staged"
  ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
  : ["ls-files", "-z"];
const files = execFileSync("git", gitArguments, { cwd: repositoryRoot })
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .map((path) => path.replaceAll("\\", "/"));
const violations = [];

for (const path of files) {
  const lowerPath = path.toLowerCase();
  const lowerExtension = extname(lowerPath);
  if (forbiddenDirectoryPrefixes.some((prefix) => lowerPath.startsWith(prefix.toLowerCase()))) {
    violations.push(`${path}: build output, dependency, or private test-data directory`);
    continue;
  }
  if (forbiddenExtensions.has(lowerExtension)) {
    violations.push(`${path}: source/master image or compiled binary extension ${lowerExtension}`);
    continue;
  }
  if (forbiddenBasenames.has(basename(path))) {
    violations.push(`${path}: temporary or accidental file name`);
    continue;
  }
  const absolutePath = resolve(repositoryRoot, path);
  let size;
  try {
    size = statSync(absolutePath).size;
  } catch {
    // Renamed/deleted worktree files may still appear in an unusual staged
    // state. Git itself will validate that state; this check concerns content.
    continue;
  }
  if (size > maximumTrackedBytes) {
    violations.push(`${path}: ${size} bytes exceeds the 20 MiB repository limit`);
  }
}

if (violations.length > 0) {
  console.error(`Repository hygiene check failed for ${mode} files:`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Repository hygiene check passed (${files.length} ${mode} files).`);
