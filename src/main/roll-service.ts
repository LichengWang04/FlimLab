import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Recipe } from "../core/index.ts";
import type {
  RollExportProgress,
  RollExportResult,
  RollFrameInfo,
  RollPreview,
  RollThumbnail,
} from "../shared/ipc.ts";
import { decodeSource, decodeThumbnailSource } from "./decode.ts";
import { renderPositive } from "./export.ts";
import { MAX_ROLL_FRAMES } from "./resource-limits.ts";
import { ThumbnailDecodeQueue } from "./thumbnail-decode-queue.ts";

export type PositiveRenderer = typeof renderPositive;

const PREVIEW_MAX_SIDE = 1600;
const THUMBNAIL_MAX_SIDE = 256;

const SUPPORTED_EXTENSIONS = new Set([
  ".tif", ".tiff", ".jpg", ".jpeg", ".png", ".cr2", ".nef", ".rw2", ".arw",
]);

/**
 * Roll of frames. The registry keeps the absolute source paths inside the
 * main process only; the renderer works with opaque ids and file names.
 * This module stays Electron-free so the batch logic is testable in plain
 * Node.
 */

interface RegisteredFrame {
  path: string;
  generation: number;
}

const frames = new Map<string, RegisteredFrame>();
const thumbnailQueue = new ThumbnailDecodeQueue(2);
let frameGeneration = 0;

export function registerFrames(paths: string[]): RollFrameInfo[] {
  if (paths.length > MAX_ROLL_FRAMES) throw new Error(`整卷最多导入 ${MAX_ROLL_FRAMES} 帧。`);
  frameGeneration += 1;
  thumbnailQueue.cancelAll();
  frames.clear();
  const infos: RollFrameInfo[] = [];
  for (const path of paths) {
    const id = randomUUID();
    frames.set(id, { path, generation: frameGeneration });
    infos.push({ id, fileName: basename(path) });
  }
  return infos;
}

export function releaseFrame(id: string): boolean {
  thumbnailQueue.cancelKey(id);
  return frames.delete(id);
}

export function clearFrames(): void {
  frameGeneration += 1;
  thumbnailQueue.cancelAll();
  frames.clear();
}

export function framePath(id: string): string | null {
  return frames.get(id)?.path ?? null;
}

/** Scans a directory (non-recursive) for supported images, sorted by name. */
export async function scanFolder(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(dir, entry.name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

async function requireFramePath(id: string): Promise<string> {
  const path = framePath(id);
  if (path === null) throw new Error("帧不存在,请重新导入。");
  return path;
}

export async function decodeRollPreview(id: string): Promise<RollPreview> {
  const path = await requireFramePath(id);
  const { raster, meta } = await decodeSource(path, PREVIEW_MAX_SIDE);
  // Electron's invoke serializer cannot clone SharedArrayBuffer values from
  // main to renderer. Keep this IPC payload cloneable; the renderer promotes
  // it to one shared surface immediately after receipt.
  const ipcRaster = new Float32Array(raster.data);
  return {
    id,
    fileName: basename(path),
    width: raster.width,
    height: raster.height,
    depth: meta.depth,
    hasIcc: meta.hasIcc,
    format: meta.format,
    raster: ipcRaster,
  };
}

export async function decodeRollThumbnail(id: string): Promise<RollThumbnail> {
  const registered = frames.get(id);
  if (registered === undefined) throw new Error("帧不存在,请重新导入。");
  return thumbnailQueue.submit(
    id,
    () => frames.get(id) === registered && registered.generation === frameGeneration,
    async () => {
      const { raster } = await decodeThumbnailSource(registered.path, THUMBNAIL_MAX_SIDE);
      return { id, width: raster.width, height: raster.height, raster: raster.data };
    },
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sequential full-resolution export of every frame with its own recipe.
 * Frames are processed one at a time (memory peak equals one frame); a
 * failing frame is reported and does not stop the roll. Cancellation is
 * checked between frames so the in-flight file still publishes atomically.
 * Duplicate output stems get a -2, -3... suffix instead of overwriting.
 */
export async function exportRoll(
  job: { frames: { id: string; recipe: Recipe }[]; format: "tiff" | "jpeg"; outDir: string },
  onProgress: (progress: RollExportProgress) => void,
  isCancelled: () => boolean,
  render: PositiveRenderer = renderPositive,
): Promise<RollExportResult> {
  if (job.frames.length > MAX_ROLL_FRAMES) {
    return {
      ok: false,
      succeeded: [],
      failed: [],
      cancelled: false,
      message: `整卷最多导出 ${MAX_ROLL_FRAMES} 帧。`,
    };
  }
  const succeeded: RollExportResult["succeeded"] = [];
  const failed: RollExportResult["failed"] = [];
  const extension = job.format === "tiff" ? "tiff" : "jpg";

  for (let index = 0; index < job.frames.length; index += 1) {
    if (isCancelled()) {
      return { ok: true, succeeded, failed, cancelled: true };
    }
    const { id, recipe } = job.frames[index]!;
    const path = framePath(id);
    onProgress({ done: index, total: job.frames.length, fileName: path === null ? "" : basename(path) });
    if (path === null) {
      failed.push({ id, fileName: "", message: "帧不存在。" });
      continue;
    }
    const stem = basename(path).replace(/\.[^.]+$/, "");
    let outPath = join(job.outDir, `${stem}-positive.${extension}`);
    let counter = 2;
    while (await fileExists(outPath)) {
      outPath = join(job.outDir, `${stem}-positive-${counter}.${extension}`);
      counter += 1;
    }
    const result = await render(path, recipe, job.format, outPath);
    if (result.ok) {
      succeeded.push({ id, path: outPath });
    } else {
      failed.push({ id, fileName: basename(path), message: result.message ?? "未知错误。" });
    }
  }
  return { ok: true, succeeded, failed, cancelled: false };
}
