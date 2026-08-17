import type { BaseSample, DensityAnchors, Recipe, Rgb } from "../../core/index.ts";
import type { RollFrameInfo } from "../../shared/ipc.ts";
import type { ThumbnailWorkerResult } from "./preview-worker-protocol.ts";

export type DrawMode = "view" | "straighten" | "base-roi" | "neutral-roi" | "crop";
export type StraightenLine = { start: { x: number; y: number }; end: { x: number; y: number } };

export interface PreviewResult {
  rgba: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  base: BaseSample;
  anchors: DensityAnchors;
  whitePoint: number;
  autoGains?: Rgb;
  ms: number;
}

export interface FrameEntry {
  info: RollFrameInfo;
  thumbnail: { width: number; height: number; raster: Float32Array } | null;
  renderedThumbnail?: ThumbnailWorkerResult;
  status: "idle" | "exported" | "failed";
  failure?: string;
}

export function cloneRecipe(recipe: Recipe): Recipe {
  return {
    ...recipe,
    crop: recipe.crop === undefined ? undefined : { ...recipe.crop },
    baseRoi: recipe.baseRoi === undefined ? undefined : { ...recipe.baseRoi },
    neutralRoi: recipe.neutralRoi === undefined ? undefined : { ...recipe.neutralRoi },
  };
}
