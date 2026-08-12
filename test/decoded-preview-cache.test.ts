import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Raster } from "../src/core/raster.ts";
import {
  createDecodedPreviewCacheEntry,
  readDecodedBayerCache,
  readDecodedPreviewCache,
  writeDecodedBayerCacheMetadata,
  writeDecodedPreviewCache,
  writeDecodedPreviewCacheMetadata,
} from "../src/main/decoded-preview-cache.ts";

test("decoded preview cache round-trips linear pixels and invalidates source changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-preview-cache-test-"));
  const sourcePath = join(directory, "frame.tif");
  const cacheDirectory = join(directory, "cache");
  try {
    await writeFile(sourcePath, new Uint8Array([1, 2, 3]));
    const entry = await createDecodedPreviewCacheEntry(
      cacheDirectory,
      sourcePath,
      1_280,
      "test-decoder-v1",
    );
    assert.equal(await readDecodedPreviewCache(entry), undefined);

    const raster = new Raster(4, 3, "transmission-linear-rgb");
    for (let index = 0; index < raster.data.length; index += 1) {
      raster.data[index] = (index + 1) / (raster.data.length + 1);
    }
    await writeDecodedPreviewCache(cacheDirectory, entry, {
      source: raster,
      summary: {
        width: raster.width,
        height: raster.height,
        bitDepth: 16,
        sourceDomain: "transmission-linear-rgb",
        decoder: "sharp-raster",
        warnings: ["test"],
      },
    });

    const cached = await readDecodedPreviewCache(entry);
    assert.ok(cached !== undefined);
    assert.equal(cached.source.width, raster.width);
    assert.equal(cached.source.height, raster.height);
    assert.equal(cached.summary.decoder, "sharp-raster");
    assert.ok(Math.abs(cached.source.data[7] - raster.data[7]) <= 1 / 65_535);

    await writeFile(sourcePath, new Uint8Array([1, 2, 3, 4]));
    const changedSourceEntry = await createDecodedPreviewCacheEntry(
      cacheDirectory,
      sourcePath,
      1_280,
      "test-decoder-v1",
    );
    const changedEdgeEntry = await createDecodedPreviewCacheEntry(
      cacheDirectory,
      sourcePath,
      960,
      "test-decoder-v1",
    );
    assert.notEqual(changedSourceEntry.key, entry.key);
    assert.notEqual(changedEdgeEntry.key, changedSourceEntry.key);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("decoded preview cache round-trips compact Bayer16 pixels and CFA metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-bayer-cache-test-"));
  const sourcePath = join(directory, "frame.arw");
  const cacheDirectory = join(directory, "cache");
  try {
    await writeFile(sourcePath, new Uint8Array([4, 5, 6]));
    const entry = await createDecodedPreviewCacheEntry(
      cacheDirectory,
      sourcePath,
      2_048,
      "test-libraw-gpu-bayer-v1",
    );
    const data = new Uint16Array([101, 202, 303, 404, 505, 606]);
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(entry.pixelsPath, new Uint8Array(data.buffer));
    await writeDecodedBayerCacheMetadata(cacheDirectory, entry, {
      width: 3,
      height: 2,
      data,
      pattern: [0, 1, 1, 2],
      summary: {
        width: 3,
        height: 2,
        bitDepth: 16,
        sourceDomain: "camera-linear-bayer",
        decoder: "libraw-sidecar",
        decoderFingerprint: "test-libraw-gpu-bayer-v1",
        camera: { make: "Sony", model: "ILCE-7RM5" },
        photonTransfer: {
          profileId: "photons-to-photos:sony-ilce-7rm5:iso100:2026-06-24",
          cameraModel: "Sony ILCE-7RM5",
          iso: 100,
          bitDepth: 14,
          readNoiseDn: 1.368,
          electronsPerDn: 2.759,
          prnu: 0.0038,
          normalizationRangeDn: [15_871, 15_871, 15_871],
        },
        warnings: ["gpu-bayer"],
      },
    });

    const cached = await readDecodedBayerCache(entry);
    assert.ok(cached !== undefined);
    assert.deepEqual(cached.pattern, [0, 1, 1, 2]);
    assert.deepEqual(cached.data, data);
    assert.equal(cached.summary.sourceDomain, "camera-linear-bayer");
    assert.deepEqual(cached.summary.camera, { make: "Sony", model: "ILCE-7RM5" });
    assert.equal(cached.summary.photonTransfer?.iso, 100);
    assert.deepEqual(cached.summary.photonTransfer?.normalizationRangeDn, [15_871, 15_871, 15_871]);
    assert.equal(await readDecodedPreviewCache(entry), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("decoded preview cache can publish sidecar-written RGB16 pixels without rewriting them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-sidecar-cache-test-"));
  const sourcePath = join(directory, "frame.arw");
  const cacheDirectory = join(directory, "cache");
  try {
    await writeFile(sourcePath, new Uint8Array([7, 8, 9]));
    const entry = await createDecodedPreviewCacheEntry(
      cacheDirectory,
      sourcePath,
      1_280,
      "test-libraw-v1",
    );
    const raster = new Raster(2, 2, "camera-linear-rgb");
    raster.data.fill(0.5);
    const encoded = new Uint16Array(raster.data.length);
    encoded.fill(32_768);
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(entry.pixelsPath, new Uint8Array(encoded.buffer));
    await writeDecodedPreviewCacheMetadata(cacheDirectory, entry, {
      source: raster,
      summary: {
        width: 2,
        height: 2,
        bitDepth: 16,
        sourceDomain: "camera-linear-rgb",
        decoder: "libraw-sidecar",
        decoderFingerprint: "test-libraw-v1",
        camera: { make: "Nikon", model: "Z 8" },
        warnings: [],
      },
    });

    const cached = await readDecodedPreviewCache(entry);
    assert.ok(cached !== undefined);
    assert.equal(cached.summary.decoderFingerprint, "test-libraw-v1");
    assert.deepEqual(cached.summary.camera, { make: "Nikon", model: "Z 8" });
    assert.ok(Math.abs(cached.source.data[0] - 32_768 / 65_535) < 1e-7);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
