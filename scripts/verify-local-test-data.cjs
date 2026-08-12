#!/usr/bin/env node

const { createHash } = require("node:crypto");
const { createReadStream, existsSync, readFileSync, statSync } = require("node:fs");
const { join, resolve } = require("node:path");

const repositoryRoot = resolve(__dirname, "..");
const manifestPath = join(repositoryRoot, "test-data", "a7rv-local-manifest.json");
const sourceDirectory = resolve(process.argv[2] ?? join(repositoryRoot, "A7R5_RAW"));
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.hashAlgorithm !== "sha256" || !Array.isArray(manifest.files)) {
    throw new Error("Unsupported A7R V local test-data manifest.");
  }

  for (const expected of manifest.files) {
    const sourcePath = join(sourceDirectory, expected.name);
    if (!existsSync(sourcePath)) throw new Error(`Missing local test source: ${expected.name}`);
    const actualSize = statSync(sourcePath).size;
    if (actualSize !== expected.size) {
      throw new Error(`${expected.name}: expected ${expected.size} bytes, found ${actualSize}`);
    }
    const actualHash = await hashFile(sourcePath);
    if (actualHash !== expected.sha256) {
      throw new Error(`${expected.name}: SHA-256 does not match the approved local fixture.`);
    }
    console.log(`Verified ${expected.name} (${actualSize} bytes).`);
  }

  console.log(`Verified ${manifest.files.length} external Sony A7R V test sources.`);
}

function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}
