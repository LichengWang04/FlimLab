import type {
  BaseSample,
  DensityAnchors,
  NegativeSessionStats,
  Recipe,
  Rgb,
} from "../../core/index.ts";

export interface PreviewWorkerResult {
  rgba: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  base: BaseSample;
  anchors: DensityAnchors;
  whitePoint: number;
  autoGains?: Rgb;
  ms: number;
  cacheStats: NegativeSessionStats;
}

export interface ThumbnailWorkerResult {
  rgba: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

export interface GpuPreparationWorkerResult {
  width: number;
  height: number;
  base: BaseSample;
  anchors: DensityAnchors;
  whitePoint: number;
  gains: Rgb;
  autoGains?: Rgb;
  ms: number;
  cacheStats: NegativeSessionStats;
}

export type PreviewWorkerRequest =
  | {
    kind: "register";
    id: string;
    width: number;
    height: number;
    raster: Float32Array<ArrayBufferLike>;
  }
  | { kind: "process"; requestId: number; revision: number; id: string; recipe: Recipe }
  | { kind: "prepare-gpu"; requestId: number; revision: number; id: string; recipe: Recipe }
  | {
    kind: "thumbnail";
    requestId: number;
    id: string;
    width: number;
    height: number;
    raster: Float32Array<ArrayBufferLike>;
    recipe: Recipe;
  }
  | { kind: "release"; id: string }
  | { kind: "clear" };

export type PreviewWorkerResponse =
  | { kind: "preview"; requestId: number; revision: number; id: string; result: PreviewWorkerResult }
  | { kind: "gpu-prepared"; requestId: number; revision: number; id: string; result: GpuPreparationWorkerResult }
  | { kind: "thumbnail"; requestId: number; id: string; result: ThumbnailWorkerResult }
  | { kind: "error"; requestId: number; revision?: number; id: string; message: string; missingSource?: boolean };
