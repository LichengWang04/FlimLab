import { promises as fs } from "node:fs";
import { endianness } from "node:os";
import { promisify } from "node:util";
import { inflate, inflateRaw } from "node:zlib";
import { srgbToLinear } from "../core/index.ts";
import {
  assertImageDimensions,
  assertSourceFile,
  assertTiffStrips,
  MAX_TIFF_STRIP_BYTES,
} from "./resource-limits.ts";

const inflateAsync = promisify(inflate);
const inflateRawAsync = promisify(inflateRaw);
const COMPRESSION_NONE = 1;
const COMPRESSION_LZW = 5;
const COMPRESSION_DEFLATE = 8;
const COMPRESSION_PACKBITS = 32773;
const MAX_IFD_ENTRIES = 65_536;
const MAX_TAG_VALUES = 65_536;
const SRGB8_TO_LINEAR = Float32Array.from({ length: 256 }, (_, value) => srgbToLinear(value / 255));

export interface TiffImage {
  width: number;
  height: number;
  depth: 8 | 16;
  samples: 1 | 3;
  hasIcc: boolean;
  pixels: Uint16Array | Uint8Array;
}

export interface TiffRasterImage extends Omit<TiffImage, "pixels"> {
  /** Linear RGB transmission values, always three packed channels. */
  data: Float32Array;
}

export interface TiffPreviewRasterImage extends TiffRasterImage {
  sourceWidth: number;
  sourceHeight: number;
}

export type FloatRasterAllocator = (length: number) => Float32Array;

export async function readTiffMetadata(path: string): Promise<Omit<TiffImage, "pixels">> {
  return withParsedTiff(path, async (parsed) => publicInfo(parsed));
}

interface Tag {
  type: number;
  count: number;
  valueOffset: number;
  inline: Buffer;
}

interface ParsedTiff extends Omit<TiffImage, "pixels"> {
  reader: RandomAccessFile;
  littleEndian: boolean;
  compression: number;
  predictor: 1 | 2;
  rowsPerStrip: number;
  stripOffsets: number[];
  stripCounts: number[];
}

/** Reads integer samples for tests and exported-file verification. */
export async function readTiff(path: string): Promise<TiffImage> {
  return withParsedTiff(path, async (parsed) => {
    const sampleCount = parsed.width * parsed.height * parsed.samples;
    const pixels = parsed.depth === 16 ? new Uint16Array(sampleCount) : new Uint8Array(sampleCount);
    await decodeStrips(parsed, (decoded, startRow, rows) => {
      const samplesInStrip = rows * parsed.width * parsed.samples;
      const targetStart = startRow * parsed.width * parsed.samples;
      if (parsed.depth === 8) {
        (pixels as Uint8Array).set(decoded.subarray(0, samplesInStrip), targetStart);
      } else {
        const words = pixels as Uint16Array;
        for (let index = 0; index < samplesInStrip; index += 1) {
          words[targetStart + index] = read16(decoded, index * 2, parsed.littleEndian);
        }
      }
    });
    return { ...publicInfo(parsed), pixels };
  });
}

/**
 * Decodes TIFF strips directly into a linear Float32 RGB allocation. Export
 * workers may provide a SharedArrayBuffer-backed allocator to avoid copying a
 * full-resolution raster before parallel processing.
 */
export async function readTiffRaster(
  path: string,
  allocator: FloatRasterAllocator = (length) => new Float32Array(length),
): Promise<TiffRasterImage> {
  return withParsedTiff(path, (parsed) => decodeTiffRaster(parsed, allocator));
}

/**
 * Decodes directly into the exact area-average preview. Source rows are
 * consumed strip-by-strip, avoiding a full-resolution Float32 allocation
 * while preserving downscaleRaster's source regions and addition order.
 */
export async function readTiffPreviewRaster(path: string, maxSide: number): Promise<TiffPreviewRasterImage> {
  if (!Number.isFinite(maxSide) || maxSide < 1) throw new Error("TIFF preview max side must be positive and finite.");
  return withParsedTiff(path, async (parsed) => {
    rejectProfiledTiff(parsed);
    const sourceWidth = parsed.width;
    const sourceHeight = parsed.height;
    const longest = Math.max(sourceWidth, sourceHeight);
    if (longest <= maxSide) {
      const full = await decodeTiffRaster(parsed, (length) => new Float32Array(length));
      return { ...full, sourceWidth, sourceHeight };
    }

    const scale = maxSide / longest;
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const data = new Float32Array(width * height * 3);
    const sums = new Float64Array(data.length);
    const left = new Int32Array(width);
    const right = new Int32Array(width);
    const top = new Int32Array(height);
    const bottom = new Int32Array(height);
    const sourceTargetX = new Int32Array(sourceWidth).fill(-1);
    const sourceTargetX2 = new Int32Array(sourceWidth).fill(-1);
    const sourceTargetY = new Int32Array(sourceHeight).fill(-1);
    const sourceTargetY2 = new Int32Array(sourceHeight).fill(-1);
    for (let x = 0; x < width; x += 1) {
      left[x] = Math.floor(x * sourceWidth / width);
      right[x] = Math.max(left[x]! + 1, Math.ceil((x + 1) * sourceWidth / width));
      for (let sourceX = left[x]!; sourceX < right[x]!; sourceX += 1) {
        if (sourceTargetX[sourceX] === -1) sourceTargetX[sourceX] = x;
        else sourceTargetX2[sourceX] = x;
      }
    }
    for (let y = 0; y < height; y += 1) {
      top[y] = Math.floor(y * sourceHeight / height);
      bottom[y] = Math.max(top[y]! + 1, Math.ceil((y + 1) * sourceHeight / height));
      for (let sourceY = top[y]!; sourceY < bottom[y]!; sourceY += 1) {
        if (sourceTargetY[sourceY] === -1) sourceTargetY[sourceY] = y;
        else sourceTargetY2[sourceY] = y;
      }
    }

    await decodeStrips(parsed, (decoded, startRow, rows) => {
      const linearSample = createDecodedLinearSampler(decoded, parsed);
      for (let row = 0; row < rows; row += 1) {
        const sourceY = startRow + row;
        const targetY = sourceTargetY[sourceY]!;
        const targetY2 = sourceTargetY2[sourceY]!;
        let sampleOffset = row * sourceWidth * parsed.samples;
        for (let sourceX = 0; sourceX < sourceWidth; sourceX += 1) {
          let red: number;
          let green: number;
          let blue: number;
          if (parsed.samples === 1) {
            red = linearSample(sampleOffset);
            green = red;
            blue = red;
          } else {
            red = linearSample(sampleOffset);
            green = linearSample(sampleOffset + 1);
            blue = linearSample(sampleOffset + 2);
          }
          const targetX = sourceTargetX[sourceX]!;
          const targetX2 = sourceTargetX2[sourceX]!;
          accumulatePreviewSample(sums, width, targetX, targetY, red, green, blue);
          if (targetX2 !== -1) accumulatePreviewSample(sums, width, targetX2, targetY, red, green, blue);
          if (targetY2 !== -1) {
            accumulatePreviewSample(sums, width, targetX, targetY2, red, green, blue);
            if (targetX2 !== -1) accumulatePreviewSample(sums, width, targetX2, targetY2, red, green, blue);
          }
          sampleOffset += parsed.samples;
        }
      }
    });

    for (let y = 0; y < height; y += 1) {
      const sourceRows = bottom[y]! - top[y]!;
      for (let x = 0; x < width; x += 1) {
        const count = (right[x]! - left[x]!) * sourceRows;
        const offset = (y * width + x) * 3;
        data[offset] = sums[offset]! / count;
        data[offset + 1] = sums[offset + 1]! / count;
        data[offset + 2] = sums[offset + 2]! / count;
      }
    }
    return {
      width,
      height,
      sourceWidth,
      sourceHeight,
      depth: parsed.depth,
      samples: parsed.samples,
      hasIcc: false,
      data,
    };
  });
}

function accumulatePreviewSample(
  sums: Float64Array,
  width: number,
  x: number,
  y: number,
  red: number,
  green: number,
  blue: number,
): void {
  const offset = (y * width + x) * 3;
  sums[offset] = sums[offset]! + red;
  sums[offset + 1] = sums[offset + 1]! + green;
  sums[offset + 2] = sums[offset + 2]! + blue;
}

async function decodeTiffRaster(parsed: ParsedTiff, allocator: FloatRasterAllocator): Promise<TiffRasterImage> {
  rejectProfiledTiff(parsed);
  const data = allocator(parsed.width * parsed.height * 3);
  if (data.length !== parsed.width * parsed.height * 3) throw new Error("TIFF raster allocator returned an invalid buffer.");
  await decodeStrips(parsed, (decoded, startRow, rows) => {
    const linearSample = createDecodedLinearSampler(decoded, parsed);
    const stripPixels = rows * parsed.width;
    for (let pixel = 0; pixel < stripPixels; pixel += 1) {
      const sourceOffset = pixel * parsed.samples;
      const targetOffset = ((startRow * parsed.width) + pixel) * 3;
      if (parsed.samples === 1) {
        const grey = linearSample(sourceOffset);
        data[targetOffset] = grey;
        data[targetOffset + 1] = grey;
        data[targetOffset + 2] = grey;
      } else {
        data[targetOffset] = linearSample(sourceOffset);
        data[targetOffset + 1] = linearSample(sourceOffset + 1);
        data[targetOffset + 2] = linearSample(sourceOffset + 2);
      }
    }
  });
  return { ...publicInfo(parsed), data };
}

function rejectProfiledTiff(parsed: ParsedTiff): void {
  if (parsed.hasIcc) {
    throw new Error(
      "该 TIFF 内嵌 ICC 色彩配置。为保留 16 位精度,请先用外部工具(如 ImageMagick)转换为 16 位线性或 sRGB TIFF 后再打开。",
    );
  }
}

function createDecodedLinearSampler(decoded: Buffer, parsed: ParsedTiff): (sample: number) => number {
  if (parsed.depth === 8) return (sample) => SRGB8_TO_LINEAR[decoded[sample]!]!;
  if (parsed.littleEndian && endianness() === "LE" && decoded.byteOffset % Uint16Array.BYTES_PER_ELEMENT === 0) {
    const words = new Uint16Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / 2);
    return (sample) => Math.fround(words[sample]! / 65_535);
  }
  return (sample) => Math.fround(read16(decoded, sample * 2, parsed.littleEndian) / 65_535);
}

async function withParsedTiff<T>(path: string, operation: (parsed: ParsedTiff) => Promise<T>): Promise<T> {
  await assertSourceFile(path);
  const handle = await fs.open(path, "r");
  try {
    const stat = await handle.stat();
    const reader = new RandomAccessFile(handle, stat.size);
    const parsed = await parseTiff(reader);
    return await operation(parsed);
  } finally {
    await handle.close();
  }
}

async function parseTiff(reader: RandomAccessFile): Promise<ParsedTiff> {
  const header = await reader.read(0, 8);
  const byteOrder = header.toString("ascii", 0, 2);
  const littleEndian = byteOrder === "II";
  if (!littleEndian && byteOrder !== "MM") throw new Error("不是有效的 TIFF 文件。");
  if (read16(header, 2, littleEndian) !== 42) throw new Error("不是有效的 TIFF 文件(魔数不符)。");
  const ifdOffset = read32(header, 4, littleEndian);
  if (ifdOffset < 8) throw new Error("TIFF IFD 偏移无效。");
  const countBuffer = await reader.read(ifdOffset, 2);
  const entryCount = read16(countBuffer, 0, littleEndian);
  if (entryCount < 1 || entryCount > MAX_IFD_ENTRIES) throw new Error("TIFF IFD 标签数量无效或过多。");
  const directory = await reader.read(ifdOffset + 2, entryCount * 12 + 4);
  const tags = new Map<number, Tag>();
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = index * 12;
    const tagId = read16(directory, entryOffset, littleEndian);
    tags.set(tagId, {
      type: read16(directory, entryOffset + 2, littleEndian),
      count: read32(directory, entryOffset + 4, littleEndian),
      valueOffset: read32(directory, entryOffset + 8, littleEndian),
      inline: Buffer.from(directory.subarray(entryOffset + 8, entryOffset + 12)),
    });
  }
  const nextIfd = read32(directory, entryCount * 12, littleEndian);
  if (nextIfd !== 0) throw new Error("暂不支持多页 TIFF，请先拆分为单页图像后再导入。");

  const required = (tag: number, name: string): Tag => {
    const found = tags.get(tag);
    if (found === undefined) throw new Error(`TIFF 缺少必需标签 ${name}。`);
    return found;
  };
  const optionalScalar = async (tag: number, fallback: number, name: string): Promise<number> => {
    const found = tags.get(tag);
    return found === undefined ? fallback : readUnsignedScalar(reader, found, littleEndian, name);
  };

  const width = await readUnsignedScalar(reader, required(256, "ImageWidth"), littleEndian, "ImageWidth");
  const height = await readUnsignedScalar(reader, required(257, "ImageLength"), littleEndian, "ImageLength");
  const photometric = await optionalScalar(262, 2, "PhotometricInterpretation");
  const samplesValue = await optionalScalar(277, 3, "SamplesPerPixel");
  const planar = await optionalScalar(284, 1, "PlanarConfiguration");
  assertImageDimensions(width, height);
  if (photometric !== 1 && photometric !== 2) {
    throw new Error("暂不支持该 TIFF 色彩布局(仅支持 RGB/灰度),请先转换为 16 位 RGB TIFF。");
  }
  if (samplesValue !== 1 && samplesValue !== 3) {
    throw new Error("暂不支持带透明度或 CMYK 的 TIFF,请先转换为 RGB TIFF。");
  }
  const samples = samplesValue as 1 | 3;
  if (planar !== 1) throw new Error("暂不支持平面分离(PlanarConfiguration=2)的 TIFF。");
  if (tags.has(322) || tags.has(323)) throw new Error("暂不支持分块(tiled)TIFF,请先导出为条带(strip)布局。");

  const bitsPerSample = await readShortArray(reader, required(258, "BitsPerSample"), littleEndian, "BitsPerSample");
  if (bitsPerSample.length !== samples || bitsPerSample.some((bits) => bits !== bitsPerSample[0])) {
    throw new Error("TIFF BitsPerSample 与通道数不一致。");
  }
  if (bitsPerSample[0] !== 8 && bitsPerSample[0] !== 16) throw new Error("仅支持 8/16 位整数 TIFF 样本。");
  const depth = bitsPerSample[0] as 8 | 16;
  const sampleFormat = tags.get(339);
  if (sampleFormat !== undefined) {
    const formats = await readShortArray(reader, sampleFormat, littleEndian, "SampleFormat");
    if (formats.length !== samples || formats.some((format) => format !== 1)) {
      throw new Error("仅支持每通道均为无符号整数的 TIFF 样本。");
    }
  }

  const compression = await optionalScalar(259, COMPRESSION_NONE, "Compression");
  const stripOffsets = await readUnsignedArray(reader, required(273, "StripOffsets"), littleEndian, "StripOffsets");
  const stripCounts = await readUnsignedArray(reader, required(279, "StripByteCounts"), littleEndian, "StripByteCounts");
  assertTiffStrips(stripOffsets, stripCounts);
  const predictorValue = await optionalScalar(317, 1, "Predictor");
  if (predictorValue !== 1 && predictorValue !== 2) throw new Error("TIFF Predictor 标签不受支持。");
  const rowsPerStrip = await optionalScalar(278, height, "RowsPerStrip");
  if (!Number.isSafeInteger(rowsPerStrip) || rowsPerStrip < 1) throw new Error("TIFF RowsPerStrip 无效。");
  if (stripOffsets.length !== Math.ceil(height / rowsPerStrip)) {
    throw new Error("TIFF 条带数量与 RowsPerStrip 不一致。");
  }
  return {
    reader,
    littleEndian,
    width,
    height,
    depth,
    samples,
    hasIcc: tags.has(34675),
    compression,
    predictor: predictorValue,
    rowsPerStrip,
    stripOffsets,
    stripCounts,
  };
}

async function decodeStrips(
  parsed: ParsedTiff,
  consume: (decoded: Buffer, startRow: number, rows: number) => void,
): Promise<void> {
  const bytesPerPixel = parsed.samples * (parsed.depth / 8);
  for (let index = 0; index < parsed.stripOffsets.length; index += 1) {
    const startRow = index * parsed.rowsPerStrip;
    const rows = Math.min(parsed.rowsPerStrip, parsed.height - startRow);
    const decodedBytes = rows * parsed.width * bytesPerPixel;
    if (decodedBytes < 1 || decodedBytes > MAX_TIFF_STRIP_BYTES) {
      throw new Error("TIFF 解码条带超过安全内存上限。");
    }
    const encoded = await parsed.reader.read(parsed.stripOffsets[index]!, parsed.stripCounts[index]!);
    const decoded = await decompressStrip(encoded, parsed.compression, decodedBytes);
    if (decoded.length !== decodedBytes) throw new Error("TIFF 条带解码长度与声明尺寸不一致。");
    if (parsed.predictor === 2) {
      undoHorizontalPredictor(decoded, rows, parsed.width, parsed.depth, parsed.samples, parsed.littleEndian);
    }
    consume(decoded, startRow, rows);
  }
}

class RandomAccessFile {
  private readonly handle: Awaited<ReturnType<typeof fs.open>>;
  private readonly size: number;

  constructor(handle: Awaited<ReturnType<typeof fs.open>>, size: number) {
    this.handle = handle;
    this.size = size;
  }

  async read(offset: number, length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.size) {
      throw new Error("TIFF 数据越界，文件可能已截断或损坏。");
    }
    const buffer = Buffer.allocUnsafe(length);
    let completed = 0;
    while (completed < length) {
      const result = await this.handle.read(buffer, completed, length - completed, offset + completed);
      if (result.bytesRead < 1) throw new Error("TIFF 文件已截断或损坏。");
      completed += result.bytesRead;
    }
    return buffer;
  }
}

async function readUnsignedScalar(
  reader: RandomAccessFile,
  tag: Tag,
  littleEndian: boolean,
  name: string,
): Promise<number> {
  if (tag.count !== 1) throw new Error(`TIFF ${name} 必须是单值标签。`);
  if (tag.type === 3) return (await readShortArray(reader, tag, littleEndian, name))[0]!;
  if (tag.type === 4) return (await readLongArray(reader, tag, littleEndian, name))[0]!;
  throw new Error(`TIFF ${name} 标签类型不受支持。`);
}

async function readShortArray(
  reader: RandomAccessFile,
  tag: Tag,
  littleEndian: boolean,
  name: string,
): Promise<number[]> {
  if (tag.type !== 3 || tag.count < 1 || tag.count > MAX_TAG_VALUES) throw new Error(`TIFF ${name} SHORT 数组无效。`);
  const bytes = tag.count * 2 <= 4 ? tag.inline : await reader.read(tag.valueOffset, tag.count * 2);
  return Array.from({ length: tag.count }, (_, index) => read16(bytes, index * 2, littleEndian));
}

async function readLongArray(
  reader: RandomAccessFile,
  tag: Tag,
  littleEndian: boolean,
  name: string,
): Promise<number[]> {
  if (tag.type !== 4 || tag.count < 1 || tag.count > MAX_TAG_VALUES) throw new Error(`TIFF ${name} LONG 数组无效。`);
  const bytes = tag.count === 1 ? tag.inline : await reader.read(tag.valueOffset, tag.count * 4);
  return Array.from({ length: tag.count }, (_, index) => read32(bytes, index * 4, littleEndian));
}

async function readUnsignedArray(
  reader: RandomAccessFile,
  tag: Tag,
  littleEndian: boolean,
  name: string,
): Promise<number[]> {
  if (tag.type === 3) return readShortArray(reader, tag, littleEndian, name);
  if (tag.type === 4) return readLongArray(reader, tag, littleEndian, name);
  throw new Error(`TIFF ${name} 必须是 SHORT 或 LONG 数组。`);
}

async function decompressStrip(encoded: Buffer, compression: number, expectedBytes: number): Promise<Buffer> {
  switch (compression) {
    case COMPRESSION_NONE:
      return encoded;
    case COMPRESSION_DEFLATE:
      try {
        return await inflateAsync(encoded, { maxOutputLength: expectedBytes });
      } catch {
        return inflateRawAsync(encoded, { maxOutputLength: expectedBytes });
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
  depth: 8 | 16,
  samples: number,
  littleEndian: boolean,
): void {
  const bytesPerSample = depth / 8;
  const rowBytes = width * samples * bytesPerSample;
  for (let row = 0; row < rows; row += 1) {
    const start = row * rowBytes;
    if (depth === 16) {
      const wordsPerRow = width * samples;
      for (let sample = samples; sample < wordsPerRow; sample += 1) {
        const at = start + sample * 2;
        const value = (read16(strip, at, littleEndian) + read16(strip, at - samples * 2, littleEndian)) & 0xffff;
        write16(strip, at, value, littleEndian);
      }
    } else {
      for (let sample = samples; sample < rowBytes; sample += 1) {
        strip[start + sample] = (strip[start + sample]! + strip[start + sample - samples]!) & 0xff;
      }
    }
  }
}

function sampleAt(bytes: Buffer, sample: number, depth: 8 | 16, littleEndian: boolean): number {
  return depth === 8 ? bytes[sample]! : read16(bytes, sample * 2, littleEndian);
}

function read16(buffer: Buffer, offset: number, littleEndian: boolean): number {
  return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
}

function write16(buffer: Buffer, offset: number, value: number, littleEndian: boolean): void {
  if (littleEndian) buffer.writeUInt16LE(value, offset);
  else buffer.writeUInt16BE(value, offset);
}

function read32(buffer: Buffer, offset: number, littleEndian: boolean): number {
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function publicInfo(parsed: ParsedTiff): Omit<TiffImage, "pixels"> {
  return {
    width: parsed.width,
    height: parsed.height,
    depth: parsed.depth,
    samples: parsed.samples,
    hasIcc: parsed.hasIcc,
  };
}

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
      bitBuffer = (bitBuffer << 8) | input[position]!;
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
    if (code < table.length) entry = table[code]!;
    else if (code === next && previous !== null) {
      entry = new Uint8Array(previous.length + 1);
      entry.set(previous);
      entry[previous.length] = previous[0]!;
    } else throw new Error("LZW 数据流损坏。");
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
    const header = input[position++]!;
    if (header <= 127) {
      const length = header + 1;
      if (position + length > input.length) throw new Error("PackBits 数据流已截断。");
      outputLength += length;
      if (outputLength > outputLimit) throw new Error("PackBits 解码结果超过条带安全上限。");
      chunks.push(input.subarray(position, position + length));
      position += length;
    } else if (header >= 129) {
      const length = 257 - header;
      if (position >= input.length) throw new Error("PackBits 数据流已截断。");
      outputLength += length;
      if (outputLength > outputLimit) throw new Error("PackBits 解码结果超过条带安全上限。");
      chunks.push(Buffer.alloc(length, input[position++]!));
    }
  }
  return Buffer.concat(chunks);
}
