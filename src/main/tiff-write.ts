import { promises as fs } from "node:fs";
import { endianness } from "node:os";
import { promisify } from "node:util";
import { deflate } from "node:zlib";
import { publishFileAtomic } from "./atomic-write.ts";

const deflateAsync = promisify(deflate);
const DEFAULT_STRIP_TARGET_BYTES = 16 * 1024 * 1024;
const DEFAULT_COMPRESSION_CONCURRENCY = 4;
const CLASSIC_TIFF_MAX_OFFSET = 0xffff_ffff;

export interface TiffWriteOptions {
  /** Test seam; production writes target approximately 16 MiB raw strips. */
  targetStripBytes?: number;
  /** Test seam; production compresses four independent strips concurrently. */
  compressionConcurrency?: number;
}

export interface TiffStripPlan {
  rowsPerStrip: number;
  stripCount: number;
}

export function planTiffStrips(
  width: number,
  height: number,
  targetStripBytes = DEFAULT_STRIP_TARGET_BYTES,
): TiffStripPlan {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("TIFF dimensions must be positive safe integers.");
  }
  if (!Number.isSafeInteger(targetStripBytes) || targetStripBytes < 1) {
    throw new Error("TIFF strip target must be a positive safe integer.");
  }
  const rowBytes = width * 3 * Uint16Array.BYTES_PER_ELEMENT;
  const rowsPerStrip = Math.max(1, Math.min(height, Math.floor(targetStripBytes / rowBytes)));
  return { rowsPerStrip, stripCount: Math.ceil(height / rowsPerStrip) };
}

/**
 * Writes packed 16-bit RGB sRGB values as a little-endian, multi-strip TIFF.
 * Strips are compressed and written one at a time so the encoded file is
 * never duplicated in memory. The final sibling rename uses the shared safe
 * atomic publisher.
 */
export async function writeTiff16(
  path: string,
  width: number,
  height: number,
  pixels: Uint16Array,
  options: TiffWriteOptions = {},
): Promise<void> {
  if (pixels.length !== width * height * 3) {
    throw new Error("TIFF pixel buffer does not match the declared dimensions.");
  }
  const plan = planTiffStrips(width, height, options.targetStripBytes);
  const compressionConcurrency = options.compressionConcurrency ?? DEFAULT_COMPRESSION_CONCURRENCY;
  if (!Number.isSafeInteger(compressionConcurrency) || compressionConcurrency < 1 || compressionConcurrency > 8) {
    throw new Error("TIFF compression concurrency must be an integer between 1 and 8.");
  }
  await publishFileAtomic(path, async (temporary) => {
    const handle = await fs.open(temporary, "w+");
    try {
      await writeTiffToHandle(handle, width, height, pixels, plan, compressionConcurrency);
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

async function writeTiffToHandle(
  handle: Awaited<ReturnType<typeof fs.open>>,
  width: number,
  height: number,
  pixels: Uint16Array,
  plan: TiffStripPlan,
  compressionConcurrency: number,
): Promise<void> {
  const entryCount = 11;
  const ifdStart = 8;
  const ifdSize = 2 + entryCount * 12 + 4;
  const bitsPerSampleOffset = ifdStart + ifdSize;
  const sampleFormatOffset = bitsPerSampleOffset + 6;
  const stripOffsetsOffset = sampleFormatOffset + 6;
  const stripCountsOffset = stripOffsetsOffset + plan.stripCount * 4;
  const pixelOffset = stripCountsOffset + plan.stripCount * 4;
  const prefix = Buffer.alloc(pixelOffset);

  prefix.write("II", 0, "ascii");
  prefix.writeUInt16LE(42, 2);
  prefix.writeUInt32LE(ifdStart, 4);
  let cursor = ifdStart;
  prefix.writeUInt16LE(entryCount, cursor);
  cursor += 2;
  const entry = (tag: number, type: number, count: number, value: number): number => {
    prefix.writeUInt16LE(tag, cursor);
    prefix.writeUInt16LE(type, cursor + 2);
    prefix.writeUInt32LE(count, cursor + 4);
    prefix.writeUInt32LE(value, cursor + 8);
    const valueOffset = cursor + 8;
    cursor += 12;
    return valueOffset;
  };
  const SHORT = 3;
  const LONG = 4;

  entry(256, LONG, 1, width);
  entry(257, LONG, 1, height);
  entry(258, SHORT, 3, bitsPerSampleOffset);
  entry(259, SHORT, 1, 8);
  entry(262, SHORT, 1, 2);
  const stripOffsetsValue = entry(273, LONG, plan.stripCount, plan.stripCount === 1 ? 0 : stripOffsetsOffset);
  entry(277, SHORT, 1, 3);
  entry(278, LONG, 1, plan.rowsPerStrip);
  const stripCountsValue = entry(279, LONG, plan.stripCount, plan.stripCount === 1 ? 0 : stripCountsOffset);
  entry(284, SHORT, 1, 1);
  entry(339, SHORT, 3, sampleFormatOffset);
  prefix.writeUInt32LE(0, cursor);

  for (let offset = 0; offset < 6; offset += 2) {
    prefix.writeUInt16LE(16, bitsPerSampleOffset + offset);
    prefix.writeUInt16LE(1, sampleFormatOffset + offset);
  }

  const stripOffsets: number[] = [];
  const stripCounts: number[] = [];
  await writeAll(handle, prefix, 0);
  let filePosition = pixelOffset;
  const samplesPerRow = width * 3;
  for (let batchStart = 0; batchStart < plan.stripCount; batchStart += compressionConcurrency) {
    const batchEnd = Math.min(plan.stripCount, batchStart + compressionConcurrency);
    const compressedBatch = await Promise.all(Array.from(
      { length: batchEnd - batchStart },
      async (_, batchIndex) => {
        const strip = batchStart + batchIndex;
        const startRow = strip * plan.rowsPerStrip;
        const rows = Math.min(plan.rowsPerStrip, height - startRow);
        const sampleStart = startRow * samplesPerRow;
        const sampleCount = rows * samplesPerRow;
        return deflateAsync(littleEndianBytes(pixels, sampleStart, sampleCount));
      },
    ));
    for (const compressed of compressedBatch) {
      if (filePosition + compressed.length > CLASSIC_TIFF_MAX_OFFSET) {
        throw new Error("TIFF 输出超过 classic TIFF 的 4 GiB 偏移上限。");
      }
      stripOffsets.push(filePosition);
      stripCounts.push(compressed.length);
      await writeAll(handle, compressed, filePosition);
      filePosition += compressed.length;
    }
  }

  if (plan.stripCount === 1) {
    prefix.writeUInt32LE(stripOffsets[0]!, stripOffsetsValue);
    prefix.writeUInt32LE(stripCounts[0]!, stripCountsValue);
  } else {
    for (let strip = 0; strip < plan.stripCount; strip += 1) {
      prefix.writeUInt32LE(stripOffsets[strip]!, stripOffsetsOffset + strip * 4);
      prefix.writeUInt32LE(stripCounts[strip]!, stripCountsOffset + strip * 4);
    }
  }
  await writeAll(handle, prefix, 0);
}

function littleEndianBytes(pixels: Uint16Array, sampleStart: number, sampleCount: number): Buffer {
  if (endianness() === "LE") {
    return Buffer.from(
      pixels.buffer,
      pixels.byteOffset + sampleStart * Uint16Array.BYTES_PER_ELEMENT,
      sampleCount * Uint16Array.BYTES_PER_ELEMENT,
    );
  }
  const bytes = Buffer.allocUnsafe(sampleCount * Uint16Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < sampleCount; index += 1) {
    bytes.writeUInt16LE(pixels[sampleStart + index]!, index * 2);
  }
  return bytes;
}

async function writeAll(
  handle: Awaited<ReturnType<typeof fs.open>>,
  buffer: Uint8Array,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < buffer.byteLength) {
    const result = await handle.write(buffer, written, buffer.byteLength - written, position + written);
    if (result.bytesWritten < 1) throw new Error("无法继续写入 TIFF 临时文件。");
    written += result.bytesWritten;
  }
}
