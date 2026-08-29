import { extname } from "node:path";
import sharp from "sharp";
import { Raster, srgbToLinear } from "../core/index.ts";
import { readTiffMetadata, readTiffPreviewRaster, readTiffRaster } from "./tiff-decode.ts";
import type { FloatRasterAllocator } from "./tiff-decode.ts";
import { assertImageDimensions, assertSourceFile, MAX_IMAGE_PIXELS } from "./resource-limits.ts";
import { decodeRawSource, isRawExtension, probeRawSource } from "./raw-decode.ts";

const SRGB8_TO_LINEAR = Float32Array.from({ length: 256 }, (_, value) => srgbToLinear(value / 255));
let srgb16ToLinear: Float32Array | undefined;

export interface SourceMeta {
  width: number;
  height: number;
  /** Source bit depth: 8 for uchar, 16 for ushort. */
  depth: 8 | 16;
  hasIcc: boolean;
  format: string;
}

export interface DecodedFrame {
  raster: Raster;
  meta: SourceMeta;
}

export async function probeSource(path: string): Promise<SourceMeta> {
  await assertSourceFile(path);
  const extension = extname(path).toLowerCase();
  if (isRawExtension(extension)) return probeRawSource(path);
  if (extension === ".tiff" || extension === ".tif") {
    const info = await readTiffMetadata(path);
    return {
      width: info.width,
      height: info.height,
      depth: info.depth,
      hasIcc: info.hasIcc,
      format: "tiff",
    };
  }
  const meta = await sharp(path, { sequentialRead: true, limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  if (meta.width === undefined || meta.height === undefined || meta.width < 1 || meta.height < 1) {
    throw new Error("无法读取图像尺寸,文件可能已损坏或格式不受支持。");
  }
  assertImageDimensions(meta.width, meta.height);
  return {
    width: meta.width,
    height: meta.height,
    depth: meta.depth === "ushort" ? 16 : 8,
    hasIcc: meta.icc !== undefined,
    format: meta.format ?? "",
  };
}

/**
 * Decodes an image file into linear transmission samples.
 *
 * TIFF files go through the internal decoder so 16-bit scan data keeps its
 * full precision (sharp/libvips would down-convert it to 8-bit on load):
 * - 16-bit TIFFs without an ICC profile are assumed to already be linearised
 *   scan data (the common scanner-raw convention) and are used as-is.
 * - 8-bit TIFFs without a profile are display-referred and get the sRGB
 *   inverse transfer function.
 * - TIFFs with an embedded ICC profile are rejected with an actionable
 *   message: colour-managing them would silently destroy 16-bit precision.
 *
 * JPEG/PNG go through sharp and are treated as display-referred sRGB.
 * Non-positive and non-finite samples are clamped so out-of-gamut profile
 * conversions cannot poison the density logarithm.
 */
export async function decodeSource(
  path: string,
  maxSide?: number,
  allocator?: FloatRasterAllocator,
): Promise<DecodedFrame> {
  await assertSourceFile(path);
  if (maxSide !== undefined && (!Number.isFinite(maxSide) || maxSide < 1 || maxSide > 4096)) {
    throw new Error("预览尺寸请求无效。");
  }
  const extension = extname(path).toLowerCase();
  if (isRawExtension(extension)) return decodeRawSource(path, maxSide);
  if (extension === ".tiff" || extension === ".tif") {
    return decodeTiff(path, maxSide, allocator);
  }
  return decodeRasterFile(path, maxSide, allocator);
}

/** Low-memory display-only decode used by the filmstrip queue. */
export async function decodeThumbnailSource(path: string, maxSide = 256): Promise<DecodedFrame> {
  if (!Number.isFinite(maxSide) || maxSide < 1 || maxSide > 4096) throw new Error("缩略图尺寸请求无效。");
  await assertSourceFile(path);
  const extension = extname(path).toLowerCase();
  if (isRawExtension(extension)) return decodeRawSource(path, maxSide);
  if (extension === ".tiff" || extension === ".tif") {
    const info = await readTiffMetadata(path);
    if (info.hasIcc) {
      throw new Error(
        "该 TIFF 内嵌 ICC 色彩配置。为保留 16 位精度,请先用外部工具转换为无 ICC 的线性或 sRGB TIFF 后再打开。",
      );
    }
    return decodeRasterFile(path, maxSide, undefined, info.depth);
  }
  return decodeRasterFile(path, maxSide);
}

async function decodeTiff(
  path: string,
  maxSide?: number,
  allocator?: FloatRasterAllocator,
): Promise<DecodedFrame> {
  if (maxSide !== undefined) {
    const image = await readTiffPreviewRaster(path, maxSide);
    return {
      raster: new Raster(image.width, image.height, "transmission-linear", image.data),
      meta: {
        width: image.sourceWidth,
        height: image.sourceHeight,
        depth: image.depth,
        hasIcc: false,
        format: "tiff",
      },
    };
  }
  const image = await readTiffRaster(path, allocator);
  const raster = new Raster(image.width, image.height, "transmission-linear", image.data);
  return {
    raster,
    meta: { width: image.width, height: image.height, depth: image.depth, hasIcc: false, format: "tiff" },
  };
}

async function decodeRasterFile(
  path: string,
  maxSide?: number,
  allocator?: FloatRasterAllocator,
  tiffThumbnailDepth?: 8 | 16,
): Promise<DecodedFrame> {
  const input = sharp(path, { sequentialRead: true, limitInputPixels: MAX_IMAGE_PIXELS });
  const meta = await input.metadata();
  if (meta.width === undefined || meta.height === undefined || meta.width < 1 || meta.height < 1) {
    throw new Error("无法读取图像尺寸,文件可能已损坏或格式不受支持。");
  }
  assertImageDimensions(meta.width, meta.height);
  const format = meta.format ?? "";
  // libvips can report an existing 16-bit TIFF as uchar before the raw output
  // depth is selected. Trust the bounded TIFF metadata parser for thumbnails.
  const sourceIs16 = tiffThumbnailDepth === 16 || (tiffThumbnailDepth === undefined && meta.depth === "ushort");
  const tiffThumbnail = tiffThumbnailDepth !== undefined;
  const hasIcc = meta.icc !== undefined;
  if (tiffThumbnail && hasIcc) {
    throw new Error(
      "该 TIFF 内嵌 ICC 色彩配置。为保留 16 位精度,请先用外部工具转换为无 ICC 的线性或 sRGB TIFF 后再打开。",
    );
  }
  let pipeline = input;
  if (meta.hasAlpha === true) pipeline = pipeline.removeAlpha();
  if (hasIcc && !tiffThumbnail) pipeline = pipeline.toColourspace("srgb");
  if (maxSide !== undefined) {
    pipeline = pipeline.resize(maxSide, maxSide, {
      fit: "inside",
      withoutEnlargement: true,
      kernel: "lanczos3",
    });
  }

  const { data, info } = await pipeline
    // libvips' TIFF loader already reduces this display-only path to 8-bit;
    // asking for ushort would merely return values in 0..255 stored as words.
    .raw({ depth: sourceIs16 && !tiffThumbnail ? "ushort" : "uchar" })
    .toBuffer({ resolveWithObject: true });
  const channels = Math.min(3, info.channels);
  const raster = new Raster(
    info.width,
    info.height,
    "transmission-linear",
    allocator?.(info.width * info.height * 3),
  );
  const target = raster.data;
  const wordCount = data.byteLength / 2;
  const rawIs16 = sourceIs16 && !tiffThumbnail;
  const words = rawIs16
    ? data.byteOffset % 2 === 0
      ? new Uint16Array(data.buffer, data.byteOffset, wordCount)
      : new Uint16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
    : undefined;
  const scale = rawIs16 ? 1 / 65535 : 1 / 255;
  const linear16 = rawIs16 ? srgb16ToLinear ??= Float32Array.from(
    { length: 65_536 },
    (_, value) => srgbToLinear(value / 65_535),
  ) : undefined;

  for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
    const offset = pixel * 3;
    const sourceOffset = pixel * info.channels;
    const greySample = rawIs16 ? words![sourceOffset]! : data[sourceOffset]!;
    const grey = greySample * scale;
    for (let channel = 0; channel < 3; channel += 1) {
      const sample = rawIs16 ? words![sourceOffset + channel]! : data[sourceOffset + channel]!;
      const selected = channels === 1 ? greySample : sample;
      const encoded = channels === 1 ? grey : sample * scale;
      const linear = tiffThumbnail && sourceIs16
        ? encoded
        : rawIs16
          ? linear16![selected]!
          : SRGB8_TO_LINEAR[selected]!;
      target[offset + channel] = Number.isFinite(linear) ? Math.max(0, linear) : 0;
    }
  }
  return {
    raster,
    meta: { width: meta.width, height: meta.height, depth: tiffThumbnailDepth ?? (sourceIs16 ? 16 : 8), hasIcc, format },
  };
}
