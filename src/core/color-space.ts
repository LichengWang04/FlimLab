import { Raster } from "./raster.ts";
import type { LinearPrimaries, NegadoctorRecipe, Rgb, WorkingSpace } from "./types.ts";

// D65, 2-degree observer matrices derived from the published sRGB and
// Rec.2020 chromaticities. They are kept here as a single CPU source of truth.
const SRGB_TO_REC2020 = [
  0.627403895934699, 0.329283038377883, 0.043313065687418,
  0.069097289358232, 0.919540395075459, 0.011362315566309,
  0.01639143887515, 0.088013307877226, 0.895595253247624,
] as const;

const REC2020_TO_SRGB = [
  1.660491002108435, -0.58764113878855, -0.072849863319885,
  -0.124550474521591, 1.13289989712596, -0.008349422604369,
  -0.018150763354905, -0.100578898008008, 1.118729661362913,
] as const;

export function convertLinearRgb(rgb: Rgb, from: LinearPrimaries, to: LinearPrimaries): Rgb {
  if (from === to) return [...rgb];
  return multiply(rgb, from === "srgb" ? SRGB_TO_REC2020 : REC2020_TO_SRGB);
}

export function workingPrimaries(space: WorkingSpace): LinearPrimaries {
  return space === "linear-rec2020" ? "rec2020" : "srgb";
}

/** JPEG/PNG and supported camera RAW decoders produce linearized sRGB. Only
 * profile-less 16-bit TIFF may use the recipe's advanced primaries declaration. */
export function negadoctorInputPrimaries(recipe: NegadoctorRecipe, sourceFormat: string): LinearPrimaries {
  return sourceFormat.toLowerCase() === "tiff" ? recipe.inputPrimaries : "srgb";
}

export function convertRasterPrimaries(
  source: Raster,
  from: LinearPrimaries,
  to: LinearPrimaries,
  targetDomain: "transmission-linear" | "display-linear" = source.domain === "display-linear"
    ? "display-linear"
    : "transmission-linear",
): Raster {
  source.assertDomain(["transmission-linear", "display-linear"]);
  const target = new Raster(source.width, source.height, targetDomain);
  convertLinearRgbRange(source.data, target.data, 0, source.width * source.height, from, to, source.domain === "transmission-linear");
  return target;
}

export function convertLinearRgbRange(
  source: Float32Array,
  target: Float32Array,
  startPixel: number,
  endPixel: number,
  from: LinearPrimaries,
  to: LinearPrimaries,
  clampTransmission = false,
): void {
  if (from === to) {
    if (source !== target) target.set(source.subarray(startPixel * 3, endPixel * 3), startPixel * 3);
    if (clampTransmission) {
      for (let offset = startPixel * 3; offset < endPixel * 3; offset += 1) target[offset] = Math.max(0, target[offset]!);
    }
    return;
  }
  const matrix = from === "srgb" ? SRGB_TO_REC2020 : REC2020_TO_SRGB;
  for (let offset = startPixel * 3; offset < endPixel * 3; offset += 3) {
    const rgb: Rgb = [source[offset]!, source[offset + 1]!, source[offset + 2]!];
    const converted = multiply(rgb, matrix);
    target[offset] = clampTransmission ? Math.max(0, converted[0]) : converted[0];
    target[offset + 1] = clampTransmission ? Math.max(0, converted[1]) : converted[1];
    target[offset + 2] = clampTransmission ? Math.max(0, converted[2]) : converted[2];
  }
}

function multiply(rgb: Rgb, matrix: readonly number[]): Rgb {
  return [
    matrix[0]! * rgb[0] + matrix[1]! * rgb[1] + matrix[2]! * rgb[2],
    matrix[3]! * rgb[0] + matrix[4]! * rgb[1] + matrix[5]! * rgb[2],
    matrix[6]! * rgb[0] + matrix[7]! * rgb[1] + matrix[8]! * rgb[2],
  ];
}
