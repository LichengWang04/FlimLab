import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SourceRegistry } from "../src/main/source-registry.ts";

test("source registry exposes identity but never the source path", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-source-registry-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "frame-001.NEF");
  await writeFile(sourcePath, new Uint8Array([1, 2, 3, 4]));
  const registry = new SourceRegistry(join(directory, "private-locations.json"));
  const [asset] = await registry.register([sourcePath]);

  assert.equal(asset.name, "frame-001.NEF");
  assert.equal(asset.extension, "NEF");
  assert.equal(asset.identity?.size, 4);
  assert.match(asset.identity?.fingerprint.value ?? "", /^[a-f0-9]{64}$/);
  assert.equal(registry.getPath(asset.id), sourcePath);
  assert.doesNotMatch(JSON.stringify(asset), new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});

test("source registry automatically restores a verified path from the private index", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-source-restore-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "frame-001.ARW");
  const indexPath = join(directory, "state", "source-locations.json");
  await writeFile(sourcePath, new Uint8Array([9, 8, 7, 6, 5]));
  const first = new SourceRegistry(indexPath);
  const [asset] = await first.register([sourcePath]);

  const restoredRegistry = new SourceRegistry(indexPath);
  const restored = await restoredRegistry.restore([asset]);
  assert.deepEqual(restored.relinkedAssetIds, [asset.id]);
  assert.deepEqual(restored.missingAssets, []);
  assert.equal(restoredRegistry.getPath(asset.id), sourcePath);
  const privateIndex = await readFile(indexPath, "utf8");
  assert.match(privateIndex, /frame-001\.ARW/);
});

test("directory relink uses content identity after a source is renamed", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-source-relink-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const originalDirectory = join(directory, "original");
  const restoredDirectory = join(directory, "restored", "nested");
  await mkdir(originalDirectory, { recursive: true });
  await mkdir(restoredDirectory, { recursive: true });
  const bytes = new Uint8Array([3, 1, 4, 1, 5, 9]);
  const originalPath = join(originalDirectory, "frame-001.NEF");
  const restoredPath = join(restoredDirectory, "renamed-frame.NEF");
  await writeFile(originalPath, bytes);
  await writeFile(restoredPath, bytes);

  const registry = new SourceRegistry();
  const [asset] = await registry.register([originalPath]);
  registry.forget(asset.id);
  const result = await registry.relinkDirectories([asset], [join(directory, "restored")]);

  assert.deepEqual(result.relinkedAssetIds, [asset.id]);
  assert.deepEqual(result.missingAssets, []);
  assert.equal(registry.getPath(asset.id), restoredPath);
  assert.equal(result.relinkedAssets[0]?.name, "frame-001.NEF");
});

test("legacy filename relink enriches the descriptor with a durable identity", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-source-legacy-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const firstPath = join(directory, "frame-001.NEF");
  const secondPath = join(directory, "frame-002.NEF");
  await writeFile(firstPath, new Uint8Array([1]));
  await writeFile(secondPath, new Uint8Array([2]));
  const registry = new SourceRegistry();
  const result = await registry.relink([
    { id: "frame-a", name: "frame-001.NEF", extension: "NEF" },
    { id: "frame-b", name: "frame-002.NEF", extension: "NEF" },
  ], [secondPath, firstPath]);

  assert.deepEqual(result.relinkedAssetIds, ["frame-a", "frame-b"]);
  assert.deepEqual(result.missingAssets, []);
  assert.ok(result.relinkedAssets.every((asset) => asset.identity !== undefined));
  assert.equal(registry.getPath("frame-a"), firstPath);
  assert.equal(registry.getPath("frame-b"), secondPath);
});
