import type { BaseSample, DensityAnchors, Recipe, Rgb } from "../../../core/index.ts";

export type ProcessingBackend = "webgpu" | "cpu";

export interface GpuCapabilities {
  available: boolean;
  adapter: string;
  maxBufferSize: number;
  maxStorageBufferBindingSize: number;
  maxTextureDimension2D: number;
  sharedArrayBuffer: boolean;
  offscreenCanvas: boolean;
  reason?: string;
}

/** Shared memory improves source transport but is not required by WebGPU. */
export function evaluateWebGpuPrerequisites(
  sharedArrayBuffer: boolean,
  offscreenCanvas: boolean,
): Pick<GpuCapabilities, "available" | "sharedArrayBuffer" | "offscreenCanvas" | "reason"> {
  if (!offscreenCanvas) {
    return {
      available: false,
      sharedArrayBuffer,
      offscreenCanvas,
      reason: "OffscreenCanvas 不可用。",
    };
  }
  return { available: true, sharedArrayBuffer, offscreenCanvas };
}

export interface GpuDiagnostics {
  h2dBytes: number;
  d2hBytes: number;
  sourceUploads: number;
  dispatches: number;
  gpuMs: number;
  tileCount: number;
  fallbackReason?: string;
}

export interface GpuPreparation {
  base: BaseSample;
  anchors: DensityAnchors;
  whitePoint: number;
  gains: Rgb;
}

export type GpuWorkerRequest =
  | { kind: "probe"; requestId: number }
  | { kind: "attach"; requestId: number; canvas: OffscreenCanvas }
  | {
    kind: "register";
    requestId: number;
    id: string;
    width: number;
    height: number;
    raster: Float32Array;
  }
  | {
    kind: "render";
    requestId: number;
    revision: number;
    id: string;
    recipe: Recipe;
    preparation: GpuPreparation;
  }
  | { kind: "release"; requestId: number; id: string }
  | { kind: "clear"; requestId: number };

export type GpuWorkerResponse =
  | { kind: "capabilities"; requestId: number; capabilities: GpuCapabilities }
  | { kind: "attached"; requestId: number }
  | { kind: "registered"; requestId: number; id: string; diagnostics: GpuDiagnostics }
  | {
    kind: "rendered";
    requestId: number;
    revision: number;
    id: string;
    width: number;
    height: number;
    diagnostics: GpuDiagnostics;
  }
  | { kind: "released"; requestId: number; id?: string }
  | { kind: "device-lost"; message: string }
  | { kind: "error"; requestId: number; message: string };
