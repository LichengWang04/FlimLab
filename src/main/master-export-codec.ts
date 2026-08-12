import { mkdir, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import sharp from "sharp";

import type { MasterExportFormat } from "../shared/contracts.ts";
import {
  displayLinearToLinear16,
  displayLinearToSrgb16,
  StreamingSrgb16TiffWriter,
  createDefaultXmp,
  writeDisplayLinearTiff,
} from "./tiff-codec.ts";

export interface MasterExportWriteResult {
  readonly outputPath: string;
  readonly byteLength: number;
  readonly bitDepth: 8 | 10 | 16;
  readonly colorSpace: "sRGB" | "linear-sRGB";
}

export interface StreamingRgb16Writer {
  appendStrip(outputY: number, height: number, data: Uint16Array): Promise<void>;
  finish(): Promise<MasterExportWriteResult>;
  cancel(): Promise<void>;
}

export interface StreamingMasterExportOptions {
  readonly outputPath: string;
  readonly format: MasterExportFormat;
  readonly width: number;
  readonly height: number;
  readonly rowsPerStrip: number;
  readonly processingMetadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface DisplayLinearMasterExportOptions extends StreamingMasterExportOptions {
  readonly data: Float32Array;
}

export async function createStreamingMasterWriter(
  options: StreamingMasterExportOptions,
): Promise<StreamingRgb16Writer> {
  if (options.format === "tiff" || options.format === "dng") {
    const writer = await StreamingSrgb16TiffWriter.create({
      outputPath: options.outputPath,
      width: options.width,
      height: options.height,
      rowsPerStrip: options.rowsPerStrip,
      container: options.format,
      processingMetadata: options.processingMetadata,
    });
    return {
      appendStrip: (outputY, height, data) => writer.appendStrip(outputY, height, data),
      finish: async () => {
        const result = await writer.finish();
        return {
          outputPath: result.outputPath,
          byteLength: result.byteLength,
          bitDepth: 16,
          colorSpace: options.format === "dng" ? "linear-sRGB" : "sRGB",
        };
      },
      cancel: () => writer.cancel(),
    };
  }
  return SharpStreamingWriter.create(options);
}

export async function writeDisplayLinearMaster(
  options: DisplayLinearMasterExportOptions,
): Promise<MasterExportWriteResult> {
  if (options.format === "tiff") {
    return writeDisplayLinearTiff(options);
  }
  const samples = options.format === "dng"
    ? displayLinearToLinear16(options.data)
    : displayLinearToSrgb16(options.data);
  const writer = await createStreamingMasterWriter(options);
  try {
    for (let outputY = 0; outputY < options.height; outputY += options.rowsPerStrip) {
      const height = Math.min(options.rowsPerStrip, options.height - outputY);
      const first = outputY * options.width * 3;
      const last = (outputY + height) * options.width * 3;
      await writer.appendStrip(outputY, height, samples.subarray(first, last));
    }
    return await writer.finish();
  } catch (error) {
    await writer.cancel().catch(() => undefined);
    throw error;
  }
}

class SharpStreamingWriter implements StreamingRgb16Writer {
  private readonly options: StreamingMasterExportOptions;
  private readonly temporaryPath: string;
  private readonly rawPath: string;
  private readonly rawHandle: FileHandle;
  private nextOutputY = 0;
  private position = 0;
  private closed = false;

  private constructor(
    options: StreamingMasterExportOptions,
    temporaryPath: string,
    rawPath: string,
    rawHandle: FileHandle,
  ) {
    this.options = options;
    this.temporaryPath = temporaryPath;
    this.rawPath = rawPath;
    this.rawHandle = rawHandle;
  }

  public static async create(options: StreamingMasterExportOptions): Promise<SharpStreamingWriter> {
    if (options.outputPath.trim().length === 0) throw new Error("导出路径不能为空。");
    const outputDirectory = dirname(options.outputPath);
    const temporaryPath = join(
      outputDirectory,
      "." + basename(options.outputPath) + "." + randomUUID() + ".tmp",
    );
    const rawPath = temporaryPath + ".raw";
    await mkdir(outputDirectory, { recursive: true });
    const rawHandle = await open(rawPath, "wx");
    return new SharpStreamingWriter(options, temporaryPath, rawPath, rawHandle);
  }

  public async appendStrip(outputY: number, height: number, data: Uint16Array): Promise<void> {
    this.assertOpen();
    if (
      outputY !== this.nextOutputY
      || !Number.isSafeInteger(height)
      || height <= 0
      || height > this.options.rowsPerStrip
      || outputY + height > this.options.height
      || data.length !== this.options.width * height * 3
    ) {
      throw new Error("GPU 导出条带必须连续、完整并与目标尺寸一致。");
    }
    const bytes = this.options.format === "jpeg"
      ? srgb16To8BitBuffer(data)
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    await this.rawHandle.write(bytes, 0, bytes.length, this.position);
    this.position += bytes.length;
    this.nextOutputY += height;
  }

  public async finish(): Promise<MasterExportWriteResult> {
    this.assertOpen();
    try {
      if (this.nextOutputY !== this.options.height) {
        throw new Error("尚未写完全部图像行，无法完成导出。");
      }
      this.closed = true;
      await this.rawHandle.close();
      const raw = await readFile(this.rawPath);
      const encoder = this.options.format === "jpeg"
        ? sharp(raw, {
            raw: { width: this.options.width, height: this.options.height, channels: 3 },
            limitInputPixels: false,
          })
        : sharp(
            new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / Uint16Array.BYTES_PER_ELEMENT),
            {
              raw: { width: this.options.width, height: this.options.height, channels: 3 },
              limitInputPixels: false,
            },
          ).toColourspace("rgb16");
      const encoderWithMetadata = encoder.withXmp(createDefaultXmp(
        this.options.processingMetadata,
        {
          colorSpace: "sRGB",
          transfer: "sRGB IEC 61966-2-1",
          bitDepth: this.options.format === "heif" ? 10 : 8,
        },
      ));
      const result = this.options.format === "jpeg"
        ? await encoderWithMetadata.withIccProfile("srgb").jpeg({
            quality: 95,
            chromaSubsampling: "4:4:4",
            progressive: true,
            mozjpeg: true,
          }).toFile(this.temporaryPath)
        : await encoderWithMetadata.withIccProfile("srgb").heif({
            compression: "av1",
            quality: 92,
            bitdepth: 10,
            chromaSubsampling: "4:4:4",
            effort: 5,
          }).toFile(this.temporaryPath);
      await rename(this.temporaryPath, this.options.outputPath);
      return {
        outputPath: this.options.outputPath,
        byteLength: result.size,
        bitDepth: this.options.format === "heif" ? 10 : 8,
        colorSpace: "sRGB",
      };
    } catch (error) {
      await this.cancel();
      throw error;
    } finally {
      // The raw sample file is only a staging artefact and must not survive
      // a successful export either.
      await rm(this.rawPath, { force: true });
    }
  }

  public async cancel(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      await this.rawHandle.close().catch(() => undefined);
    }
    await rm(this.temporaryPath, { force: true });
    await rm(this.rawPath, { force: true });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("导出会话已经关闭。");
  }
}

function srgb16To8BitBuffer(data: Uint16Array): Buffer {
  const output = Buffer.allocUnsafe(data.length);
  for (let index = 0; index < data.length; index += 1) {
    output[index] = Math.min(255, Math.round(data[index] / 257));
  }
  return output;
}
