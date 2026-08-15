import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SourceRegistry } from "../src/main/source-registry.ts";

test("source registry assigns opaque ids and resolves them back to paths", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "filmlab-source-register-"));
  context.after(async () => rm(root, { recursive: true, force: true }));

  const content = Buffer.from("frame-alpha-content-01");
  const filePath = join(root, "frame-a.dng");
  await writeFile(filePath, content);

  const registry = new SourceRegistry(join(root, "locations.json"));
  const assets = await registry.register([filePath]);
  assert.equal(assets.length, 1);
  const asset = assets[0];
  assert.equal(asset.name, "frame-a.dng");
  assert.equal(asset.extension, "DNG");
  assert.equal(asset.identity?.size, content.byteLength);
  assert.equal(
    asset.identity?.fingerprint.value,
    createHash("sha256").update(content).digest("hex"),
  );
  assert.equal(asset.identity?.fingerprint.algorithm, "sha256-full-v1");

  assert.equal(registry.has(asset.id), true);
  assert.equal(registry.getPath(asset.id), filePath);
  registry.forget(asset.id);
  assert.equal(registry.has(asset.id), false);
  assert.equal(registry.getPath(asset.id), undefined);
});

test("source registry restores paths from the machine-private location index after restart", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "filmlab-source-restore-"));
  context.after(async () => rm(root, { recursive: true, force: true }));

  const filePath = join(root, "frame-b.dng");
  await writeFile(filePath, Buffer.from("frame-bravo-content-02"));
  const indexPath = join(root, "locations.json");

  const first = new SourceRegistry(indexPath);
  const [asset] = await first.register([filePath]);

  const restarted = new SourceRegistry(indexPath);
  assert.equal(restarted.getPath(asset.id), undefined);
  const result = await restarted.restore([asset]);
  assert.deepEqual(result.relinkedAssetIds, [asset.id]);
  assert.deepEqual(result.missingAssets, []);
  assert.equal(restarted.getPath(asset.id), filePath);
});

test("source registry re-hashes content when only the modification time changed", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "filmlab-source-rehash-"));
  context.after(async () => rm(root, { recursive: true, force: true }));

  const filePath = join(root, "frame-c.dng");
  await writeFile(filePath, Buffer.from("frame-charlie-content"));
  const indexPath = join(root, "locations.json");

  const first = new SourceRegistry(indexPath);
  const [asset] = await first.register([filePath]);

  // Same bytes, new mtime: the size+mtime fast path must fall through to a
  // fresh SHA-256 comparison, which still matches and relinks the asset.
  const touched = new Date("2026-01-05T08:30:00.000Z");
  await utimes(filePath, touched, touched);

  const restarted = new SourceRegistry(indexPath);
  const result = await restarted.restore([asset]);
  assert.deepEqual(result.relinkedAssetIds, [asset.id]);
  assert.deepEqual(result.missingAssets, []);
  assert.equal(restarted.getPath(asset.id), filePath);
});

test("source registry rejects a tampered file whose bytes changed at the same size", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "filmlab-source-tamper-"));
  context.after(async () => rm(root, { recursive: true, force: true }));

  const filePath = join(root, "frame-d.dng");
  await writeFile(filePath, Buffer.from("alpha-frame-bytes-01"));
  const indexPath = join(root, "locations.json");

  const first = new SourceRegistry(indexPath);
  const [asset] = await first.register([filePath]);

  // Identical length, different bytes: size checks pass but the content
  // fingerprint no longer does, so neither restore nor relink may claim it.
  await writeFile(filePath, Buffer.from("omega-frame-bytes-01"));

  const restarted = new SourceRegistry(indexPath);
  const restored = await restarted.restore([asset]);
  assert.deepEqual(restored.relinkedAssetIds, []);
  assert.deepEqual(restored.missingAssets.map((missing) => missing.id), [asset.id]);

  const relinked = await restarted.relink([asset], [filePath]);
  assert.deepEqual(relinked.relinkedAssetIds, []);
  assert.deepEqual(relinked.missingAssets.map((missing) => missing.id), [asset.id]);
  assert.equal(restarted.getPath(asset.id), undefined);
});

test("source registry reconnects a renamed and moved file by content fingerprint", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "filmlab-source-relink-"));
  context.after(async () => rm(root, { recursive: true, force: true }));

  const originalPath = join(root, "frame-e.dng");
  await writeFile(originalPath, Buffer.from("frame-echo-content-05"));
  const registry = new SourceRegistry(join(root, "locations.json"));
  const [asset] = await registry.register([originalPath]);

  const archive = join(root, "archive");
  await mkdir(archive, { recursive: true });
  const movedPath = join(archive, "renamed-e.dng");
  await rename(originalPath, movedPath);

  const result = await registry.relinkDirectories([asset], [root]);
  assert.deepEqual(result.relinkedAssetIds, [asset.id]);
  assert.deepEqual(result.missingAssets, []);
  assert.equal(registry.getPath(asset.id), movedPath);
});

test("source registry matches a legacy asset by filename once and enriches it with an identity", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "filmlab-source-legacy-"));
  context.after(async () => rm(root, { recursive: true, force: true }));

  const filePath = join(root, "frame-f.dng");
  const content = Buffer.from("frame-foxtrot-content");
  await writeFile(filePath, content);
  const registry = new SourceRegistry(join(root, "locations.json"));

  const legacyAsset = { id: "legacy-frame", name: "frame-f.dng", extension: "DNG" };
  const result = await registry.relink([legacyAsset], [filePath]);
  assert.deepEqual(result.relinkedAssetIds, ["legacy-frame"]);
  assert.deepEqual(result.missingAssets, []);
  const enriched = result.relinkedAssets[0];
  assert.equal(enriched.identity?.size, content.byteLength);
  assert.equal(
    enriched.identity?.fingerprint.value,
    createHash("sha256").update(content).digest("hex"),
  );
  assert.equal(registry.getPath("legacy-frame"), filePath);

  // A name that no candidate carries stays missing instead of guessing.
  const absent = await registry.relink(
    [{ id: "legacy-missing", name: "absent.dng", extension: "DNG" }],
    [filePath],
  );
  assert.deepEqual(absent.relinkedAssetIds, []);
  assert.deepEqual(absent.missingAssets.map((missing) => missing.id), ["legacy-missing"]);
});
