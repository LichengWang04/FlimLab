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

export type PreviewWorkerRequest =
  | {
    kind: "register";
    id: string;
    width: number;
    height: number;
    raster: Float32Array<ArrayBuffer>;
  }
  | { kind: "process"; requestId: number; revision: number; id: string; recipe: Recipe }
  | {
    kind: "thumbnail";
    requestId: number;
    id: string;
    width: number;
    height: number;
    raster: Float32Array<ArrayBuffer>;
    recipe: Recipe;
  }
  | { kind: "release"; id: string }
  | { kind: "clear" };

export type PreviewWorkerResponse =
  | { kind: "preview"; requestId: number; revision: number; id: string; result: PreviewWorkerResult }
  | { kind: "thumbnail"; requestId: number; id: string; result: ThumbnailWorkerResult }
  | { kind: "error"; requestId: number; revision?: number; id: string; message: string; missingSource?: boolean };
