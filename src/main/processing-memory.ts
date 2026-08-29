import { freemem, totalmem } from "node:os";

const RGB_FLOAT_BYTES = 3 * Float32Array.BYTES_PER_ELEMENT;
const TIFF_STRIP_SCRATCH_BYTES = 256 * 1024 * 1024;
const RAW_WASM_BASE_BYTES = 256 * 1024 * 1024;
const SYSTEM_RESERVE_BYTES = 512 * 1024 * 1024;

export interface ProcessingMemoryInput {
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  sourceDepth: 8 | 16;
  sourceFormat: string;
  format: "tiff" | "jpeg";
  identityGeometry: boolean;
}

export interface ProcessingMemoryEstimate {
  peakBytes: number;
  requiredFreeBytes: number;
}

export function estimateProcessingMemory(input: ProcessingMemoryInput): ProcessingMemoryEstimate {
  const sourcePixels = input.sourceWidth * input.sourceHeight;
  const targetPixels = input.targetWidth * input.targetHeight;
  const sourceRaster = sourcePixels * RGB_FLOAT_BYTES;
  const geometryTarget = input.identityGeometry ? 0 : targetPixels * RGB_FLOAT_BYTES;
  const encodedOutput = targetPixels * (input.format === "tiff" ? 6 : 3);
  const sourceFormat = input.sourceFormat.toLowerCase();
  const rawSource = sourceFormat === "cr2" || sourceFormat === "nef" || sourceFormat === "rw2" || sourceFormat === "arw";
  const decodeScratch = sourceFormat === "tiff"
    ? Math.min(TIFF_STRIP_SCRATCH_BYTES, sourcePixels * (input.sourceDepth === 16 ? 6 : 3))
    : rawSource
      ? RAW_WASM_BASE_BYTES + sourcePixels * 8
      : sourcePixels * (input.sourceDepth === 16 ? 6 : 3);
  const peakBytes = sourceRaster + geometryTarget + encodedOutput + decodeScratch;
  return { peakBytes, requiredFreeBytes: peakBytes + SYSTEM_RESERVE_BYTES };
}

export function assertProcessingMemory(
  input: ProcessingMemoryInput,
  memory: { total: number; free: number } = { total: totalmem(), free: freemem() },
): ProcessingMemoryEstimate {
  const estimate = estimateProcessingMemory(input);
  if (estimate.peakBytes > memory.total * 0.75 || estimate.requiredFreeBytes > memory.free) {
    throw new Error(
      `处理该图像预计需要约 ${formatGiB(estimate.requiredFreeBytes)} GiB 可用内存，当前资源不足。请关闭其他程序、减小图像尺寸或减少旋转裁剪。`,
    );
  }
  return estimate;
}

function formatGiB(bytes: number): string {
  return (bytes / (1024 ** 3)).toFixed(1);
}
