import { extname } from "node:path";
import sharp from "sharp";
import { Raster, downscaleRaster, srgbToLinear } from "../core/index.ts";
import { readTiff } from "./tiff-decode.ts";

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
export async function decodeSource(path: string, maxSide?: number): Promise<DecodedFrame> {
  const extension = extname(path).toLowerCase();
  if (extension === ".tiff" || extension === ".tif") {
    return decodeTiff(path, maxSide);
  }
  return decodeRasterFile(path, maxSide);
}

async function decodeTiff(path: string, maxSide?: number): Promise<DecodedFrame> {
  const image = await readTiff(path);
  if (image.hasIcc) {
    throw new Error(
      "该 TIFF 内嵌 ICC 色彩配置。为保留 16 位精度,请先用外部工具(如 ImageMagick)转换为 16 位线性或 sRGB TIFF 后再打开。",
    );
  }
  const raster = samplesToRaster(image.width, image.height, image.depth, image.samples, image.pixels);
  const preview = maxSide === undefined ? raster : downscaleRaster(raster, maxSide);
  return {
    raster: preview,
    meta: { width: image.width, height: image.height, depth: image.depth, hasIcc: false, format: "tiff" },
  };
}

function samplesToRaster(
  width: number,
  height: number,
  depth: 8 | 16,
  samples: 1 | 3,
  pixels: Uint16Array | Uint8Array,
): Raster {
  const raster = new Raster(width, height, "transmission-linear");
  const target = raster.data;
  const scale = depth === 16 ? 1 / 65535 : 1 / 255;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const targetOffset = pixel * 3;
    const sourceOffset = pixel * samples;
    const grey = pixels[sourceOffset]! * scale;
    for (let channel = 0; channel < 3; channel += 1) {
      const sample = samples === 1 ? grey : pixels[sourceOffset + channel]! * scale;
      // 16-bit scans are linear transmission; 8-bit TIFFs are display-referred.
      const linear = depth === 16 ? sample : srgbToLinear(sample);
      target[targetOffset + channel] = Number.isFinite(linear) ? Math.max(0, linear) : 0;
    }
  }
  return raster;
}

async function decodeRasterFile(path: string, maxSide?: number): Promise<DecodedFrame> {
  const input = sharp(path);
  const meta = await input.metadata();
  if (meta.width === undefined || meta.height === undefined || meta.width < 1 || meta.height < 1) {
    throw new Error("无法读取图像尺寸,文件可能已损坏或格式不受支持。");
  }
  const format = meta.format ?? "";
  const is16 = meta.depth === "ushort";
  const hasIcc = meta.icc !== undefined;

  let pipeline = input;
  if (meta.hasAlpha === true) pipeline = pipeline.removeAlpha();
  if (hasIcc) pipeline = pipeline.toColourspace("srgb");
  if (maxSide !== undefined) {
    pipeline = pipeline.resize(maxSide, maxSide, {
      fit: "inside",
      withoutEnlargement: true,
      kernel: "lanczos3",
    });
  }

  const { data, info } = await pipeline
    .raw({ depth: is16 ? "ushort" : "uchar" })
    .toBuffer({ resolveWithObject: true });
  const channels = Math.min(3, info.channels);
  const raster = new Raster(info.width, info.height, "transmission-linear");
  const target = raster.data;
  const wordCount = data.byteLength / 2;
  const words = is16
    ? data.byteOffset % 2 === 0
      ? new Uint16Array(data.buffer, data.byteOffset, wordCount)
      : new Uint16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
    : undefined;
  const scale = is16 ? 1 / 65535 : 1 / 255;

  for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
    const offset = pixel * 3;
    const sourceOffset = pixel * info.channels;
    const grey = (is16 ? words![sourceOffset]! : data[sourceOffset]!) * scale;
    for (let channel = 0; channel < 3; channel += 1) {
      const sample = is16 ? words![sourceOffset + channel]! : data[sourceOffset + channel]!;
      const encoded = channels === 1 ? grey : sample * scale;
      const linear = srgbToLinear(encoded);
      target[offset + channel] = Number.isFinite(linear) ? Math.max(0, linear) : 0;
    }
  }
  return {
    raster,
    meta: { width: meta.width, height: meta.height, depth: is16 ? 16 : 8, hasIcc, format },
  };
}
