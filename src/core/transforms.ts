import { computeCurveDomainScale, samplePreparedMonotonicCurve, validateMonotonicCurve } from "./curves.ts";
import { Raster } from "./raster.ts";
import type {
  CalibrationProfile,
  FilmMode,
  FilmPreset,
  Lut3d,
  Matrix3,
  Rgb,
} from "./types.ts";

const ONE: Rgb = [1, 1, 1];

/** Shared with the WebGL prepareFilm default so a film mode that omits the
 * control behaves identically on the CPU and GPU paths. */
export const DEFAULT_PRE_SATURATION = 1.08;

/**
 * Applies the selected inversion mode. `densityRange` is the measured
 * Dmax−Dmin of the delivered frame; preset curves are resampled onto it so
 * flat and dense negatives both use the full curve, while calibrated
 * profiles keep their absolute density domain (that domain is the
 * device-match claim and must not follow frame content).
 */
export function applyFilmTransform(
  density: Raster,
  mode: FilmMode,
  densityRange?: number,
  densityChannelRange?: Rgb,
): Raster {
  density.assertDomain("relative-density");
  switch (mode.kind) {
    case "generic":
      return applyGenericTransform(
        density,
        mode.densityGain ?? ONE,
        mode.whiteBalance ?? ONE,
        densityChannelRange,
        mode.densityMatrix,
        mode.preSaturation,
      );
    case "calibrated":
      return applyCalibratedTransform(density, mode.profile, mode.whiteBalance ?? ONE);
  }
}

export function applyGenericTransform(
  density: Raster,
  densityGain: Rgb = ONE,
  whiteBalance: Rgb = ONE,
  densityChannelRange?: Rgb,
  densityMatrix?: Matrix3,
  preSaturation = DEFAULT_PRE_SATURATION,
): Raster {
  density.assertDomain("relative-density");
  validateRgb(densityGain, "densityGain");
  validateRgb(whiteBalance, "whiteBalance");
  if (densityChannelRange !== undefined) validateDensityChannelRange(densityChannelRange);
  if (densityMatrix !== undefined) validateMatrix(densityMatrix);
  if (!Number.isFinite(preSaturation) || preSaturation < 0.5 || preSaturation > 2) {
    throw new Error("preSaturation must be finite and between 0.5 and 2.");
  }

  const target = new Raster(density.width, density.height, "scene-linear-rgb");
  for (let offset = 0; offset < density.data.length; offset += 3) {
    const source: Rgb = [
      Math.max(0, density.data[offset]),
      Math.max(0, density.data[offset + 1]),
      Math.max(0, density.data[offset + 2]),
    ];
    const corrected = densityMatrix === undefined ? source : clampDensity(multiplyMatrix(densityMatrix, source));
    const mean = (corrected[0] + corrected[1] + corrected[2]) / 3;
    const separated: Rgb = [
      Math.max(0, mean + (corrected[0] - mean) * preSaturation),
      Math.max(0, mean + (corrected[1] - mean) * preSaturation),
      Math.max(0, mean + (corrected[2] - mean) * preSaturation),
    ];
    target.data[offset] = genericPositive(separated[0], densityGain[0], densityChannelRange?.[0]) * whiteBalance[0];
    target.data[offset + 1] = genericPositive(separated[1], densityGain[1], densityChannelRange?.[1]) * whiteBalance[1];
    target.data[offset + 2] = genericPositive(separated[2], densityGain[2], densityChannelRange?.[2]) * whiteBalance[2];
  }
  return target;
}

/**
 * A neutral high-density reference supplies a per-channel H&D scale for the
 * uncalibrated path. Without it, the generic inverse is intentionally the
 * conservative relative-transmission transform. With it, the sampled Dmax
 * point lands on the same normalized density in all channels, which removes
 * the common blue/cyan shadow cast without pretending to be a camera profile.
 */
function genericPositive(density: number, gain: number, channelRange?: number): number {
  const nonNegativeDensity = Math.max(0, density);
  // Cap the normalized density so a poorly sampled Dmax ROI (near-zero
  // channel range) cannot amplify highlights by orders of magnitude: the
  // worst case stays at 10^4-1, below the pre-anchor path's 10^6 ceiling.
  // Pixels beyond 4x the measured anchor are speculars that tone mapping
  // will compress to display white anyway.
  const normalizedDensity = channelRange === undefined
    ? nonNegativeDensity
    : Math.min(nonNegativeDensity / channelRange, 4);
  return Math.max(0, Math.pow(10, normalizedDensity * gain) - 1);
}

function clampDensity(value: Rgb): Rgb {
  return [Math.max(0, value[0]), Math.max(0, value[1]), Math.max(0, value[2])];
}

export function applyPresetTransform(
  density: Raster,
  preset: FilmPreset,
  whiteBalance: Rgb = ONE,
  densityRange?: number,
): Raster {
  density.assertDomain("relative-density");
  validateRgb(whiteBalance, "whiteBalance");
  validateMatrix(preset.matrix);
  validateMonotonicCurve(preset.curves[0]);
  validateMonotonicCurve(preset.curves[1]);
  validateMonotonicCurve(preset.curves[2]);

  const domainScale = computeCurveDomainScale(preset.curves, densityRange);
  const target = new Raster(density.width, density.height, "scene-linear-rgb");
  const matrix = preset.matrix;
  for (let offset = 0; offset < density.data.length; offset += 3) {
    const red = samplePreparedMonotonicCurve(preset.curves[0], density.data[offset] * domainScale[0]);
    const green = samplePreparedMonotonicCurve(preset.curves[1], density.data[offset + 1] * domainScale[1]);
    const blue = samplePreparedMonotonicCurve(preset.curves[2], density.data[offset + 2] * domainScale[2]);
    // Cross-talk matrices have negative off-diagonal terms, so saturated
    // colours can leave the display gamut here. Clamping to zero at the
    // inversion stage keeps out-of-gamut values from propagating into tone
    // mapping, where they would otherwise be clipped per channel at encode
    // time with a visible hue shift.
    target.data[offset] = Math.max(0, matrix[0][0] * red + matrix[0][1] * green + matrix[0][2] * blue) * whiteBalance[0];
    target.data[offset + 1] = Math.max(0, matrix[1][0] * red + matrix[1][1] * green + matrix[1][2] * blue) * whiteBalance[1];
    target.data[offset + 2] = Math.max(0, matrix[2][0] * red + matrix[2][1] * green + matrix[2][2] * blue) * whiteBalance[2];
  }
  return target;
}

export function applyCalibratedTransform(
  density: Raster,
  profile: CalibrationProfile,
  whiteBalance: Rgb = ONE,
): Raster {
  validateRgb(whiteBalance, "whiteBalance");
  // White balance is applied before the 3D LUT so the LUT samples an
  // already-balanced scene-linear signal; multiplying after the LUT would
  // rescale its non-linear output and break the fitted response.
  const transformed = applyPresetTransform(density, profile, whiteBalance);
  if (profile.lut === undefined) {
    return transformed;
  }

  validateLut(profile.lut);
  const target = new Raster(transformed.width, transformed.height, "scene-linear-rgb");
  for (let offset = 0; offset < transformed.data.length; offset += 3) {
    const result = samplePreparedLut3d(profile.lut, [
      transformed.data[offset],
      transformed.data[offset + 1],
      transformed.data[offset + 2],
    ]);
    target.data[offset] = result[0];
    target.data[offset + 1] = result[1];
    target.data[offset + 2] = result[2];
  }
  return target;
}

export function multiplyMatrix(matrix: Matrix3, value: Rgb): Rgb {
  return [
    dot(matrix[0], value),
    dot(matrix[1], value),
    dot(matrix[2], value),
  ];
}

export function sampleLut3d(lut: Lut3d, value: Rgb): Rgb {
  validateLut(lut);
  return samplePreparedLut3d(lut, value);
}

function samplePreparedLut3d(lut: Lut3d, value: Rgb): Rgb {
  const domainMin = lut.domainMin ?? [0, 0, 0];
  const domainMax = lut.domainMax ?? [1, 1, 1];
  const position: Rgb = [
    normalizeLutCoordinate(value[0], domainMin[0], domainMax[0], lut.size),
    normalizeLutCoordinate(value[1], domainMin[1], domainMax[1], lut.size),
    normalizeLutCoordinate(value[2], domainMin[2], domainMax[2], lut.size),
  ];

  const low: Rgb = [
    Math.floor(position[0]),
    Math.floor(position[1]),
    Math.floor(position[2]),
  ];
  const high: Rgb = [
    Math.min(low[0] + 1, lut.size - 1),
    Math.min(low[1] + 1, lut.size - 1),
    Math.min(low[2] + 1, lut.size - 1),
  ];
  const fraction: Rgb = [
    position[0] - low[0],
    position[1] - low[1],
    position[2] - low[2],
  ];

  const c000 = lutValue(lut, low[0], low[1], low[2]);
  const c100 = lutValue(lut, high[0], low[1], low[2]);
  const c010 = lutValue(lut, low[0], high[1], low[2]);
  const c110 = lutValue(lut, high[0], high[1], low[2]);
  const c001 = lutValue(lut, low[0], low[1], high[2]);
  const c101 = lutValue(lut, high[0], low[1], high[2]);
  const c011 = lutValue(lut, low[0], high[1], high[2]);
  const c111 = lutValue(lut, high[0], high[1], high[2]);

  const c00 = lerpRgb(c000, c100, fraction[0]);
  const c10 = lerpRgb(c010, c110, fraction[0]);
  const c01 = lerpRgb(c001, c101, fraction[0]);
  const c11 = lerpRgb(c011, c111, fraction[0]);
  const c0 = lerpRgb(c00, c10, fraction[1]);
  const c1 = lerpRgb(c01, c11, fraction[1]);
  return lerpRgb(c0, c1, fraction[2]);
}

function dot(left: Rgb, right: Rgb): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function validateRgb(value: Rgb, name: string): void {
  if (value.some((channel) => !Number.isFinite(channel) || channel < 0)) {
    throw new Error(name + " must contain finite, non-negative values.");
  }
}

function validateDensityChannelRange(value: Rgb): void {
  if (value.some((channel) => !Number.isFinite(channel) || channel < 0.05 || channel > 16)) {
    throw new Error("densityChannelRange must contain finite values between 0.05 and 16 D.");
  }
}

function validateMatrix(matrix: Matrix3): void {
  matrix.forEach((row) => {
    if (row.some((value) => !Number.isFinite(value))) {
      throw new Error("Film matrix values must be finite.");
    }
  });
}

function validateLut(lut: Lut3d): void {
  if (!Number.isInteger(lut.size) || lut.size < 2) {
    throw new Error("3D LUT size must be an integer of at least two.");
  }
  if (lut.data.length !== lut.size * lut.size * lut.size * 3) {
    throw new Error("3D LUT data length does not match its declared size.");
  }
  if (lut.domainMin !== undefined) {
    validateFiniteRgb(lut.domainMin, "LUT domainMin");
  }
  if (lut.domainMax !== undefined) {
    validateFiniteRgb(lut.domainMax, "LUT domainMax");
  }
}

function normalizeLutCoordinate(value: number, min: number, max: number, size: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    throw new Error("3D LUT coordinates need finite, ascending domain limits.");
  }
  const normalized = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return normalized * (size - 1);
}

function lutValue(lut: Lut3d, red: number, green: number, blue: number): Rgb {
  const offset = (((red * lut.size + green) * lut.size + blue) * 3);
  return [lut.data[offset], lut.data[offset + 1], lut.data[offset + 2]];
}

function lerpRgb(left: Rgb, right: Rgb, amount: number): Rgb {
  return [
    left[0] + (right[0] - left[0]) * amount,
    left[1] + (right[1] - left[1]) * amount,
    left[2] + (right[2] - left[2]) * amount,
  ];
}

function validateFiniteRgb(value: Rgb, name: string): void {
  if (value.some((channel) => !Number.isFinite(channel))) {
    throw new Error(name + " must contain finite values.");
  }
}
