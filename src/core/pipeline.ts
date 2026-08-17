import { toRelativeDensity, measureDensityAnchors } from "./density.ts";
import { estimateFilmBase, sampleFilmBase } from "./film-base.ts";
import { cropRaster, rotateRaster } from "./geometry.ts";
import { invertDensity } from "./invert.ts";
import { Raster } from "./raster.ts";
import { estimateWhitePoint, toneMap, toneMapEncodeRgba8 } from "./tone.ts";
import type { BaseSample, DensityAnchors, Recipe, Rect, Rgb } from "./types.ts";
import { applyGains, estimateWhiteBalance, temperatureToGains } from "./wb.ts";

/** Result of the full negative-to-positive pipeline. */
export interface NegativeResult {
  /** Final display-linear positive (still linear light). */
  display: Raster;
  base: BaseSample;
  anchors: DensityAnchors;
  /** Scene-linear value that was normalized to display white. */
  whitePoint: number;
  /** Automatic white-balance gains actually applied; undefined when off. */
  autoGains?: Rgb;
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
  return new NegativeSession(source).process(recipe);
}

export interface NegativeSessionStats {
  geometry: number;
  analysis: number;
  inversion: number;
  balance: number;
  tone: number;
}

export interface NegativePreviewResult extends Omit<NegativeResult, "display"> {
  rgba: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/**
 * Stateful form of the CPU pipeline used by the preview worker. Each cache
 * boundary follows the real dependency graph, so creative adjustments do
 * not repeat geometry, density analysis, or mask fitting. The stateless
 * `processNegative` entry point above deliberately uses the same class once,
 * keeping both paths on one implementation.
 */
export class NegativeSession {
  private readonly source: Raster;
  private framed?: Raster;
  private density?: Raster;
  private inverted?: Raster;
  private scene?: Raster;
  private base?: BaseSample;
  private anchors?: DensityAnchors;
  private autoGains?: Rgb;
  private whitePoint?: number;
  private geometryKey = "";
  private analysisKey = "";
  private inversionKey = "";
  private balanceKey = "";
  readonly stats: NegativeSessionStats = { geometry: 0, analysis: 0, inversion: 0, balance: 0, tone: 0 };

  constructor(source: Raster) {
    source.assertDomain(["transmission-linear"]);
    this.source = source;
  }

  process(recipe: Recipe): NegativeResult {
    const prepared = this.prepare(recipe);
    const { display } = toneMap(prepared.scene, recipe, prepared.whitePoint);
    this.stats.tone += 1;
    return {
      display,
      base: prepared.base,
      anchors: prepared.anchors,
      whitePoint: prepared.whitePoint,
      ...(prepared.autoGains === undefined ? {} : { autoGains: prepared.autoGains }),
    };
  }

  processPreview(recipe: Recipe): NegativePreviewResult {
    const prepared = this.prepare(recipe);
    const rgba = toneMapEncodeRgba8(prepared.scene, recipe, prepared.whitePoint);
    this.stats.tone += 1;
    return {
      rgba,
      width: prepared.scene.width,
      height: prepared.scene.height,
      base: prepared.base,
      anchors: prepared.anchors,
      whitePoint: prepared.whitePoint,
      ...(prepared.autoGains === undefined ? {} : { autoGains: prepared.autoGains }),
    };
  }

  private prepare(recipe: Recipe): {
    scene: Raster;
    base: BaseSample;
    anchors: DensityAnchors;
    whitePoint: number;
    autoGains?: Rgb;
  } {
    const geometryKey = keyOfGeometry(recipe);
    if (this.framed === undefined || geometryKey !== this.geometryKey) {
      const rotated = rotateRaster(this.source, recipe.rotate);
      this.framed = recipe.crop === undefined ? rotated : cropRaster(rotated, recipe.crop);
      this.geometryKey = geometryKey;
      this.analysisKey = "";
      this.stats.geometry += 1;
    }

    const analysisKey = `${geometryKey}|${keyOfAnalysis(recipe)}`;
    if (this.density === undefined || this.base === undefined || this.anchors === undefined || analysisKey !== this.analysisKey) {
      const framed = this.framed;
      this.base = recipe.baseMode === "roi" && recipe.baseRoi !== undefined
        ? sampleFilmBase(framed, recipe.baseRoi)
        : estimateFilmBase(framed);
      this.density = toRelativeDensity(framed, this.base.rgb);
      this.anchors = measureDensityAnchors(this.base.rgb, this.density, 0.995, {
        dmaxOverride: recipe.dmaxMode === "manual" ? recipe.manualDmax : undefined,
        neutralRoi: recipe.autoNeutralize ? recipe.neutralRoi : undefined,
        autoNeutralize: recipe.autoNeutralize,
      });
      this.analysisKey = analysisKey;
      this.inversionKey = "";
      this.stats.analysis += 1;
    }

    const inversionKey = `${analysisKey}|${recipe.preSaturation}`;
    if (this.inverted === undefined || inversionKey !== this.inversionKey) {
      this.inverted = invertDensity(this.density, this.anchors, recipe);
      this.inversionKey = inversionKey;
      this.balanceKey = "";
      this.stats.inversion += 1;
    }

    const balanceKey = `${inversionKey}|${recipe.autoWhiteBalance ? "auto" : `manual:${recipe.temperatureKelvin}`}`;
    if (this.scene === undefined || this.whitePoint === undefined || balanceKey !== this.balanceKey) {
      // Automatic and manual white balance are mutually exclusive: temperature
      // is an editor control used only after automatic estimation is disabled.
      this.autoGains = recipe.autoWhiteBalance ? estimateWhiteBalance(this.inverted) : undefined;
      this.scene = applyGains(this.inverted, this.autoGains ?? temperatureToGains(recipe.temperatureKelvin));
      this.whitePoint = estimateWhitePoint(this.scene);
      this.balanceKey = balanceKey;
      this.stats.balance += 1;
    }

    return {
      scene: this.scene,
      base: this.base,
      anchors: this.anchors,
      whitePoint: this.whitePoint,
      ...(this.autoGains === undefined ? {} : { autoGains: this.autoGains }),
    };
  }
}

function keyOfGeometry(recipe: Recipe): string {
  return `${recipe.rotate}|${keyOfRect(recipe.crop)}`;
}

function keyOfAnalysis(recipe: Recipe): string {
  const base = recipe.baseMode === "roi" ? `roi:${keyOfRect(recipe.baseRoi)}` : "auto";
  const dmax = recipe.dmaxMode === "manual" ? `manual:${recipe.manualDmax}` : "auto";
  const neutral = recipe.autoNeutralize ? `on:${keyOfRect(recipe.neutralRoi)}` : "off";
  return `${base}|${dmax}|${neutral}`;
}

function keyOfRect(rect: Rect | undefined): string {
  return rect === undefined ? "none" : `${rect.x},${rect.y},${rect.width},${rect.height}`;
}
