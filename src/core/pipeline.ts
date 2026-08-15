import { toRelativeDensity, measureDensityAnchors } from "./density.ts";
import { estimateFilmBase, sampleFilmBase } from "./film-base.ts";
import { cropRaster, rotateRaster } from "./geometry.ts";
import { invertDensity } from "./invert.ts";
import { Raster } from "./raster.ts";
import { toneMap } from "./tone.ts";
import type { BaseSample, DensityAnchors, Recipe } from "./types.ts";

/** Result of the full negative-to-positive pipeline. */
export interface NegativeResult {
  /** Final display-linear positive (still linear light). */
  display: Raster;
  base: BaseSample;
  anchors: DensityAnchors;
  /** Scene-linear value that was normalized to display white. */
  whitePoint: number;
}

/**
 * The complete negative-to-positive pipeline:
 *
 *   transmission-linear
 *   → 90° rotation → crop
 *   → film base (border ROI or automatic envelope estimate)
 *   → relative density
 *   → Dmin/Dmax anchors (+ optional per-channel neutral range)
 *   → inversion to scene-linear positive light
 *   → exposure / contrast / highlight compression / saturation
 *   → white-point normalization → display-linear
 *
 * The display raster is still linear light; the renderer and exporter apply
 * the sRGB OETF when quantizing.
 */
export function processNegative(source: Raster, recipe: Recipe): NegativeResult {
  source.assertDomain(["transmission-linear"]);

  const rotated = rotateRaster(source, recipe.rotate);
  const framed = recipe.crop === undefined ? rotated : cropRaster(rotated, recipe.crop);

  const base = recipe.baseMode === "roi" && recipe.baseRoi !== undefined
    ? sampleFilmBase(framed, recipe.baseRoi)
    : estimateFilmBase(framed);
  const density = toRelativeDensity(framed, base.rgb);
  const anchors = measureDensityAnchors(base.rgb, density, 0.995, {
    dmaxOverride: recipe.dmaxMode === "manual" ? recipe.manualDmax : undefined,
    neutralRoi: recipe.autoNeutralize ? recipe.neutralRoi : undefined,
    autoNeutralize: recipe.autoNeutralize,
  });
  const scene = invertDensity(density, anchors, recipe);
  const { display, whitePoint } = toneMap(scene, recipe);
  return { display, base, anchors, whitePoint };
}
