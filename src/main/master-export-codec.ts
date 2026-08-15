import { mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { Worker, type WorkerOptions } from "node:worker_threads";

import type { MasterExportFormat } from "../shared/contracts.ts";
import {
  assertWithinTestWriteLimit,
  atomicTemporaryPath,
  removeStaleOutputArtifacts,
} from "./atomic-output.ts";
import {
  displayLinearToLinear16,
  displayLinearToSrgb16,
  StreamingSrgb16TiffWriter,
  writeDisplayLinearTiff,
} from "./tiff-codec.ts";

export interface StreamingMasterOptions {
  readonly outputPath: string;
  readonly format: MasterExportFormat;
  readonly width: number;
  readonly height: number;
  readonly rowsPerStrip: number;
  /** Extra provenance included in the default XMP packet. */
  readonly processingMetadata?: Readonly<Record<string, string | number | boolean>>;
  /** Deterministic ENOSPC injection used only by acceptance tests. */
  readonly testWriteLimitBytes?: number;
}

export interface DisplayLinearMasterOptions extends StreamingMasterOptions {
  /** Display-linear RGB samples straight from the tone stage. */
  readonly data: Float32Array;
}

export interface MasterExportResult {
  readonly outputPath: string;
  readonly byteLength: number;
  readonly bitDepth: 8 | 10 | 16;
  readonly colorSpace: "sRGB" | "linear-sRGB";
}

export interface StreamingMasterWriter {
  appendStrip(outputY: number, height: number, data: Uint16Array): Promise<void>;
  finish(): Promise<MasterExportResult>;
  cancel(): Promise<void>;
}

interface SharpEncodeWorkerData {
  readonly rawPath: string;
  readonly outputPath: string;
  readonly format: "jpeg" | "heif";
  readonly width: number;
  readonly height: number;
  readonly processingMetadata?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * 按格式选择流式写出器：TIFF/DNG 直接由 TIFF 写出器落盘，
 * JPEG/HEIF 先写原始条带、最后交由 Sharp 在 worker 线程中编码。
 */
export async function createStreamingMasterWriter(
  options: StreamingMasterOptions,
): Promise<StreamingMasterWriter> {
  if (options.format === "tiff" || options.format === "dng") {
    const writer = await StreamingSrgb16TiffWriter.create({
      outputPath: options.outputPath,
      width: options.width,
      height: options.height,
      rowsPerStrip: options.rowsPerStrip,
      container: options.format,
      processingMetadata: options.processingMetadata,
      testWriteLimitBytes: options.testWriteLimitBytes,
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

/**
 * 一次性导出完整 display-linear 位图：先在 CPU 完成传递函数转换，
 * 再按条带喂给流式写出器，失败时清理所有未发布的临时文件。
 */
export async function writeDisplayLinearMaster(
  options: DisplayLinearMasterOptions,
): Promise<MasterExportResult> {
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

/**
 * JPEG/HEIF 流式写出器。条带先以原始样本写入同目录临时文件，
 * finish 时再由编码 worker 一次性转成目标格式，避免主进程驻留整张位图。
 */
class SharpStreamingWriter implements StreamingMasterWriter {
  private readonly options: StreamingMasterOptions;
  private readonly temporaryPath: string;
  private readonly rawPath: string;
  private readonly rawHandle: FileHandle;
  private nextOutputY = 0;
  private position = 0;
  private closed = false;

  private constructor(
    options: StreamingMasterOptions,
    temporaryPath: string,
    rawPath: string,
    rawHandle: FileHandle,
  ) {
    this.options = options;
    this.temporaryPath = temporaryPath;
    this.rawPath = rawPath;
    this.rawHandle = rawHandle;
  }

  public static async create(options: StreamingMasterOptions): Promise<SharpStreamingWriter> {
    if (options.outputPath.trim().length === 0) throw new Error("导出路径不能为空。");
    const outputDirectory = dirname(options.outputPath);
    const temporaryPath = atomicTemporaryPath(options.outputPath);
    const rawPath = temporaryPath + ".raw";
    await mkdir(outputDirectory, { recursive: true });
    await removeStaleOutputArtifacts(options.outputPath);
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
    assertWithinTestWriteLimit(this.options.testWriteLimitBytes, this.position + bytes.length);
    await this.rawHandle.write(bytes, 0, bytes.length, this.position);
    this.position += bytes.length;
    this.nextOutputY += height;
  }

  public async finish(): Promise<MasterExportResult> {
    this.assertOpen();
    try {
      if (this.nextOutputY !== this.options.height) {
        throw new Error("尚未写完全部图像行，无法完成导出。");
      }
      this.closed = true;
      await this.rawHandle.sync();
      await this.rawHandle.close();
      const byteLength = await encodeSharpMasterInWorker({
        rawPath: this.rawPath,
        outputPath: this.temporaryPath,
        format: this.options.format === "jpeg" ? "jpeg" : "heif",
        width: this.options.width,
        height: this.options.height,
        processingMetadata: this.options.processingMetadata,
      });
      await rename(this.temporaryPath, this.options.outputPath);
      await syncDirectory(dirname(this.options.outputPath));
      return {
        outputPath: this.options.outputPath,
        byteLength,
        bitDepth: this.options.format === "heif" ? 10 : 8,
        colorSpace: "sRGB",
      };
    } catch (error) {
      await this.cancel();
      throw error;
    } finally {
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

/** JPEG 只接受 8-bit 输入；257 = 65535 / 255，保证端点映射精确。 */
function srgb16To8BitBuffer(data: Uint16Array): Buffer {
  const output = Buffer.allocUnsafe(data.length);
  for (let index = 0; index < data.length; index += 1) {
    output[index] = Math.min(255, Math.round(data[index] / 257));
  }
  return output;
}

/**
 * Sharp 大图编码容易顶到默认堆上限，因此放到独立 worker 线程，
 * 并放宽其老生代内存上限。
 */
async function encodeSharpMasterInWorker(options: SharpEncodeWorkerData): Promise<number> {
  const workerOptions: WorkerOptions = {
    workerData: options,
    resourceLimits: { maxOldGenerationSizeMb: 1024 },
  };
  const worker = createMasterEncoderWorker(workerOptions);
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    worker.once("message", (message: unknown) => {
      settled = true;
      if (typeof message === "object" && message !== null && "size" in message && typeof message.size === "number") {
        resolve(message.size);
      } else {
        reject(new Error(
          typeof message === "object" && message !== null && "error" in message && typeof message.error === "string"
            ? message.error
            : "图像编码线程返回了无效响应。",
        ));
      }
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (!settled) reject(new Error("图像编码线程未返回结果（退出代码 " + code + "）。"));
    });
  });
}

/**
 * rename 之后 fsync 目录，确保崩溃后目录项一定落盘。
 * Windows 等平台不支持目录 fsync，相关错误码按成功处理。
 */
async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error: unknown) {
    if (!hasCode(error, "EINVAL") && !hasCode(error, "EPERM") && !hasCode(error, "EACCES") && !hasCode(error, "ENOTSUP")) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}

export default function createMasterEncoderWorker(options: WorkerOptions): Worker {
  const workerEntry = import.meta.url.endsWith(".ts")
    ? "./master-encoder-worker.ts"
    : "./master-encoder-worker.cjs";
  return new Worker(new URL(workerEntry, import.meta.url), options);
}
