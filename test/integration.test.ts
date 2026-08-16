import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import sharp from "sharp";
import {
  DEFAULT_RECIPE,
  processNegative,
  Raster,
  srgbOetf,
  srgbToLinear,
} from "../src/core/index.ts";
import { decodeSource } from "../src/main/decode.ts";
import { renderPositive } from "../src/main/export.ts";
import { readTiff } from "../src/main/tiff-decode.ts";
import { writeTiff16 } from "../src/main/tiff-write.ts";

const WIDTH = 64;
const HEIGHT = 32;
const BORDER = 6; // left border columns of unexposed base
const BASE = [0.8, 0.5, 0.3] as const;

let tempDir: string;
after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

/** Scene value at column x: 0 in the border, then a ramp to 1. */
function sceneAt(x: number): number {
  return x < BORDER ? 0 : (x - BORDER) / (WIDTH - BORDER);
}

function transmissionAt(x: number, channel: number): number {
  return BASE[channel]! / (1 + 9 * sceneAt(x));
}

/** Writes a 16-bit linear TIFF (no ICC) of the synthetic masked negative. */
async function writeNegativeTiff(path: string): Promise<void> {
  const raw = new Uint16Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 3;
      raw[offset] = Math.round(transmissionAt(x, 0) * 65535);
      raw[offset + 1] = Math.round(transmissionAt(x, 1) * 65535);
      raw[offset + 2] = Math.round(transmissionAt(x, 2) * 65535);
    }
  }
  await writeTiff16(path, WIDTH, HEIGHT, raw);
}

/** Writes an 8-bit sRGB-encoded JPEG of the same negative (display-referred). */
async function writeNegativeJpeg(path: string): Promise<void> {
  const raw = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 3;
      raw[offset] = Math.round(srgbOetf(transmissionAt(x, 0)) * 255);
      raw[offset + 1] = Math.round(srgbOetf(transmissionAt(x, 1)) * 255);
      raw[offset + 2] = Math.round(srgbOetf(transmissionAt(x, 2)) * 255);
    }
  }
  await sharp(Buffer.from(raw.buffer), { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
    .jpeg({ quality: 100 })
    .toFile(path);
}

function approx(actual: number | undefined, expected: number, tolerance: number, message = ""): void {
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

describe("File decoding", () => {
  it("reads a 16-bit profile-less TIFF as linear transmission", async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "filmlab-"));
    const tiff = join(tempDir, "negative.tiff");
    await writeNegativeTiff(tiff);

    const { raster, meta } = await decodeSource(tiff);
    assert.equal(raster.width, WIDTH);
    assert.equal(raster.height, HEIGHT);
    assert.equal(meta.depth, 16);
    assert.equal(meta.hasIcc, false);
    assert.equal(meta.format, "tiff");

    for (const x of [0, 3, 20, 63]) {
      const offset = Raster.offsetOf(x, 10, WIDTH);
      approx(raster.data[offset]!, transmissionAt(x, 0), 2e-5, `red at x=${x}`);
      approx(raster.data[offset + 1]!, transmissionAt(x, 1), 2e-5, `green at x=${x}`);
      approx(raster.data[offset + 2]!, transmissionAt(x, 2), 2e-5, `blue at x=${x}`);
    }
  });

  it("linearizes an untagged 8-bit JPEG through the sRGB inverse OETF", async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "filmlab-"));
    const jpeg = join(tempDir, "negative.jpg");
    await writeNegativeJpeg(jpeg);

    const { raster, meta } = await decodeSource(jpeg);
    assert.equal(meta.depth, 8);
    assert.equal(meta.format, "jpeg");
    for (const x of [0, 20, 63]) {
      const offset = Raster.offsetOf(x, 10, WIDTH);
      approx(raster.data[offset]!, transmissionAt(x, 0), 0.03, `red at x=${x}`);
      approx(raster.data[offset + 1]!, transmissionAt(x, 1), 0.03, `green at x=${x}`);
      approx(raster.data[offset + 2]!, transmissionAt(x, 2), 0.03, `blue at x=${x}`);
    }
  });

  it("downscales for preview when a max side is requested", async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "filmlab-"));
    const tiff = join(tempDir, "negative.tiff");
    await writeNegativeTiff(tiff);

    const { raster } = await decodeSource(tiff, 16);
    assert.equal(raster.width, 16);
    assert.equal(raster.height, 8);
  });
});

describe("TIFF decoder", () => {
  function buildMinimalTiff(
    options: {
      width?: number;
      height?: number;
      depth?: 8 | 16;
      samples?: 1 | 3;
      compression?: number;
      extraTags?: [number, number, number, number][];
    } = {},
  ): { file: Buffer; pixels: Uint8Array | Uint16Array } {
    const width = options.width ?? 4;
    const height = options.height ?? 2;
    const depth = options.depth ?? 16;
    const samples = options.samples ?? 3;
    const compression = options.compression ?? 1;
    const pixelBytes = width * height * samples * (depth / 8);
    const entryCount = 10 + (options.extraTags?.length ?? 0);
    const dataStart = 8 + 2 + entryCount * 12 + 4;
    const bpsOffset = dataStart;
    const pixelOffset = bpsOffset + (samples === 3 ? 6 : 0);
    const file = Buffer.alloc(pixelOffset + pixelBytes);

    file.write("II", 0, "ascii");
    file.writeUInt16LE(42, 2);
    file.writeUInt32LE(8, 4);
    let cursor = 8;
    file.writeUInt16LE(entryCount, cursor);
    cursor += 2;
    const entry = (tag: number, type: number, count: number, value: number): void => {
      file.writeUInt16LE(tag, cursor);
      file.writeUInt16LE(type, cursor + 2);
      file.writeUInt32LE(count, cursor + 4);
      file.writeUInt32LE(value, cursor + 8);
      cursor += 12;
    };
    entry(256, 4, 1, width);
    entry(257, 4, 1, height);
    entry(258, 3, samples, samples === 3 ? bpsOffset : depth); // single SHORT inline
    entry(259, 3, 1, compression);
    entry(262, 3, 1, 2);
    entry(273, 4, 1, pixelOffset);
    entry(277, 3, 1, samples);
    entry(278, 4, 1, height);
    entry(279, 4, 1, pixelBytes);
    entry(284, 3, 1, 1);
    for (const [tag, type, count, value] of options.extraTags ?? []) entry(tag, type, count, value);
    file.writeUInt32LE(0, cursor);
    if (samples === 3) {
      file.writeUInt16LE(depth, bpsOffset);
      file.writeUInt16LE(depth, bpsOffset + 2);
      file.writeUInt16LE(depth, bpsOffset + 4);
    }

    const pixels = depth === 16 ? new Uint16Array(width * height * samples) : new Uint8Array(width * height * samples);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        for (let channel = 0; channel < samples; channel += 1) {
          const value = depth === 16 ? (x * 1000 + y * 13 + channel * 7) % 60000 : (x * 40 + y * 5 + channel * 3) % 250;
          pixels[(y * width + x) * samples + channel] = value;
        }
      }
    }
    Buffer.from(pixels.buffer, pixels.byteOffset, pixelBytes).copy(file, pixelOffset);
    return { file, pixels };
  }

  it("reads uncompressed 16-bit RGB with exact sample values", async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "filmlab-"));
    const { file, pixels } = buildMinimalTiff();
    const path = join(tempDir, "plain.tiff");
    await fs.writeFile(path, file);

    const image = await readTiff(path);
    assert.equal(image.width, 4);
    assert.equal(image.height, 2);
    assert.equal(image.depth, 16);
    assert.deepEqual([...(image.pixels as Uint16Array)], [...(pixels as Uint16Array)]);
  });

  it("reads 16-bit greyscale TIFFs and replicates channels", async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "filmlab-"));
    const { file, pixels } = buildMinimalTiff({ samples: 1 });
    const path = join(tempDir, "grey.tiff");
    await fs.writeFile(path, file);

    const { raster } = await decodeSource(path);
    const grey = pixels as Uint16Array;
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const offset = Raster.offsetOf(x, y, 4);
        const expected = grey[y * 4 + x]! / 65535;
        approx(raster.data[offset]!, expected, 1e-6);
        approx(raster.data[offset + 1]!, expected, 1e-6);
        approx(raster.data[offset + 2]!, expected, 1e-6);
      }
    }
  });

  it("reads deflate, LZW and PackBits strips written by sharp", async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "filmlab-"));
    const raw = new Uint8Array(8 * 4 * 3);
    for (let index = 0; index < raw.length; index += 1) raw[index] = (index * 31) % 251;
    for (const compression of ["deflate", "lzw", "packbits"] as const) {
      const path = join(tempDir, `${compression}.tiff`);
      await sharp(Buffer.from(raw.buffer), { raw: { width: 8, height: 4, channels: 3 } })
        .tiff({ compression })
        .toFile(path);
      const image = await readTiff(path);
      assert.equal(image.depth, 8);
      assert.equal(image.width, 8);
      assert.deepEqual([...(image.pixels as Uint8Array)], [...raw]);
    }
  });

  it("rejects ICC-tagged, tiled and truncated TIFFs with clear messages", async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "filmlab-"));
    const withIcc = join(tempDir, "icc.tiff");
    await fs.writeFile(withIcc, buildMinimalTiff({ extraTags: [[34675, 7, 4, 0]] }).file);
    await assert.rejects(decodeSource(withIcc), /ICC/);

    const tiled = join(tempDir, "tiled.tiff");
    await fs.writeFile(tiled, buildMinimalTiff({ extraTags: [[322, 4, 1, 64]] }).file);
    await assert.rejects(readTiff(tiled), /分块/);

    const truncated = join(tempDir, "truncated.tiff");
    await fs.writeFile(truncated, buildMinimalTiff().file.subarray(0, 30));
    await assert.rejects(readTiff(truncated), /条带|截断|越界/);
  });
});

describe("Positive export", () => {
  it("exports a 16-bit TIFF whose values match the core display raster", async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "filmlab-"));
    const tiff = join(tempDir, "negative.tiff");
    const out = join(tempDir, "positive.tiff");
    await writeNegativeTiff(tiff);

    const { raster } = await decodeSource(tiff);
    const expected = processNegative(raster, DEFAULT_RECIPE);

    const outcome = await renderPositive(tiff, DEFAULT_RECIPE, "tiff", out);
    assert.equal(outcome.ok, true);

    const image = await readTiff(out);
    assert.equal(image.width, WIDTH);
    assert.equal(image.height, HEIGHT);
    assert.equal(image.depth, 16);
    assert.equal(image.samples, 3);
    const words = image.pixels as Uint16Array;
    for (const x of [7, 20, 40, 63]) {
      const offset = Raster.offsetOf(x, 10, WIDTH);
      // Display values above 1.0 clip at the sRGB delivery ceiling.
      const linear = srgbToLinear(words[offset]! / 65535);
      approx(linear, Math.min(1, expected.display.data[offset]!), 3e-3, `red at x=${x}`);
      approx(srgbToLinear(words[offset + 1]! / 65535), Math.min(1, expected.display.data[offset + 1]!), 3e-3, `green at x=${x}`);
      approx(srgbToLinear(words[offset + 2]! / 65535), Math.min(1, expected.display.data[offset + 2]!), 3e-3, `blue at x=${x}`);
    }
  });

  it("flips polarity: dense negative areas become bright positives", async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "filmlab-"));
    const tiff = join(tempDir, "negative.tiff");
    const out = join(tempDir, "positive.tiff");
    await writeNegativeTiff(tiff);

    const outcome = await renderPositive(tiff, DEFAULT_RECIPE, "tiff", out);
    assert.equal(outcome.ok, true);
    const image = await readTiff(out);
    const words = image.pixels as Uint16Array;

    const border = Raster.offsetOf(2, 10, WIDTH);      // unexposed base → dark positive
    const dense = Raster.offsetOf(63, 10, WIDTH);      // dense negative → bright positive
    const borderLuma = (words[border]! + words[border + 1]! + words[border + 2]!) / 3;
    const denseLuma = (words[dense]! + words[dense + 1]! + words[dense + 2]!) / 3;
    assert.ok(borderLuma < 8000, `border ${borderLuma} should be dark`);
    assert.ok(denseLuma > 50000, `dense ${denseLuma} should be bright`);
  });

  it("honours crop and rotation in the exported dimensions", async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "filmlab-"));
    const tiff = join(tempDir, "negative.tiff");
    const out = join(tempDir, "positive.jpg");
    await writeNegativeTiff(tiff);

    const recipe = { ...DEFAULT_RECIPE, rotate: 90 as const, crop: { x: 0, y: 0, width: 0.5, height: 1 } };
    const outcome = await renderPositive(tiff, recipe, "jpeg", out);
    assert.equal(outcome.ok, true);
    const meta = await sharp(out).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, HEIGHT / 2);
    assert.equal(meta.height, WIDTH);
  });

  it("reports a clean failure for corrupt source files", async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "filmlab-"));
    const broken = join(tempDir, "broken.tiff");
    await fs.writeFile(broken, "this is not a tiff");
    const outcome = await renderPositive(broken, DEFAULT_RECIPE, "tiff", join(tempDir, "out.tiff"));
    assert.equal(outcome.ok, false);
    assert.ok(outcome.message !== undefined && outcome.message.length > 0);
  });
});
