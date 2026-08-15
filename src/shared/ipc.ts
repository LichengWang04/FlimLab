/** IPC message shapes shared by main, preload and renderer. */
import type { Recipe } from "../core/types.ts";

export interface OpenedSource {
  fileName: string;
  width: number;
  height: number;
  depth: 8 | 16;
  hasIcc: boolean;
  /** Linear transmission samples (preview resolution), RGB packed. */
  raster: Float32Array;
}

export interface ExportRequest {
  format: "tiff" | "jpeg";
  recipe: Recipe;
}

export interface ExportResult {
  ok: boolean;
  /** Absolute path of the written file, when ok. */
  path?: string;
  /** Human-readable error message, when not ok. */
  message?: string;
}

export const IPC_CHANNELS = {
  openNegative: "negative:open",
  exportPositive: "positive:export",
} as const;
