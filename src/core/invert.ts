import { Raster } from "./raster.ts";
import { applyDensityCurve } from "./density.ts";
import type { DensityAnchors, DensityCurve, Recipe } from "./types.ts";

/**
 * Inverts relative density into scene-linear positive light, before any
 * white-balance gain (manual or automatic).
 *
 * Without a channel fit the transform is the conservative 10^D - 1 relative
 * transmission. With one (fitted from neutral pixels, a drawn neutral ROI,
 * or the neutral-tail fallback), each channel is normalized through the
 * affine model (D - offset) / slope, which keeps neutrals neutral across
 * the whole tonal range and removes the blue/cyan cast of the orange mask
 * and residual base-sampling offsets. Normalized density is capped at 4x:
 * anything beyond is a specular highlight that tone mapping will compress
 * to display white anyway.
 */
export function invertDensity(
  density: Raster,
  anchors: DensityAnchors,
  recipe: Pick<Recipe, "preSaturation">,
): Raster {
  density.assertDomain(["relative-density"]);
  validateInvertParameters(anchors, recipe.preSaturation);
  const scene = new Raster(density.width, density.height, "scene-linear-rgb");
  invertDensityRange(
    density.data,
    scene.data,
    0,
    density.width * density.height,
    anchors,
    recipe.preSaturation,
  );
  return scene;
}

export function validateInvertParameters(anchors: DensityAnchors, preSaturation: number): void {
  if (
    !Number.isFinite(preSaturation)
    || preSaturation < 0.5
    || preSaturation > 2
  ) {
    throw new Error("Pre-saturation must be finite and between 0.5 and 2.");
  }
  const fit = anchors.channelFit;
  const curves = anchors.channelCurves;
  if (
    fit !== undefined
    && (
      fit.slope.some((value) => !Number.isFinite(value) || value < 0.05 || value > 16)
      || fit.offset.some((value) => !Number.isFinite(value) || Math.abs(value) > 2)
    )
  ) {
    throw new Error("Channel fit slopes and offsets must be finite and valid.");
  }
  if (curves !== undefined && (fit === undefined || curves.some((curve) => !validCurve(curve)))) {
    throw new Error("Density curves must be finite, monotone, and paired with a channel fit.");
  }
}

/** Pixel-independent inversion kernel; validation is performed by the caller. */
export function invertDensityRange(
  source: Float32Array,
  target: Float32Array,
  startPixel: number,
  endPixel: number,
  anchors: DensityAnchors,
  preSaturation: number,
): void {
  const fit = anchors.channelFit;
  const curves = anchors.channelCurves;
  for (let offset = startPixel * 3; offset < endPixel * 3; offset += 3) {
    // Remove the fitted film response before the creative density-domain
    // saturation. Doing this in the opposite order amplifies the mask cast.
    const red = normalizeDensity(Math.max(0, source[offset]!), fit, curves, 0);
    const green = normalizeDensity(Math.max(0, source[offset + 1]!), fit, curves, 1);
    const blue = normalizeDensity(Math.max(0, source[offset + 2]!), fit, curves, 2);
    const mean = (red + green + blue) / 3;
    const saturatedRed = Math.max(0, mean + (red - mean) * preSaturation);
    const saturatedGreen = Math.max(0, mean + (green - mean) * preSaturation);
    const saturatedBlue = Math.max(0, mean + (blue - mean) * preSaturation);
    target[offset] = positive(saturatedRed);
    target[offset + 1] = positive(saturatedGreen);
    target[offset + 2] = positive(saturatedBlue);
  }
}

function normalizeDensity(
  density: number,
  fit: DensityAnchors["channelFit"],
  curves: DensityAnchors["channelCurves"],
  channel: 0 | 1 | 2,
): number {
  const affine = fit === undefined
    ? density
    : (density - fit.offset[channel]) / fit.slope[channel];
  const curved = curves === undefined ? affine : applyDensityCurve(affine, curves[channel]);
  return Math.min(Math.max(curved, 0), 4);
}

function validCurve(curve: DensityCurve): boolean {
  return curve.input.length >= 2
    && curve.input.length === curve.output.length
    && curve.input.every((value, index) => (
      Number.isFinite(value) && (index === 0 || value > curve.input[index - 1]!)
    ))
    && curve.output.every((value, index) => (
      Number.isFinite(value) && (index === 0 || value >= curve.output[index - 1]!)
    ));
}

function positive(density: number): number {
  return Math.max(0, Math.pow(10, density) - 1);
}
