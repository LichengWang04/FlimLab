import { estimateFilmBase, measureDensityAnchors, referenceFilmBase, sampleFilmBase, toRelativeDensity } from "./density.ts";
import { applyGeometry, crop } from "./geometry.ts";
import { restoreRaster } from "./repair.ts";
import { Raster } from "./raster.ts";
import { toneMap } from "./tone.ts";
import { applyFilmTransform } from "./transforms.ts";
import type { BaseSample, DensityAnchors, PipelineSettings } from "./types.ts";

export interface PipelineResult {
  /** Linear capture samples; camera-linear inputs intentionally retain that domain. */
  readonly transmission: Raster;
  readonly base: BaseSample;
  readonly density: Raster;
  readonly densityAnchors: DensityAnchors;
  /** Robust scene-linear value mapped to display white before creative exposure. */
  readonly displayWhitePoint: number;
  readonly sceneLinear: Raster;
  readonly displayLinear: Raster;
}

export type PipelineSceneResult = Omit<PipelineResult, "displayLinear">;

/** Runs the invariant part of preview processing through scene-linear RGB. */
export function processFilmToScene(source: Raster, settings: PipelineSettings): PipelineSceneResult {
  source.assertDomain(["camera-linear-rgb", "transmission-linear-rgb"]);

  // Keep camera-linear and scanner/transmission-linear semantics explicit all
  // the way through base sampling and density. A camera RGB buffer is not a
  // generic transmission or sRGB buffer and must never be re-labelled.
  const transmission = source;

  const geometryWithoutCrop = settings.geometry === undefined
    ? undefined
    : { ...settings.geometry, crop: undefined };
  const geometrized = applyGeometry(transmission, geometryWithoutCrop);
  // Repairs remain in linear transmission before base sampling/density, so
  // defects do not bias the sampled film base or get processed in display RGB.
  const restored = settings.restoration === undefined
    ? geometrized
    : restoreRaster(geometrized, settings.restoration).image;
  const framed = settings.geometry?.crop === undefined
    ? restored
    : crop(restored, settings.geometry.crop);
  // Density anchors and inversion must describe the delivered composition.
  // baseRoi is normalized to this final cropped frame, so a retained strip of
  // unexposed film base can be selected without sampling pixels outside it.
  const base = settings.baseStrategy?.kind === "reference"
    ? referenceFilmBase(settings.baseStrategy.rgb, settings.baseStrategy.confidence)
    : settings.baseStrategy?.kind === "automatic"
      ? estimateFilmBase(framed)
      : sampleFilmBase(framed, settings.baseRoi);
  const density = toRelativeDensity(framed, base.rgb, undefined, settings.photonTransfer);
  const measuredDensityAnchors = measureDensityAnchors(base.rgb, density, 0.995, {
    dmaxOverride: settings.dmaxOverride,
    dmaxRoi: settings.dmaxSampleRoi,
    inferChannelRange: settings.inferChannelRange === true,
  });
  const densityAnchors = settings.dmaxChannelRange === undefined
    ? measuredDensityAnchors
    : { ...measuredDensityAnchors, channelRange: settings.dmaxChannelRange };
  const sceneLinear = applyFilmTransform(
    density,
    settings.film,
    densityAnchors.range,
    densityAnchors.channelRange,
  );
  const displayWhitePoint = estimateDisplayWhitePoint(density, sceneLinear, densityAnchors);

  return {
    transmission: framed,
    base,
    density,
    densityAnchors,
    displayWhitePoint,
    sceneLinear,
  };
}

export function processFilm(source: Raster, settings: PipelineSettings): PipelineResult {
  const scene = processFilmToScene(source, settings);
  const tone = settings.tone?.whitePoint === undefined
    ? { ...settings.tone, whitePoint: scene.displayWhitePoint }
    : settings.tone;
  return { ...scene, displayLinear: toneMap(scene.sceneLinear, tone) };
}

/**
 * Estimates the scene-linear value that should become display white. Dmax
 * bounds the accepted density samples, while the central-frame percentile
 * prevents retained film borders from setting the exposure of the photograph.
 */
export function estimateDisplayWhitePoint(
  density: Raster,
  scene: Raster,
  anchors: DensityAnchors,
  highPercentile = 0.995,
): number {
  density.assertDomain("relative-density");
  scene.assertDomain("scene-linear-rgb");
  if (density.width !== scene.width || density.height !== scene.height) {
    throw new Error("Density and scene rasters must have matching dimensions.");
  }
  if (
    !Number.isFinite(anchors.range)
    || anchors.range < 0
    || !Number.isFinite(highPercentile)
    || highPercentile <= 0
    || highPercentile > 1
  ) {
    throw new Error("Display white-point inputs must be finite and valid.");
  }

  const left = Math.floor(scene.width * 0.05);
  const top = Math.floor(scene.height * 0.05);
  const right = Math.max(left + 1, Math.ceil(scene.width * 0.95));
  const bottom = Math.max(top + 1, Math.ceil(scene.height * 0.95));
  const centralPixelCount = (right - left) * (bottom - top);
  const centralWidth = right - left;
  const sampleStride = Math.max(1, Math.ceil(centralPixelCount / 65_536));
  const luminances: number[] = [];

  for (let sample = 0; sample < centralPixelCount; sample += sampleStride) {
    const y = top + Math.floor(sample / centralWidth);
    const x = left + sample % centralWidth;
    const offset = (y * scene.width + x) * 3;
    const neutralDensity = (
      Math.max(0, density.data[offset])
      + Math.max(0, density.data[offset + 1])
      + Math.max(0, density.data[offset + 2])
    ) / 3;
    if (!Number.isFinite(neutralDensity) || neutralDensity > anchors.range) continue;

    const luminance = (
      scene.data[offset] * 0.2126
      + scene.data[offset + 1] * 0.7152
      + scene.data[offset + 2] * 0.0722
    );
    if (Number.isFinite(luminance) && luminance > 0) luminances.push(luminance);
  }

  if (luminances.length === 0) return 1;
  luminances.sort((leftValue, rightValue) => leftValue - rightValue);
  const position = Math.round((luminances.length - 1) * highPercentile);
  return Math.max(0.05, luminances[position]);
}
