import { constants, promises as fs } from "node:fs";
import { dirname } from "node:path";

export const MAX_SOURCE_FILE_BYTES = 1024 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 32_768;
export const MAX_IMAGE_PIXELS = 100_000_000;
export const MAX_FLOAT_RASTER_BYTES = 1_200_000_000;
export const MAX_TIFF_STRIPS = 65_536;
export const MAX_TIFF_STRIP_BYTES = 256 * 1024 * 1024;
export const MAX_ROLL_FRAMES = 500;
const EXPORT_RESERVE_BYTES = 64 * 1024 * 1024;

export async function assertSourceFile(path: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("源图像不存在，可能已被移动或删除。");
    throw error;
  }
  if (!stat.isFile()) throw new Error("所选路径不是可读取的图像文件。");
  if (stat.size < 1) throw new Error("图像文件为空。");
  if (stat.size > MAX_SOURCE_FILE_BYTES) {
    throw new Error(`图像文件超过 ${formatMiB(MAX_SOURCE_FILE_BYTES)} MiB 的安全上限。`);
  }
}

export function assertImageDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("图像尺寸无效。");
  }
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
    throw new Error(`图像最长边超过 ${MAX_IMAGE_EDGE.toLocaleString()} 像素的安全上限。`);
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_IMAGE_PIXELS) {
    throw new Error(`图像超过 ${(MAX_IMAGE_PIXELS / 1_000_000).toFixed(0)} MP 的安全上限。`);
  }
  const floatBytes = pixels * 3 * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(floatBytes) || floatBytes > MAX_FLOAT_RASTER_BYTES) {
    throw new Error("图像解码后的内存需求超过安全上限。");
  }
}

export function assertTiffStrips(offsets: readonly number[], counts: readonly number[]): void {
  if (offsets.length !== counts.length || offsets.length < 1) {
    throw new Error("TIFF 条带偏移与长度不匹配。");
  }
  if (offsets.length > MAX_TIFF_STRIPS) {
    throw new Error(`TIFF 条带数量超过 ${MAX_TIFF_STRIPS.toLocaleString()} 的安全上限。`);
  }
  for (const count of counts) {
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_TIFF_STRIP_BYTES) {
      throw new Error(`TIFF 单条带超过 ${formatMiB(MAX_TIFF_STRIP_BYTES)} MiB 的安全上限。`);
    }
  }
}

export async function assertExportCapacity(
  outPath: string,
  width: number,
  height: number,
  format: "tiff" | "jpeg",
): Promise<void> {
  assertImageDimensions(width, height);
  const directory = dirname(outPath);
  await fs.access(directory, constants.W_OK);
  const pixels = width * height;
  const expected = pixels * (format === "tiff" ? 6 : 3) + EXPORT_RESERVE_BYTES;
  try {
    const stats = await fs.statfs(directory);
    const available = stats.bavail * stats.bsize;
    if (Number.isFinite(available) && available < expected) {
      throw new Error(`目标磁盘空间不足，至少需要约 ${formatMiB(expected)} MiB 可用空间。`);
    }
  } catch (error) {
    // Unsupported statfs should not block export; a real low-space result is
    // our own message and must be preserved.
    if (error instanceof Error && error.message.includes("目标磁盘空间不足")) throw error;
  }
}

export function friendlyProcessingError(error: unknown): string {
  if (error instanceof RangeError || (error instanceof Error && /allocation|array buffer|out of memory/i.test(error.message))) {
    return "处理图像时内存不足。请关闭其他程序、减小图像尺寸或分批导出。";
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOSPC") return "目标磁盘空间不足，导出未完成。";
  if (code === "ENOENT") return "目标文件夹不存在，请重新选择导出位置。";
  if (code === "EISDIR") return "导出目标必须是文件，不能是文件夹。";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return "目标位置不可写，请选择其他文件夹或检查权限。";
  }
  return error instanceof Error ? error.message : String(error);
}

function formatMiB(bytes: number): string {
  return Math.ceil(bytes / (1024 * 1024)).toLocaleString();
}
