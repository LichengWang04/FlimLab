import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { inflate, inflateRaw } from "node:zlib";
import {
  assertImageDimensions,
  assertSourceFile,
  assertTiffStrips,
  MAX_TIFF_STRIP_BYTES,
} from "./resource-limits.ts";

const inflateAsync = promisify(inflate);
const inflateRawAsync = promisify(inflateRaw);

/**
 * Minimal TIFF reader for scan negatives: baseline layout, chunky samples,
 * 8/16-bit unsigned integer, uncompressed / deflate / LZW / PackBits strips.
 * Float, tiled, YCbCr and JPEG-compressed TIFFs are rejected with a clear
 * message instead of being silently misread. This decoder exists because
 * sharp/libvips down-converts 16-bit TIFF input to 8-bit on load, which
 * would defeat the 16-bit scan path.
 */

export interface TiffImage {
  width: number;
  height: number;
  depth: 8 | 16;
  samples: 1 | 3;
  hasIcc: boolean;
  /** Packed samples; Uint16Array for 16-bit, Uint8Array for 8-bit. */
  pixels: Uint16Array | Uint8Array;
}

interface Tag {
  type: number;
  count: number;
  /** Inline value when it fits in 4 bytes, otherwise a data-area offset. */
  value: number;
}

const COMPRESSION_NONE = 1;
const COMPRESSION_LZW = 5;
const COMPRESSION_DEFLATE = 8;
const COMPRESSION_PACKBITS = 32773;

export async function readTiff(path: string): Promise<TiffImage> {
  await assertSourceFile(path);
  const file = await fs.readFile(path);
  if (file.length < 8) throw new Error("TIFF 文件过小或已损坏。");
  const littleEndian = file.toString("ascii", 0, 2) === "II";
  if (!littleEndian && file.toString("ascii", 0, 2) !== "MM") {
    throw new Error("不是有效的 TIFF 文件。");
  }
  const read16 = (offset: number): number => (
    littleEndian ? file.readUInt16LE(offset) : file.readUInt16BE(offset)
  );
  const read32 = (offset: number): number => (
    littleEndian ? file.readUInt32LE(offset) : file.readUInt32BE(offset)
  );
  if (read16(2) !== 42) throw new Error("不是有效的 TIFF 文件(魔数不符)。");

  const tags = new Map<number, Tag>();
  let ifdOffset = read32(4);
  const seenIfds = new Set<number>();
  while (ifdOffset !== 0) {
    if (seenIfds.has(ifdOffset) || seenIfds.size >= 64) throw new Error("TIFF IFD 链无效或过长。");
    seenIfds.add(ifdOffset);
    if (ifdOffset + 2 > file.length) throw new Error("TIFF 文件已截断或损坏。");
    const entryCount = read16(ifdOffset);
    if (ifdOffset + 2 + entryCount * 12 + 4 > file.length) throw new Error("TIFF 文件已截断或损坏。");
    for (let index = 0; index < entryCount; index += 1) {
      const entry = ifdOffset + 2 + index * 12;
      tags.set(read16(entry), {
        type: read16(entry + 2),
        count: read32(entry + 4),
        value: read32(entry + 8),
      });
    }
    ifdOffset = read32(ifdOffset + 2 + entryCount * 12);
  }

  const required = (tag: number, name: string): Tag => {
    const found = tags.get(tag);
    if (found === undefined) throw new Error(`TIFF 缺少必需标签 ${name}。`);
    return found;
  };
  const width = required(256, "ImageWidth").value;
  const height = required(257, "ImageLength").value;
  const photometric = tags.get(262)?.value ?? 2;
  const samples = tags.get(277)?.value ?? 3;
  const planar = tags.get(284)?.value ?? 1;

  assertImageDimensions(width, height);
  if (photometric !== 1 && photometric !== 2) {
    throw new Error("暂不支持该 TIFF 色彩布局(仅支持 RGB/灰度),请先转换为 16 位 RGB TIFF。");
  }
  if (samples !== 1 && samples !== 3) {
    throw new Error("暂不支持带透明度或 CMYK 的 TIFF,请先转换为 RGB TIFF。");
  }
  if (planar !== 1) throw new Error("暂不支持平面分离(PlanarConfiguration=2)的 TIFF。");
  if (tags.has(322) || tags.has(323)) {
    throw new Error("暂不支持分块(tiled)TIFF,请先导出为条带(strip)布局。");
  }

  const bitsPerSample = readShortArray(file, required(258, "BitsPerSample"), littleEndian);
  if (bitsPerSample.some((bits) => bits !== 8 && bits !== 16)) {
    throw new Error("仅支持 8/16 位整数 TIFF 样本。");
  }
  const depth = bitsPerSample[0] as 8 | 16;
  const sampleFormat = tags.get(339);
  if (sampleFormat !== undefined) {
    const formats = readShortArray(file, sampleFormat, littleEndian);
    if (formats.some((format) => format !== 1)) {
      throw new Error("仅支持无符号整数样本的 TIFF(不支持浮点 TIFF)。");
    }
  }

  const compression = tags.get(259)?.value ?? 1;
  const stripOffsets = readLongArray(file, required(273, "StripOffsets"), littleEndian);
  const stripCounts = readLongArray(file, required(279, "StripByteCounts"), littleEndian);
  assertTiffStrips(stripOffsets, stripCounts);
  const predictor = tags.get(317)?.value ?? 1;
  if (predictor !== 1 && predictor !== 2) throw new Error("TIFF Predictor 标签不受支持。");

  const expectedLength = width * height * samples * (depth / 8);
  const rowsPerStrip = tags.get(278)?.value ?? height;
  // TIFF permits RowsPerStrip to exceed ImageLength; that still describes one
  // strip and is what libvips/sharp commonly writes for small images.
  if (!Number.isSafeInteger(rowsPerStrip) || rowsPerStrip < 1) {
    throw new Error("TIFF RowsPerStrip 无效。");
  }
  if (stripOffsets.length !== Math.ceil(height / rowsPerStrip)) {
    throw new Error("TIFF 条带数量与 RowsPerStrip 不一致。");
  }
  const stripRows = stripOffsets.map((_, index) => (
    index === stripOffsets.length - 1
      ? height - rowsPerStrip * (stripOffsets.length - 1)
      : rowsPerStrip
  ));

  const bytesPerPixel = samples * (depth / 8);
  const target = new Uint8Array(expectedLength);
  for (let index = 0; index < stripOffsets.length; index += 1) {
    const offset = stripOffsets[index]!;
    const count = stripCounts[index]!;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + count > file.length) {
      throw new Error("TIFF 条带数据越界,文件可能已截断。");
    }
    const encoded = file.subarray(offset, offset + count);
    const decodedBytes = stripRows[index]! * width * bytesPerPixel;
    if (decodedBytes < 1 || decodedBytes > MAX_TIFF_STRIP_BYTES) {
      throw new Error("TIFF 解码条带超过安全内存上限。");
    }
    const decoded = await decompressStrip(encoded, compression, decodedBytes);
    if (decoded.length !== decodedBytes) throw new Error("TIFF 条带解码长度与声明尺寸不一致。");
    if (predictor === 2) undoHorizontalPredictor(decoded, stripRows[index]!, width, bytesPerPixel, depth, samples);
    const rowBytes = width * bytesPerPixel;
    target.set(decoded.subarray(0, stripRows[index]! * rowBytes), index * rowsPerStrip * rowBytes);
  }

  const pixels = depth === 16
    ? new Uint16Array(target.buffer, target.byteOffset, expectedLength / 2)
    : target;
  return {
    width,
    height,
    depth,
    samples: samples as 1 | 3,
    hasIcc: tags.has(34675),
    pixels,
  };
}

function readShortArray(file: Buffer, tag: Tag, littleEndian: boolean): number[] {
  const values: number[] = [];
  if (tag.count > 65_536) throw new Error("TIFF SHORT 标签数组过长。");
  if (tag.type === 3) {
    if (tag.count === 1) {
      // A single SHORT is stored inline in the low 16 bits of the value field.
      values.push(tag.value & 0xffff);
    } else if (tag.count === 2) {
      values.push(tag.value & 0xffff, (tag.value >>> 16) & 0xffff);
    } else {
      if (tag.value + tag.count * 2 > file.length) throw new Error("TIFF SHORT 标签数据越界。");
      for (let index = 0; index < tag.count; index += 1) {
        values.push(littleEndian
          ? file.readUInt16LE(tag.value + index * 2)
          : file.readUInt16BE(tag.value + index * 2));
      }
    }
  }
  return values;
}

function readLongArray(file: Buffer, tag: Tag, littleEndian: boolean): number[] {
  const values: number[] = [];
  if (tag.count > 65_536) throw new Error("TIFF LONG 标签数组过长。");
  if (tag.type === 4) {
    if (tag.count === 1) {
      values.push(tag.value);
    } else {
      if (tag.value + tag.count * 4 > file.length) throw new Error("TIFF LONG 标签数据越界。");
      for (let index = 0; index < tag.count; index += 1) {
        values.push(littleEndian
          ? file.readUInt32LE(tag.value + index * 4)
          : file.readUInt32BE(tag.value + index * 4));
      }
    }
  }
  return values;
}

async function decompressStrip(encoded: Buffer, compression: number, expectedBytes: number): Promise<Buffer> {
  switch (compression) {
    case COMPRESSION_NONE:
      return encoded;
    case COMPRESSION_DEFLATE:
      // libtiff writes zlib streams; a few writers emit raw deflate.
      try {
        return await inflateAsync(encoded, { maxOutputLength: expectedBytes });
      } catch {
        return await inflateRawAsync(encoded, { maxOutputLength: expectedBytes });
      }
    case COMPRESSION_LZW:
      return lzwDecode(encoded, expectedBytes);
    case COMPRESSION_PACKBITS:
      return packBitsDecode(encoded, expectedBytes);
    default:
      throw new Error(`不支持的 TIFF 压缩方式(${compression}),请先转换为 Deflate/无压缩 TIFF。`);
  }
}

function undoHorizontalPredictor(
  strip: Buffer,
  rows: number,
  width: number,
  bytesPerPixel: number,
  depth: 8 | 16,
  samples: number,
): void {
  const rowBytes = width * bytesPerPixel;
  for (let row = 0; row < rows; row += 1) {
    const start = row * rowBytes;
    if (depth === 16) {
      // Differencing runs per component: each sample adds the previous
      // sample of the same channel (stride = samplesPerPixel words).
      const wordsPerRow = width * samples;
      for (let sample = samples; sample < wordsPerRow; sample += 1) {
        const at = start + sample * 2;
        const previous = strip.readUInt16LE(at - samples * 2);
        strip.writeUInt16LE((strip.readUInt16LE(at) + previous) & 0xffff, at);
      }
    } else {
      for (let sample = samples; sample < rowBytes; sample += 1) {
        strip[start + sample] = (strip[start + sample]! + strip[start + sample - samples]!) & 0xff;
      }
    }
  }
}

/**
 * TIFF variant of LZW: MSB-first codes, clear code 256, EOI 257, and the
 * "early change" rule (the code width grows when the next table slot is
 * 2^width - 1, not one code later).
 */
function lzwDecode(input: Buffer, outputLimit: number): Buffer {
  const clear = 256;
  const eoi = 257;
  const table: Uint8Array[] = [];
  for (let value = 0; value < 256; value += 1) table.push(Uint8Array.of(value));
  table.push(new Uint8Array(0), new Uint8Array(0));
  let codeSize = 9;
  let next = 258;
  let previous: Uint8Array | null = null;

  const chunks: Uint8Array[] = [];
  let outputLength = 0;
  let bitBuffer = 0;
  let bitCount = 0;
  let position = 0;
  const readCode = (): number => {
    while (bitCount < codeSize) {
      if (position >= input.length) throw new Error("LZW 数据流已截断。");
      bitBuffer = (bitBuffer << 8) | (input[position] ?? 0);
      bitCount += 8;
      position += 1;
    }
    bitCount -= codeSize;
    return (bitBuffer >>> bitCount) & ((1 << codeSize) - 1);
  };

  for (;;) {
    const code = readCode();
    if (code === eoi) break;
    if (code === clear) {
      table.length = 258;
      codeSize = 9;
      next = 258;
      previous = null;
      continue;
    }
    let entry: Uint8Array;
    if (code < table.length) {
      entry = table[code]!;
    } else if (code === next && previous !== null) {
      entry = new Uint8Array(previous.length + 1);
      entry.set(previous);
      entry[previous.length] = previous[0]!;
    } else {
      throw new Error("LZW 数据流损坏。");
    }
    if (entry.length === 0) throw new Error("LZW 数据流损坏(空表项)。");
    outputLength += entry.length;
    if (outputLength > outputLimit) throw new Error("LZW 解码结果超过条带安全上限。");
    chunks.push(entry);
    if (previous !== null) {
      const joined = new Uint8Array(previous.length + 1);
      joined.set(previous);
      joined[previous.length] = entry[0]!;
      table.push(joined);
      next += 1;
      if (next === (1 << codeSize) - 1 && codeSize < 12) codeSize += 1;
    }
    previous = entry;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
}

function packBitsDecode(input: Buffer, outputLimit: number): Buffer {
  const chunks: Buffer[] = [];
  let position = 0;
  let outputLength = 0;
  while (position < input.length) {
    const header = input[position]!;
    position += 1;
    if (header <= 127) {
      // Literal run of header + 1 bytes.
      const length = header + 1;
      if (position + length > input.length) throw new Error("PackBits 数据流已截断。");
      outputLength += length;
      if (outputLength > outputLimit) throw new Error("PackBits 解码结果超过条带安全上限。");
      chunks.push(input.subarray(position, position + length));
      position += length;
    } else if (header >= 129) {
      // Replicate the next byte 257 - header times.
      const length = 257 - header;
      if (position >= input.length) throw new Error("PackBits 数据流已截断。");
      outputLength += length;
      if (outputLength > outputLimit) throw new Error("PackBits 解码结果超过条带安全上限。");
      const value = input[position] ?? 0;
      position += 1;
      chunks.push(Buffer.alloc(length, value));
    }
    // header === 128 is a no-op.
  }
  return Buffer.concat(chunks);
}
