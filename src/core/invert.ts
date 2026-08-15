import { Raster } from "./raster.ts";
import type { DensityAnchors, Recipe, Rgb } from "./types.ts";

/**
 * Inverts relative density into scene-linear positive light.
 *
 * Without a per-channel range the transform is the conservative
 * 10^D - 1 relative transmission. With one (neutral ROI or heuristic), the
 * measured Dmax point lands on the same normalized density in every channel,
 * which removes the common blue/cyan cast of the orange mask. Normalized
 * density is capped at 4x the measured anchor: anything beyond is a specular
 * highlight that tone mapping will compress to display white anyway.
 */
export function invertDensity(
  density: Raster,
  anchors: DensityAnchors,
  recipe: Pick<Recipe, "whiteBalance" | "preSaturation">,
): Raster {
  density.assertDomain(["relative-density"]);
  const [wbRed, wbGreen, wbBlue] = recipe.whiteBalance;
  if (
    [wbRed, wbGreen, wbBlue].some((value) => !Number.isFinite(value) || value < 0)
    || !Number.isFinite(recipe.preSaturation)
    || recipe.preSaturation < 0.5
    || recipe.preSaturation > 2
  ) {
    throw new Error("White balance and pre-saturation must be finite and valid.");
  }
  const channelRange = anchors.channelRange;
  if (
    channelRange !== undefined
    && channelRange.some((value) => !Number.isFinite(value) || value < 0.05 || value > 16)
  ) {
    throw new Error("Channel density ranges must be finite and between 0.05 and 16 D.");
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
    target[offset] = positive(saturated[0], channelRange?.[0]) * wbRed;
    target[offset + 1] = positive(saturated[1], channelRange?.[1]) * wbGreen;
    target[offset + 2] = positive(saturated[2], channelRange?.[2]) * wbBlue;
  }
  return scene;
}

function positive(density: number, channelRange?: number): number {
  const normalized = channelRange === undefined
    ? density
    : Math.min(density / channelRange, 4);
  return Math.max(0, Math.pow(10, normalized) - 1);
}
