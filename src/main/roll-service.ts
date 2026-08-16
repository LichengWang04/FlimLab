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
import { decodeSource } from "./decode.ts";
import { renderPositive } from "./export.ts";

const PREVIEW_MAX_SIDE = 1600;
const THUMBNAIL_MAX_SIDE = 256;

const SUPPORTED_EXTENSIONS = new Set([".tif", ".tiff", ".jpg", ".jpeg", ".png"]);

/**
 * Roll of frames. The registry keeps the absolute source paths inside the
 * main process only; the renderer works with opaque ids and file names.
 * This module stays Electron-free so the batch logic is testable in plain
 * Node.
 */

const frames = new Map<string, string>();

export function registerFrames(paths: string[]): RollFrameInfo[] {
  frames.clear();
  const infos: RollFrameInfo[] = [];
  for (const path of paths) {
    const id = randomUUID();
    frames.set(id, path);
    infos.push({ id, fileName: basename(path) });
  }
  return infos;
}

export function framePath(id: string): string | null {
  return frames.get(id) ?? null;
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
  return {
    id,
    fileName: basename(path),
    width: raster.width,
    height: raster.height,
    depth: meta.depth,
    hasIcc: meta.hasIcc,
    raster: raster.data,
  };
}

export async function decodeRollThumbnail(id: string): Promise<RollThumbnail> {
  const path = await requireFramePath(id);
  const { raster } = await decodeSource(path, THUMBNAIL_MAX_SIDE);
  return { id, width: raster.width, height: raster.height, raster: raster.data };
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
): Promise<RollExportResult> {
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
    const result = await renderPositive(path, recipe, job.format, outPath);
    if (result.ok) {
      succeeded.push({ id, path: outPath });
    } else {
      failed.push({ id, fileName: basename(path), message: result.message ?? "未知错误。" });
    }
  }
  return { ok: true, succeeded, failed, cancelled: false };
}
