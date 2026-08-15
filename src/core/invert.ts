import { Raster } from "./raster.ts";
import type { DensityAnchors, Recipe, Rgb } from "./types.ts";

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
  if (
    !Number.isFinite(recipe.preSaturation)
    || recipe.preSaturation < 0.5
    || recipe.preSaturation > 2
  ) {
    throw new Error("Pre-saturation must be finite and between 0.5 and 2.");
  }
  const fit = anchors.channelFit;
  if (
    fit !== undefined
    && (
      fit.slope.some((value) => !Number.isFinite(value) || value < 0.05 || value > 16)
      || fit.offset.some((value) => !Number.isFinite(value) || Math.abs(value) > 2)
    )
  ) {
    throw new Error("Channel fit slopes and offsets must be finite and valid.");
  }

  const scene = new Raster(density.width, density.height, "scene-linear-rgb");
  const source = density.data;
  const target = scene.data;
  const preSaturation = recipe.preSaturation;

  for (let offset = 0; offset < source.length; offset += 3) {
    const red = Math.max(0, source[offset]!);
    const green = Math.max(0, source[offset + 1]!);
    const blue = Math.max(0, source[offset + 2]!);
    // Density-domain saturation boost around the channel mean.
    const mean = (red + green + blue) / 3;
    const saturated: Rgb = [
      Math.max(0, mean + (red - mean) * preSaturation),
      Math.max(0, mean + (green - mean) * preSaturation),
      Math.max(0, mean + (blue - mean) * preSaturation),
    ];
    target[offset] = positive(saturated[0], fit, 0);
    target[offset + 1] = positive(saturated[1], fit, 1);
    target[offset + 2] = positive(saturated[2], fit, 2);
  }
  return scene;
}

function positive(density: number, fit: DensityAnchors["channelFit"], channel: number): number {
  const normalized = fit === undefined
    ? density
    : Math.min(Math.max((density - fit.offset[channel]!) / fit.slope[channel]!, 0), 4);
  return Math.max(0, Math.pow(10, normalized) - 1);
}
