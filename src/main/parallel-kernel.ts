import {
  applyGainsRange,
  encode16Range,
  encode8Range,
  invertDensityRange,
  sampleGeometryRange,
  toRelativeDensityRange,
  toneMapEncode16Range,
  toneMapEncode8Range,
  toneMapRange,
} from "../core/index.ts";
import type { DensityAnchors, GeometryPlan, Recipe, Rgb } from "../core/index.ts";

export type KernelAction = "geometry" | "density" | "invert" | "gains" | "tone" | "encode8" | "encode16" | "toneEncode8" | "toneEncode16";

export interface KernelTask {
  taskId: number;
  action: KernelAction;
  startPixel: number;
  endPixel: number;
  pixels: SharedArrayBuffer;
  source?: SharedArrayBuffer;
  geometryPlan?: GeometryPlan;
  output?: SharedArrayBuffer;
  base?: Rgb;
  anchors?: DensityAnchors;
  preSaturation?: number;
  gains?: Rgb;
  recipe?: Recipe;
  whitePoint?: number;
}

export function executeKernelTask(task: KernelTask): void {
  const pixels = new Float32Array(task.pixels);
  if (task.action === "geometry") {
    if (task.source === undefined || task.geometryPlan === undefined) {
      throw new Error("Geometry task is missing its source or sampling plan.");
    }
    sampleGeometryRange(
      new Float32Array(task.source),
      pixels,
      task.startPixel,
      task.endPixel,
      task.geometryPlan,
    );
    return;
  }
  if (task.action === "density") {
    if (task.base === undefined) throw new Error("Density task is missing film-base values.");
    toRelativeDensityRange(pixels, pixels, task.startPixel, task.endPixel, task.base);
    return;
  }
  if (task.action === "invert") {
    if (task.anchors === undefined || task.preSaturation === undefined) {
      throw new Error("Inversion task is missing density parameters.");
    }
    invertDensityRange(pixels, pixels, task.startPixel, task.endPixel, task.anchors, task.preSaturation);
    return;
  }
  if (task.action === "gains") {
    if (task.gains === undefined) throw new Error("Gain task is missing channel gains.");
    applyGainsRange(pixels, pixels, task.startPixel, task.endPixel, task.gains);
    return;
  }
  if (task.action === "tone") {
    if (task.recipe === undefined || task.whitePoint === undefined) {
      throw new Error("Tone task is missing display parameters.");
    }
    toneMapRange(pixels, pixels, task.startPixel, task.endPixel, task.recipe, task.whitePoint);
    return;
  }
  if (task.output === undefined) throw new Error("Encoding task is missing its output buffer.");
  if (task.action === "toneEncode8" || task.action === "toneEncode16") {
    if (task.recipe === undefined || task.whitePoint === undefined) {
      throw new Error("Fused tone/encoding task is missing display parameters.");
    }
    if (task.action === "toneEncode8") {
      toneMapEncode8Range(
        pixels,
        new Uint8Array(task.output),
        task.startPixel,
        task.endPixel,
        task.recipe,
        task.whitePoint,
      );
    } else {
      toneMapEncode16Range(
        pixels,
        new Uint16Array(task.output),
        task.startPixel,
        task.endPixel,
        task.recipe,
        task.whitePoint,
      );
    }
    return;
  }
  const start = task.startPixel * 3;
  const end = task.endPixel * 3;
  if (task.action === "encode8") {
    encode8Range(pixels, new Uint8Array(task.output), start, end);
  } else {
    encode16Range(pixels, new Uint16Array(task.output), start, end);
  }
}
