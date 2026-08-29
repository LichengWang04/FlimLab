import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import sharp from "sharp";
import { DEFAULT_RECIPE, downscaleRaster, Raster, srgbToLinear } from "../src/core/index.ts";
import { writeFileAtomic } from "../src/main/atomic-write.ts";
import type { AtomicFileSystem } from "../src/main/atomic-write.ts";
import { decodeThumbnailSource } from "../src/main/decode.ts";
import { PixelWorkerCircuitBreaker, PixelWorkerFailure } from "../src/main/pixel-worker-health.ts";
import { assertProcessingMemory, estimateProcessingMemory } from "../src/main/processing-memory.ts";
import { readTiff, readTiffPreviewRaster, readTiffRaster } from "../src/main/tiff-decode.ts";
import { planTiffStrips, writeTiff16 } from "../src/main/tiff-write.ts";
import { StaleThumbnailError, ThumbnailDecodeQueue } from "../src/main/thumbnail-decode-queue.ts";
import { registerFrames } from "../src/main/roll-service.ts";
import { SessionStore } from "../src/main/session-store.ts";

let temporary: string | undefined;
after(async () => {
  if (temporary !== undefined) await fs.rm(temporary, { recursive: true, force: true });
});

describe("P1/P2 TIFF boundaries", () => {
  it("decodes little- and big-endian SHORT values and 16-bit Predictor 2", async () => {
    temporary = await fs.mkdtemp(join(tmpdir(), "filmlab-tiff-boundary-"));
    for (const littleEndian of [true, false]) {
      const fixture = minimalTiff({ littleEndian, predictor: 2, shortStrips: !littleEndian });
      const path = join(temporary, littleEndian ? "little.tiff" : "big.tiff");
      await fs.writeFile(path, fixture.file);
      const decoded = await readTiff(path);
      assert.equal(decoded.width, 3);
      assert.equal(decoded.samples, 3);
      assert.deepEqual([...(decoded.pixels as Uint16Array)], [...fixture.pixels]);
    }
  });

  it("rejects multi-page and inconsistent BitsPerSample TIFFs", async () => {
    temporary = await fs.mkdtemp(join(tmpdir(), "filmlab-tiff-invalid-"));
    const multi = join(temporary, "multi.tiff");
    await fs.writeFile(multi, minimalTiff({ nextIfd: 8 }).file);
    await assert.rejects(readTiff(multi), /暂不支持多页 TIFF/);

    const inconsistent = join(temporary, "bad-bits.tiff");
    await fs.writeFile(inconsistent, minimalTiff({ bitsCount: 1 }).file);
    await assert.rejects(readTiff(inconsistent), /BitsPerSample 与通道数不一致/);
  });

  it("writes and reads multiple Deflate strips without changing samples", async () => {
    temporary = await fs.mkdtemp(join(tmpdir(), "filmlab-tiff-strips-"));
    const width = 13;
    const height = 9;
    const pixels = new Uint16Array(width * height * 3);
    for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 997) & 0xffff;
    const path = join(temporary, "many-strips.tiff");
    const serialPath = join(temporary, "many-strips-serial.tiff");
    await Promise.all([
      writeTiff16(path, width, height, pixels, { targetStripBytes: width * 6 * 2, compressionConcurrency: 4 }),
      writeTiff16(serialPath, width, height, pixels, { targetStripBytes: width * 6 * 2, compressionConcurrency: 1 }),
    ]);
    assert.equal(planTiffStrips(width, height, width * 6 * 2).stripCount, 5);
    assert.deepEqual([...((await readTiff(path)).pixels as Uint16Array)], [...pixels]);
    assert.deepEqual(await fs.readFile(path), await fs.readFile(serialPath));
  });

  it("plans 45-100 MP output without allocating the raster", () => {
    for (const [width, height] of [[9_000, 5_000], [10_000, 10_000]] as const) {
      const plan = planTiffStrips(width, height);
      assert.ok(plan.rowsPerStrip * width * 6 <= 16 * 1024 * 1024 || plan.rowsPerStrip === 1);
      assert.equal(plan.stripCount, Math.ceil(height / plan.rowsPerStrip));
    }
  });

  it("uses a SharedArrayBuffer target for exact full TIFF decode", async () => {
    temporary = await fs.mkdtemp(join(tmpdir(), "filmlab-tiff-sab-"));
    const path = join(temporary, "shared.tiff");
    const fixture = minimalTiff({ littleEndian: false });
    await fs.writeFile(path, fixture.file);
    let shared: SharedArrayBuffer | undefined;
    const decoded = await readTiffRaster(path, (length) => {
      shared = new SharedArrayBuffer(length * Float32Array.BYTES_PER_ELEMENT);
      return new Float32Array(shared);
    });
    assert.equal(decoded.data.buffer, shared);
    assert.ok(Math.abs(decoded.data[3]! - fixture.pixels[3]! / 65535) < 1e-7);
  });

  it("streams a multi-strip TIFF preview byte-for-byte like the full area-average path", async () => {
    temporary = await fs.mkdtemp(join(tmpdir(), "filmlab-tiff-preview-"));
    const width = 37;
    const height = 29;
    const pixels = new Uint16Array(width * height * 3);
    for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 811 + 97) & 0xffff;
    const path = join(temporary, "multi-strip-preview.tiff");
    await writeTiff16(path, width, height, pixels, { targetStripBytes: width * 6 * 3 });
    const full = await readTiffRaster(path);
    const expected = downscaleRaster(new Raster(width, height, "transmission-linear", full.data), 11);
    const streamed = await readTiffPreviewRaster(path, 11);
    assert.equal(streamed.width, expected.width);
    assert.equal(streamed.height, expected.height);
    assert.deepEqual(streamed.data, expected.data);
  });

  it("keeps the TIFF thumbnail transfer rules and Chinese paths", async () => {
    temporary = await fs.mkdtemp(join(tmpdir(), "filmlab-thumb-"));
    const path = join(temporary, "中文 16位.tiff");
    const pixels = new Uint16Array(20 * 10 * 3).fill(32_768);
    await writeTiff16(path, 20, 10, pixels);
    const thumbnail = await decodeThumbnailSource(path, 8);
    assert.equal(thumbnail.raster.width, 8);
    assert.equal(thumbnail.raster.height, 4);
    assert.ok(
      Math.abs(thumbnail.raster.data[0]! - 32_768 / 65_535) < 2e-3,
      `expected linear 16-bit midpoint, received ${thumbnail.raster.data[0]}`,
    );

    const eightBitPath = join(temporary, "中文 8位.tiff");
    await sharp(Buffer.alloc(20 * 10 * 3, 128), { raw: { width: 20, height: 10, channels: 3 } })
      .tiff({ compression: "deflate" })
      .toFile(eightBitPath);
    const eightBit = await decodeThumbnailSource(eightBitPath, 8);
    assert.ok(Math.abs(eightBit.raster.data[0]! - srgbToLinear(128 / 255)) < 2e-3);

    const iccPath = join(temporary, "icc.tiff");
    await fs.writeFile(iccPath, minimalTiff({ icc: true }).file);
    await assert.rejects(decodeThumbnailSource(iccPath), /ICC/);
  });
});

describe("P1/P2 resource and publication boundaries", () => {
  it("limits 500 thumbnail tasks to two and discards an old generation", async () => {
    const queue = new ThumbnailDecodeQueue(2);
    let generation = 1;
    let active = 0;
    let maximum = 0;
    const tasks = Array.from({ length: 500 }, (_, index) => queue.submit(
      `old-${index}`,
      () => generation === 1,
      async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return index;
      },
    ));
    generation = 2;
    const settled = await Promise.allSettled(tasks);
    assert.ok(maximum <= 2);
    assert.ok(settled.every((result) => result.status === "rejected" && result.reason instanceof StaleThumbnailError));
    assert.equal(await queue.submit("new", () => generation === 2, async () => 42), 42);
  });

  it("retries atomic publication and never removes the old target", async () => {
    let renameAttempts = 0;
    const removed: string[] = [];
    const fake: AtomicFileSystem = {
      writeFile: async () => undefined,
      rename: async () => {
        renameAttempts += 1;
        throw Object.assign(new Error("locked"), { code: "EPERM" });
      },
      rm: async (path) => { removed.push(path); },
    };
    const target = join("C:\\safe", "existing.tiff");
    await assert.rejects(
      writeFileAtomic(target, new Uint8Array([1]), { fileSystem: fake, retryDelaysMs: [0, 0], wait: async () => undefined }),
      /目标文件正在使用或无法安全替换/,
    );
    assert.equal(renameAttempts, 3);
    assert.equal(removed.length, 1);
    assert.notEqual(removed[0], target);
    assert.match(removed[0]!, /\.part$/);
  });

  it("publishes after a transient locked-target retry", async () => {
    let attempts = 0;
    let publishedTo = "";
    const fake: AtomicFileSystem = {
      writeFile: async () => undefined,
      rename: async (_temporary, target) => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
        publishedTo = target;
      },
      rm: async () => assert.fail("a published temporary file must not be cleaned up"),
    };
    const target = join("C:\\safe", "retry.tiff");
    await writeFileAtomic(target, new Uint8Array([1]), {
      fileSystem: fake,
      retryDelaysMs: [0, 0],
      wait: async () => undefined,
    });
    assert.equal(attempts, 3);
    assert.equal(publishedTo, target);
  });

  it("serializes concurrent session saves so the newest state wins", async () => {
    temporary = await fs.mkdtemp(join(tmpdir(), "filmlab-session-order-"));
    const source = join(temporary, "source.tiff");
    await fs.writeFile(source, "fixture");
    const [frame] = registerFrames([source]);
    const sessionPath = join(temporary, "session.json");
    const store = new SessionStore(() => sessionPath);
    const first = store.save({ frames: [{ id: frame!.id, recipe: DEFAULT_RECIPE, skipped: false }], activeId: frame!.id });
    const secondRecipe = { ...DEFAULT_RECIPE, exposure: 1.25 };
    const second = store.save({ frames: [{ id: frame!.id, recipe: secondRecipe, skipped: false }], activeId: frame!.id });
    await Promise.all([first, second]);
    const saved = JSON.parse(await fs.readFile(sessionPath, "utf8")) as { frames: { recipe: { exposure: number } }[] };
    assert.equal(saved.frames[0]!.recipe.exposure, 1.25);
  });

  it("accepts safe 100 MP plans and rejects insufficient memory before work", () => {
    const input = {
      sourceWidth: 10_000,
      sourceHeight: 10_000,
      targetWidth: 10_000,
      targetHeight: 10_000,
      sourceDepth: 16 as const,
      sourceFormat: "tiff",
      format: "tiff" as const,
      identityGeometry: true,
    };
    const estimate = estimateProcessingMemory(input);
    assert.ok(estimate.requiredFreeBytes > 512 * 1024 * 1024);
    const rawEstimate = estimateProcessingMemory({ ...input, sourceFormat: "arw" });
    assert.ok(rawEstimate.peakBytes > estimate.peakBytes, "RAW must budget the WASM heap and decode buffers");
    assert.doesNotThrow(() => assertProcessingMemory(input, { total: 8 * 1024 ** 3, free: 4 * 1024 ** 3 }));
    assert.throws(() => assertProcessingMemory(input, { total: 2 * 1024 ** 3, free: 900 * 1024 ** 2 }), /资源不足/);
  });

  it("trips only after two consecutive Pixel Worker failures and resets on success", () => {
    const breaker = new PixelWorkerCircuitBreaker();
    assert.ok(new PixelWorkerFailure("crash") instanceof PixelWorkerFailure);
    breaker.recordFailure();
    assert.equal(breaker.canCreatePool, true);
    breaker.recordSuccess();
    assert.equal(breaker.failureCount, 0);
    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.canCreatePool, false);
  });
});

function minimalTiff(options: {
  littleEndian?: boolean;
  predictor?: 1 | 2;
  nextIfd?: number;
  bitsCount?: 1 | 3;
  shortStrips?: boolean;
  icc?: boolean;
} = {}): { file: Buffer; pixels: Uint16Array } {
  const little = options.littleEndian ?? true;
  const predictor = options.predictor ?? 1;
  const bitsCount = options.bitsCount ?? 3;
  const width = 3;
  const height = 2;
  const samples = 3;
  const entries = 10 + (predictor === 2 ? 1 : 0) + (options.icc ? 1 : 0);
  const dataStart = 8 + 2 + entries * 12 + 4;
  const bitsOffset = dataStart;
  const pixelOffset = bitsOffset + (bitsCount === 3 ? 6 : 0);
  const pixels = new Uint16Array(width * height * samples);
  for (let index = 0; index < pixels.length; index += 1) pixels[index] = 1000 + index * 113;
  const file = Buffer.alloc(pixelOffset + pixels.byteLength);
  const w16 = (value: number, offset: number) => little ? file.writeUInt16LE(value, offset) : file.writeUInt16BE(value, offset);
  const w32 = (value: number, offset: number) => little ? file.writeUInt32LE(value, offset) : file.writeUInt32BE(value, offset);
  file.write(little ? "II" : "MM", 0, "ascii");
  w16(42, 2);
  w32(8, 4);
  let cursor = 8;
  w16(entries, cursor);
  cursor += 2;
  const entry = (tag: number, type: 3 | 4, count: number, value: number): void => {
    w16(tag, cursor);
    w16(type, cursor + 2);
    w32(count, cursor + 4);
    if (type === 3 && count === 1) {
      w16(value, cursor + 8);
      w16(0, cursor + 10);
    } else w32(value, cursor + 8);
    cursor += 12;
  };
  entry(256, 3, 1, width);
  entry(257, 3, 1, height);
  entry(258, 3, bitsCount, bitsCount === 3 ? bitsOffset : 16);
  entry(259, 3, 1, 1);
  entry(262, 3, 1, 2);
  entry(273, options.shortStrips ? 3 : 4, 1, pixelOffset);
  entry(277, 3, 1, samples);
  entry(278, 4, 1, height);
  entry(279, options.shortStrips ? 3 : 4, 1, pixels.byteLength);
  entry(284, 3, 1, 1);
  if (predictor === 2) entry(317, 3, 1, 2);
  if (options.icc) entry(34675, 4, 1, 0);
  w32(options.nextIfd ?? 0, cursor);
  if (bitsCount === 3) for (let index = 0; index < 3; index += 1) w16(16, bitsOffset + index * 2);
  const encoded = [...pixels];
  if (predictor === 2) {
    const samplesPerRow = width * samples;
    for (let row = 0; row < height; row += 1) {
      for (let index = samplesPerRow - 1; index >= samples; index -= 1) {
        const at = row * samplesPerRow + index;
        encoded[at] = (encoded[at]! - encoded[at - samples]!) & 0xffff;
      }
    }
  }
  for (let index = 0; index < encoded.length; index += 1) w16(encoded[index]!, pixelOffset + index * 2);
  return { file, pixels };
}
