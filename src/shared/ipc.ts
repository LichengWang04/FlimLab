/** IPC message shapes shared by main, preload and renderer. */
import type { Recipe } from "../core/types.ts";

export interface RollFrameInfo {
  /** Opaque id; the absolute source path never leaves the main process. */
  id: string;
  fileName: string;
}

export type RollOpenMode = "single" | "files" | "folder";

/** Preview resolution decode of one frame (<= 1600 px longest side). */
export interface RollPreview {
  id: string;
  fileName: string;
  width: number;
  height: number;
  depth: 8 | 16;
  hasIcc: boolean;
  /** Linear transmission samples, RGB packed. */
  raster: Float32Array;
}

/** Filmstrip thumbnail (<= 256 px longest side). */
export interface RollThumbnail {
  id: string;
  width: number;
  height: number;
  raster: Float32Array;
}

export interface RollExportRequest {
  /** Frames with their per-frame recipes, in export order. */
  frames: { id: string; recipe: Recipe }[];
  format: "tiff" | "jpeg";
}

export interface RollExportResult {
  ok: boolean;
  succeeded: { id: string; path: string }[];
  failed: { id: string; fileName: string; message: string }[];
  cancelled: boolean;
  /** Present when the export never started (dialog cancelled, no frames). */
  message?: string;
}

export interface RollExportProgress {
  done: number;
  total: number;
  fileName: string;
}

export interface SingleExportResult {
  ok: boolean;
  path?: string;
  message?: string;
}

export interface SingleExportRequest {
  id: string;
  recipe: Recipe;
  format: "tiff" | "jpeg";
}

export const IPC_CHANNELS = {
  rollOpen: "roll:open",
  rollPreview: "roll:preview",
  rollThumbnail: "roll:thumbnail",
  rollExport: "roll:export",
  rollExportSingle: "roll:export-single",
  rollExportCancel: "roll:export:cancel",
  rollExportProgress: "roll:export-progress",
} as const;
