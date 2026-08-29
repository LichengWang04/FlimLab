import { createGeometryPlan } from "../../../core/index.ts";
import type { DensityCurve, Recipe, Rgb } from "../../../core/index.ts";
import type { GpuPreparation } from "./protocol.ts";
import { PARAM_FLOATS } from "./shader.ts";

export interface WebGpuRenderParameters {
  values: Float32Array<ArrayBuffer>;
  width: number;
  height: number;
}

export function createWebGpuRenderParameters(
  sourceWidth: number,
  sourceHeight: number,
  recipe: Recipe,
  preparation: GpuPreparation,
): WebGpuRenderParameters {
  const geometry = createGeometryPlan(sourceWidth, sourceHeight, recipe.rotate, recipe.crop);
  const values = new Float32Array(PARAM_FLOATS);
  values[0] = sourceWidth;
  values[1] = sourceHeight;
  values[2] = geometry.width;
  values[3] = geometry.height;
  values[4] = geometry.quarter / 90;
  values[5] = geometry.residualRadians;
  values[6] = geometry.orientedWidth;
  values[7] = geometry.orientedHeight;
  values[8] = geometry.rotatedWidth;
  values[9] = geometry.rotatedHeight;
  values[10] = geometry.cropX;
  values[11] = geometry.cropY;

  values[16] = preparation.base.rgb[0];
  values[17] = preparation.base.rgb[1];
  values[18] = preparation.base.rgb[2];

  if (recipe.engine === "classic") {
    values[12] = 0;
    const fit = preparation.anchors.channelFit;
    values[19] = fit === undefined ? 0 : 1;
    writeRgb(values, 20, fit?.offset ?? [0, 0, 0]);
    writeRgb(values, 23, fit?.slope ?? [1, 1, 1]);
    const curves = preparation.anchors.channelCurves;
    values[26] = curves === undefined ? 0 : 1;
    if (curves !== undefined) curves.forEach((curve, channel) => writeCurve(values, 64 + channel * 27, curve));
    values[27] = recipe.preSaturation;
    writeRgb(values, 28, preparation.gains);
    values[31] = preparation.whitePoint;
    values[32] = recipe.exposure;
    values[33] = recipe.contrast;
    values[34] = recipe.highlightCompression;
    values[35] = recipe.saturation;
  } else {
    values[12] = 1;
    values[13] = recipe.filmStock === "black-and-white" ? 1 : 0;
    values[14] = recipe.inputPrimaries === "rec2020" ? 1 : 0;
    values[15] = recipe.workingSpace === "linear-rec2020" ? 1 : 0;
    writeRgb(values, 36, preparation.base.rgb);
    values[39] = recipe.dmax;
    values[40] = recipe.scanExposureBias;
    writeRgb(values, 41, recipe.shadowCastRgb);
    writeRgb(values, 44, recipe.highlightBalanceRgb);
    values[47] = recipe.paperBlack;
    values[48] = recipe.paperGrade;
    values[49] = recipe.paperGloss;
    values[50] = recipe.printExposure;
  }
  return { values, width: geometry.width, height: geometry.height };
}

function writeRgb(values: Float32Array, start: number, rgb: Rgb): void {
  values[start] = rgb[0];
  values[start + 1] = rgb[1];
  values[start + 2] = rgb[2];
}

// Slot layout must stay in sync with curve_value in shader.ts (stride 27:
// [count][13 inputs][13 outputs]). A fitted monotone curve carries up to
// twelve bin medians plus the physical-origin anchor — thirteen points.
function writeCurve(values: Float32Array, start: number, curve: DensityCurve): void {
  const count = Math.min(13, curve.input.length, curve.output.length);
  values[start] = count;
  for (let index = 0; index < count; index += 1) {
    values[start + 1 + index] = curve.input[index]!;
    values[start + 14 + index] = curve.output[index]!;
  }
}
