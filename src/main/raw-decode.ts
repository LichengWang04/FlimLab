import { promises as fs } from "node:fs";
import { downscaleRaster, Raster } from "../core/index.ts";
import type { LibRawImageData } from "libraw-wasm";
import { assertRawImageDimensions, assertRawSourceFile } from "./resource-limits.ts";
import { LibRawNodeClient } from "./libraw-node-client.ts";
import type { DecodedFrame, SourceMeta } from "./decode.ts";

const RAW_SETTINGS = Object.freeze({
  outputBps: 16,
  outputColor: 1,
  useCameraMatrix: 3,
  useCameraWb: false,
  useAutoWb: false,
  noAutoBright: true,
  adjustMaximumThr: 0,
  bright: 1,
  gamm: [1, 1] as [number, number],
  highlight: 0,
  userQual: 3,
});

export const RAW_EXTENSIONS = new Set([".cr2", ".nef", ".rw2", ".arw"]);

export function isRawExtension(extension: string): boolean {
  return RAW_EXTENSIONS.has(extension.toLowerCase());
}

export async function probeRawSource(path: string): Promise<SourceMeta> {
  await assertRawSourceFile(path);
  const source = await fs.readFile(path);
  const bytes = transferableBytes(source);
  const client = new LibRawNodeClient();
  try {
    await client.open(bytes, { ...RAW_SETTINGS, halfSize: false });
    const metadata = await client.metadata(false);
    if (metadata === undefined) throw new Error("LibRaw 未返回可用的图像元数据。");
    const rotated = metadata.flip === 5 || metadata.flip === 6;
    const width = rotated ? metadata.height : metadata.width;
    const height = rotated ? metadata.width : metadata.height;
    assertRawImageDimensions(width, height);
    return { width, height, depth: 16, hasIcc: false, format: rawFormat(path) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取相机 RAW：${detail}`);
  } finally {
    client.dispose();
  }
}

export async function decodeRawSource(path: string, maxSide?: number): Promise<DecodedFrame> {
  return decodeRaw(path, maxSide);
}

async function decodeRaw(path: string, maxSide?: number): Promise<DecodedFrame> {
  await assertRawSourceFile(path);
  const source = await fs.readFile(path);
  const bytes = transferableBytes(source);
  const client = new LibRawNodeClient();
  try {
    await client.open(bytes, { ...RAW_SETTINGS, halfSize: maxSide !== undefined });
    const [metadata, image] = await Promise.all([client.metadata(false), client.imageData()]);
    if (metadata === undefined || image === undefined) throw new Error("LibRaw 未返回可用的图像数据。");
    if (image.colors < 3 || (image.bits !== 16 && image.bits !== 8)) {
      throw new Error("RAW 解码结果必须是 8/16 位 RGB 图像。");
    }
    assertRawImageDimensions(image.width, image.height);
    const pixels = image.width * image.height;
    if (image.data.length < pixels * image.colors) throw new Error("RAW 解码数据长度不足，文件可能已损坏。");
    const delivered = rawImageToRaster(image, maxSide);
    return {
      raster: delivered,
      meta: {
        width: image.width,
        height: image.height,
        depth: image.bits === 16 ? 16 : 8,
        hasIcc: false,
        format: rawFormat(path),
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法解码相机 RAW：${detail}`);
  } finally {
    client.dispose();
  }
}

/** Converts LibRaw's interleaved output to the canonical linear raster. */
export function rawImageToRaster(image: LibRawImageData, maxSide?: number): Raster {
  if (image.colors < 3 || (image.bits !== 16 && image.bits !== 8)) {
    throw new Error("RAW 解码结果必须是 8/16 位 RGB 图像。");
  }
  assertRawImageDimensions(image.width, image.height);
  const pixels = image.width * image.height;
  if (image.data.length < pixels * image.colors) throw new Error("RAW 解码数据长度不足，文件可能已损坏。");
  const raster = new Raster(image.width, image.height, "transmission-linear");
  const scale = image.bits === 16 ? 1 / 65_535 : 1 / 255;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const sourceOffset = pixel * image.colors;
    const targetOffset = pixel * 3;
    raster.data[targetOffset] = Math.fround(image.data[sourceOffset]! * scale);
    raster.data[targetOffset + 1] = Math.fround(image.data[sourceOffset + 1]! * scale);
    raster.data[targetOffset + 2] = Math.fround(image.data[sourceOffset + 2]! * scale);
  }
  return maxSide === undefined ? raster : downscaleRaster(raster, maxSide);
}

function transferableBytes(source: Buffer): Uint8Array {
  if (source.byteOffset === 0 && source.byteLength === source.buffer.byteLength) {
    return new Uint8Array(source.buffer);
  }
  return Uint8Array.from(source);
}

function rawFormat(path: string): string {
  const match = /\.([^.]+)$/.exec(path);
  return match?.[1]?.toLowerCase() ?? "raw";
}
