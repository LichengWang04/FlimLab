import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";

import sharp from "sharp";

import { createDefaultXmp } from "./tiff-codec.ts";

interface EncoderWorkerData {
  readonly rawPath: string;
  readonly outputPath: string;
  readonly format: "jpeg" | "heif";
  readonly width: number;
  readonly height: number;
  readonly processingMetadata?: Readonly<Record<string, string | number | boolean>>;
}

void encode(workerData as EncoderWorkerData)
  .then((size) => parentPort?.postMessage({ size }))
  .catch((error: unknown) => parentPort?.postMessage({
    error: error instanceof Error ? error.message : "图像编码失败。",
  }));

async function encode(options: EncoderWorkerData): Promise<number> {
  if (
    (options.format !== "jpeg" && options.format !== "heif")
    || !Number.isSafeInteger(options.width)
    || !Number.isSafeInteger(options.height)
    || options.width <= 0
    || options.height <= 0
  ) throw new Error("图像编码参数无效。");
  const raw = await readFile(options.rawPath);
  const encoder = options.format === "jpeg"
    ? sharp(raw, {
        raw: { width: options.width, height: options.height, channels: 3 },
        limitInputPixels: false,
      })
    : sharp(new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2), {
        raw: { width: options.width, height: options.height, channels: 3 },
        limitInputPixels: false,
      }).toColourspace("rgb16");
  const withMetadata = encoder.withXmp(createDefaultXmp(options.processingMetadata, {
    colorSpace: "sRGB",
    transfer: "sRGB IEC 61966-2-1",
    bitDepth: options.format === "heif" ? 10 : 8,
  })).withIccProfile("srgb");
  const result = options.format === "jpeg"
    ? await withMetadata.jpeg({
        quality: 95,
        chromaSubsampling: "4:4:4",
        progressive: true,
        mozjpeg: true,
      }).toFile(options.outputPath)
    : await withMetadata.heif({
        compression: "av1",
        quality: 92,
        bitdepth: 10,
        chromaSubsampling: "4:4:4",
        effort: 5,
      }).toFile(options.outputPath);
  return result.size;
}
