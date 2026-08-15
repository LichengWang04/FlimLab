import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import test from "node:test";

import sharp from "sharp";

import {
  displayLinearToSrgb16,
  encodeDisplayLinearTiff,
  encodeSrgb16Tiff,
  StreamingSrgb16TiffWriter,
  writeDisplayLinearTiff,
} from "../src/main/tiff-codec.ts";
import { createStreamingMasterWriter, writeDisplayLinearMaster } from "../src/main/master-export-codec.ts";
import { validateMasterArtifact } from "../src/main/master-artifact-validator.ts";
import { unpackEncodedMasterPixels } from "../src/renderer/src/gpu-master-readback.ts";

test("display-linear samples are gamma encoded and quantised to 16-bit sRGB", () => {
  const samples = displayLinearToSrgb16(new Float32Array([0, 0.5, 1, -1, Number.NaN, Number.POSITIVE_INFINITY]));

  assert.deepEqual(Array.from(samples), [0, 48_192, 65_535, 0, 0, 65_535]);
});

test("TIFF encoder writes lossless 16-bit samples, embedded ICC and XMP", async () => {
  const linear = new Float32Array([
    0, 0.25, 1,
    1, 0.5, 0,
  ]);
  const tiff = await encodeDisplayLinearTiff({
    width: 2,
    height: 1,
    data: linear,
    densityDpi: 300,
    processingMetadata: {
      mode: "calibrated",
      profile: "unit-profile",
      colorTrust: "device-matched",
      colorAccuracyClaim: "device-matched-linear-srgb-d65",
    },
  });
  const metadata = await sharp(tiff).metadata();

  assert.equal(metadata.format, "tiff");
  assert.equal(metadata.width, 2);
  assert.equal(metadata.height, 1);
  assert.equal(metadata.depth, "ushort");
  assert.equal(metadata.bitsPerSample, 16);
  assert.equal(metadata.density, 300);
  assert.equal(metadata.hasProfile, true);
  assert.ok(metadata.icc !== undefined && metadata.icc.length > 0);
  assert.match(metadata.xmpAsString ?? "", /filmlab:ColorSpace="sRGB"/);
  assert.match(metadata.xmpAsString ?? "", /unit-profile/);
  assert.match(metadata.xmpAsString ?? "", /device-matched-linear-srgb-d65/);

  // Decode the raw TIFF strip instead of asking Sharp to colour-manage it.
  // This confirms the stored 16-bit words themselves were not changed while
  // the ICC profile was appended.
  assert.deepEqual(
    Array.from(readDeflatedRgb16Strip(tiff)),
    Array.from(displayLinearToSrgb16(linear)),
  );
});

test("GPU-quantised sRGB16 samples bypass CPU transfer conversion", async () => {
  const samples = new Uint16Array([0, 32_768, 65_535, 65_535, 12_345, 1]);
  const tiff = await encodeSrgb16Tiff({
    width: 2,
    height: 1,
    data: samples,
    processingMetadata: { pipeline: "webgl2-tiled-uint16" },
  });

  assert.deepEqual(Array.from(readDeflatedRgb16Strip(tiff)), Array.from(samples));
  assert.match((await sharp(tiff).metadata()).xmpAsString ?? "", /webgl2-tiled-uint16/);
});

test("TIFF writer uses a same-directory temporary file before publishing", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-tiff-"));
  const outputPath = join(directory, "positive.tiff");
  context.after(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  const result = await writeDisplayLinearTiff({
    width: 1,
    height: 1,
    data: new Float32Array([0.18, 0.18, 0.18]),
    outputPath,
  });
  const written = await readFile(outputPath);

  assert.equal(result.outputPath, outputPath);
  assert.equal(result.bitDepth, 16);
  assert.equal(result.colorSpace, "sRGB");
  assert.equal(result.hasEmbeddedIcc, true);
  assert.equal(result.byteLength, written.length);
});

test("streaming TIFF writer preserves ordered GPU strips without a full-raster buffer", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-streaming-tiff-"));
  const outputPath = join(directory, "streamed.tiff");
  context.after(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  const first = new Uint16Array([
    0, 100, 200, 300, 400, 500,
    600, 700, 800, 900, 1_000, 1_100,
  ]);
  const second = new Uint16Array([
    1_200, 1_300, 1_400, 65_535, 32_768, 1,
  ]);
  const writer = await StreamingSrgb16TiffWriter.create({
    outputPath,
    width: 2,
    height: 3,
    rowsPerStrip: 2,
    processingMetadata: { pipeline: "streaming-test" },
  });
  await writer.appendStrip(0, 2, first);
  await writer.appendStrip(2, 1, second);
  const result = await writer.finish();
  const tiff = await readFile(outputPath);

  assert.equal(result.byteLength, tiff.length);
  assert.deepEqual(Array.from(readDeflatedRgb16Strips(tiff)), [...first, ...second]);
  const metadata = await sharp(tiff).metadata();
  assert.equal(metadata.hasProfile, true);
  assert.match(metadata.xmpAsString ?? "", /streaming-test/);
});

test("streaming TIFF writer emits valid inline offsets for a single strip", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-single-strip-"));
  const outputPath = join(directory, "single.tiff");
  context.after(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  const samples = new Uint16Array([1, 2, 3, 65_533, 65_534, 65_535]);
  const writer = await StreamingSrgb16TiffWriter.create({
    outputPath,
    width: 2,
    height: 1,
    rowsPerStrip: 256,
  });
  await writer.appendStrip(0, 1, samples);
  await writer.finish();

  assert.deepEqual(Array.from(readDeflatedRgb16Strips(await readFile(outputPath))), Array.from(samples));
  const validation = await validateMasterArtifact(outputPath, "tiff", { width: 2, height: 1 });
  assert.equal(validation.hasIcc, true);
});

test("GPU master readback keeps encoded tile rows in top-to-bottom order", () => {
  const rgba = new Uint16Array([
    1, 2, 3, 65_535, 4, 5, 6, 65_535,
    7, 8, 9, 65_535, 10, 11, 12, 65_535,
  ]);
  assert.deepEqual(
    Array.from(unpackEncodedMasterPixels(rgba, 2, 2)),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
});

test("linear DNG export writes required DNG identity and LinearRaw tags", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-dng-"));
  const outputPath = join(directory, "positive.dng");
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const samples = new Uint16Array([
    0, 32_768, 65_535, 1_024, 2_048, 4_096,
    8_192, 16_384, 32_768, 65_535, 1, 2,
  ]);
  const writer = await StreamingSrgb16TiffWriter.create({
    outputPath,
    container: "dng",
    width: 2,
    height: 2,
    rowsPerStrip: 2,
  });
  await writer.appendStrip(0, 2, samples);
  const result = await writer.finish();
  const dng = await readFile(outputPath);
  const tags = readClassicTiffTags(dng);

  assert.equal(valueFromTag(dng, tags.get(262)), 34_892);
  assert.equal(valueFromTag(dng, tags.get(274)), 1);
  assert.ok(tags.has(50706), "DNGVersion is required");
  assert.ok(tags.has(50707), "DNGBackwardVersion is required");
  assert.ok(tags.has(50708), "UniqueCameraModel is required");
  assert.ok(tags.has(50721), "ColorMatrix1 is required for RGB DNG");
  assert.equal(result.colorSpace, "linear-sRGB");
  assert.equal(result.hasEmbeddedIcc, false);
  assert.deepEqual(Array.from(readDeflatedRgb16Strips(dng)), Array.from(samples));
  const validation = await validateMasterArtifact(outputPath, "dng", { width: 2, height: 2 });
  assert.deepEqual(validation.dngTags, [50706, 50707, 50708, 50721]);
});

test("streaming JPG and HEIF exports preserve dimensions and advertised depth", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-compressed-"));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const samples = new Uint16Array(4 * 3 * 3);
  samples.forEach((_, index) => { samples[index] = (index * 1_997) & 0xffff; });
  for (const [format, extension, expectedFormat, expectedBits] of [
    ["jpeg", "jpg", "jpeg", 8],
    ["heif", "avif", "heif", 10],
  ] as const) {
    const outputPath = join(directory, "positive." + extension);
    const writer = await createStreamingMasterWriter({
      outputPath,
      format,
      width: 4,
      height: 3,
      rowsPerStrip: 2,
      processingMetadata: {
        colorTrust: "device-matched",
        colorAccuracyClaim: "device-matched-linear-srgb-d65",
      },
    });
    await writer.appendStrip(0, 2, samples.subarray(0, 4 * 2 * 3));
    await writer.appendStrip(2, 1, samples.subarray(4 * 2 * 3));
    const result = await writer.finish();
    const metadata = await sharp(outputPath).metadata();
    assert.equal(result.bitDepth, expectedBits);
    assert.equal(metadata.format, expectedFormat);
    assert.equal(metadata.width, 4);
    assert.equal(metadata.height, 3);
    assert.match(metadata.xmpAsString ?? "", /device-matched-linear-srgb-d65/);
    if (format === "heif") assert.equal(metadata.bitsPerSample, expectedBits);
    const validation = await validateMasterArtifact(outputPath, format, {
      width: 4,
      height: 3,
      xmpIncludes: ["device-matched-linear-srgb-d65"],
    });
    assert.equal(validation.hasIcc, true);
  }
});

test("a retry removes export artifacts owned by a dead process", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-crash-recovery-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "recovered.jpg");
  await writeFile(join(directory, ".recovered.jpg.99999999.crashed.tmp"), "partial");
  await writeFile(join(directory, ".recovered.jpg.99999999.crashed.tmp.raw"), "partial");

  const writer = await createStreamingMasterWriter({
    outputPath,
    format: "jpeg",
    width: 1,
    height: 1,
    rowsPerStrip: 1,
  });
  await writer.appendStrip(0, 1, new Uint16Array([1, 2, 3]));
  await writer.finish();

  assert.deepEqual((await readdir(directory)).filter((name) => name.includes(".tmp")), []);
  await access(outputPath);
});

test("disk exhaustion leaves no published or temporary master", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-enospc-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "insufficient.jpg");

  await assert.rejects(
    writeDisplayLinearMaster({
      outputPath,
      format: "jpeg",
      width: 2,
      height: 2,
      rowsPerStrip: 1,
      data: new Float32Array(12).fill(0.5),
      testWriteLimitBytes: 2,
    }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error
      && (error as { code?: unknown }).code === "ENOSPC",
  );
  await assert.rejects(access(outputPath), /ENOENT/);
  assert.deepEqual(await readdir(directory), []);
});

test("cancelling a streaming master removes every unpublished artifact", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-export-cancel-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "cancelled.avif");
  const writer = await createStreamingMasterWriter({
    outputPath,
    format: "heif",
    width: 2,
    height: 2,
    rowsPerStrip: 1,
  });
  await writer.appendStrip(0, 1, new Uint16Array(6).fill(12_345));
  await writer.cancel();

  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(access(outputPath), /ENOENT/);
});

function readDeflatedRgb16Strip(tiff: Buffer): Uint16Array {
  return readDeflatedRgb16Strips(tiff);
}

function readDeflatedRgb16Strips(tiff: Buffer): Uint16Array {
  const littleEndian = tiff.toString("ascii", 0, 2) === "II";
  assert.equal(littleEndian, true, "The Sharp fixture should be a little-endian TIFF.");
  assert.equal(tiff.readUInt16LE(2), 42, "The fixture should be classic TIFF.");
  const ifdOffset = tiff.readUInt32LE(4);
  const entryCount = tiff.readUInt16LE(ifdOffset);
  const tags = new Map<number, { readonly type: number; readonly count: number; readonly valueOffset: number }>();

  for (let index = 0; index < entryCount; index += 1) {
    const offset = ifdOffset + 2 + (index * 12);
    tags.set(tiff.readUInt16LE(offset), {
      type: tiff.readUInt16LE(offset + 2),
      count: tiff.readUInt32LE(offset + 4),
      valueOffset: tiff.readUInt32LE(offset + 8),
    });
  }

  const width = valueFromTag(tiff, tags.get(256));
  const height = valueFromTag(tiff, tags.get(257));
  const samplesPerPixel = valueFromTag(tiff, tags.get(277));
  const predictor = valueFromTag(tiff, tags.get(317));
  assert.equal(samplesPerPixel, 3);
  assert.equal(predictor, 2);

  const rowsPerStrip = valueFromTag(tiff, tags.get(278));
  const stripOffsets = valuesFromTag(tiff, tags.get(273));
  const stripByteCounts = valuesFromTag(tiff, tags.get(279));
  assert.equal(stripOffsets.length, stripByteCounts.length);
  const samples = new Uint16Array(width * height * samplesPerPixel);
  for (let strip = 0; strip < stripOffsets.length; strip += 1) {
    const compressed = tiff.subarray(stripOffsets[strip], stripOffsets[strip] + stripByteCounts[strip]);
    const predicted = inflateSync(compressed);
    const firstRow = strip * rowsPerStrip;
    const stripHeight = Math.min(rowsPerStrip, height - firstRow);
    for (let localRow = 0; localRow < stripHeight; localRow += 1) {
      const row = firstRow + localRow;
      for (let sample = 0; sample < width * samplesPerPixel; sample += 1) {
        const byteOffset = (localRow * width * samplesPerPixel * 2) + (sample * 2);
        const value = predicted.readUInt16LE(byteOffset);
        const previous = sample >= samplesPerPixel
          ? samples[(row * width * samplesPerPixel) + sample - samplesPerPixel]
          : 0;
        samples[(row * width * samplesPerPixel) + sample] = (value + previous) & 0xffff;
      }
    }
  }

  return samples;
}

function readClassicTiffTags(tiff: Buffer): Map<number, { readonly type: number; readonly count: number; readonly valueOffset: number }> {
  const ifdOffset = tiff.readUInt32LE(4);
  const entryCount = tiff.readUInt16LE(ifdOffset);
  const tags = new Map<number, { readonly type: number; readonly count: number; readonly valueOffset: number }>();
  for (let index = 0; index < entryCount; index += 1) {
    const offset = ifdOffset + 2 + index * 12;
    tags.set(tiff.readUInt16LE(offset), {
      type: tiff.readUInt16LE(offset + 2),
      count: tiff.readUInt32LE(offset + 4),
      valueOffset: tiff.readUInt32LE(offset + 8),
    });
  }
  return tags;
}

function valuesFromTag(
  tiff: Buffer,
  tag: { readonly type: number; readonly count: number; readonly valueOffset: number } | undefined,
): number[] {
  assert.ok(tag !== undefined, "Expected TIFF tag to exist.");
  assert.ok(tag.type === 3 || tag.type === 4, "Fixture expects SHORT or LONG TIFF values.");
  const bytesPerValue = tag.type === 3 ? 2 : 4;
  if (tag.count === 1) return [valueFromTag(tiff, tag)];
  return Array.from({ length: tag.count }, (_, index) => tag.type === 3
    ? tiff.readUInt16LE(tag.valueOffset + index * bytesPerValue)
    : tiff.readUInt32LE(tag.valueOffset + index * bytesPerValue));
}

function valueFromTag(
  tiff: Buffer,
  tag: { readonly type: number; readonly count: number; readonly valueOffset: number } | undefined,
): number {
  assert.ok(tag !== undefined, "Expected TIFF tag to exist.");
  assert.equal(tag.count, 1, "Fixture expects a single TIFF tag value.");
  if (tag.type === 3) {
    return tag.valueOffset & 0xffff;
  }
  assert.equal(tag.type, 4, "Fixture expects a SHORT or LONG TIFF tag.");
  return tag.valueOffset;
}
