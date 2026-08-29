import { toRelativeDensity, measureDensityAnchors } from "./density.ts";
import { encode8 } from "./encode.ts";
import { estimateFilmBase, sampleFilmBase } from "./film-base.ts";
import { cropRaster, rotateRaster } from "./geometry.ts";
import { invertDensity } from "./invert.ts";
import {
  prepareNegadoctor56,
  processNegadoctor56,
  renderPreparedNegadoctor56,
  type PreparedNegadoctor56,
} from "./negadoctor.ts";
import { Raster } from "./raster.ts";
import { estimateWhitePoint, toneMap, toneMapEncodeRgba8 } from "./tone.ts";
import type { BaseSample, ClassicRecipe, DensityAnchors, Recipe, Rect, Rgb } from "./types.ts";
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

/** CPU-canonical analysis values consumed by the WebGPU pixel pipeline. */
export interface NegativeGpuPreparation extends Omit<NegativeResult, "display"> {
  width: number;
  height: number;
  gains: Rgb;
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
  private negadoctorPrepared?: PreparedNegadoctor56;
  private negadoctorPrepareKey = "";
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
    if (recipe.engine === "negadoctor-5.6") {
      const result = processNegadoctor56(this.source, recipe);
      this.stats.geometry += 1;
      this.stats.analysis += 1;
      this.stats.inversion += 1;
      this.stats.tone += 1;
      return { ...result, whitePoint: 1 };
    }
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
    if (recipe.engine === "negadoctor-5.6") {
      const prepareKey = keyOfNegadoctorPreparation(recipe);
      if (this.negadoctorPrepared === undefined || prepareKey !== this.negadoctorPrepareKey) {
        this.negadoctorPrepared = prepareNegadoctor56(this.source, recipe);
        this.negadoctorPrepareKey = prepareKey;
        this.stats.geometry += 1;
        this.stats.analysis += 1;
      }
      const result = renderPreparedNegadoctor56(this.negadoctorPrepared, recipe);
      const rgb = encode8(result.display);
      const rgba = new Uint8ClampedArray(result.display.width * result.display.height * 4);
      for (let source = 0, target = 0; source < rgb.length; source += 3, target += 4) {
        rgba[target] = rgb[source]!;
        rgba[target + 1] = rgb[source + 1]!;
        rgba[target + 2] = rgb[source + 2]!;
        rgba[target + 3] = 255;
      }
      this.stats.inversion += 1;
      this.stats.tone += 1;
      return {
        rgba,
        width: result.display.width,
        height: result.display.height,
        base: result.base,
        anchors: result.anchors,
        whitePoint: 1,
      };
    }
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

  /**
   * Resolve geometry-dependent analysis on the canonical CPU path without
   * quantizing a preview. WebGPU consumes only these small values and reads
   * the original transmission raster itself.
   */
  prepareGpu(recipe: Recipe): NegativeGpuPreparation {
    if (recipe.engine === "negadoctor-5.6") {
      const prepareKey = keyOfNegadoctorPreparation(recipe);
      if (this.negadoctorPrepared === undefined || prepareKey !== this.negadoctorPrepareKey) {
        this.negadoctorPrepared = prepareNegadoctor56(this.source, recipe);
        this.negadoctorPrepareKey = prepareKey;
        this.stats.geometry += 1;
        this.stats.analysis += 1;
      }
      const prepared = this.negadoctorPrepared;
      const meanDmin = (prepared.dmin[0] + prepared.dmin[1] + prepared.dmin[2]) / 3;
      return {
        width: prepared.framed.width,
        height: prepared.framed.height,
        base: { ...prepared.base, rgb: [...prepared.dmin] },
        anchors: {
          dmin: -Math.log10(Math.max(2 ** -32, meanDmin)),
          dmax: recipe.dmax,
          range: recipe.dmax,
        },
        whitePoint: 1,
        gains: [1, 1, 1],
      };
    }
    const prepared = this.prepare(recipe);
    return {
      width: prepared.scene.width,
      height: prepared.scene.height,
      base: prepared.base,
      anchors: prepared.anchors,
      whitePoint: prepared.whitePoint,
      gains: prepared.autoGains ?? temperatureToGains(recipe.temperatureKelvin),
      ...(prepared.autoGains === undefined ? {} : { autoGains: prepared.autoGains }),
    };
  }

  private prepare(recipe: ClassicRecipe): {
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

function keyOfGeometry(recipe: ClassicRecipe): string {
  return `${recipe.rotate}|${keyOfRect(recipe.crop)}`;
}

function keyOfAnalysis(recipe: ClassicRecipe): string {
  const base = recipe.baseMode === "roi" ? `roi:${keyOfRect(recipe.baseRoi)}` : "auto";
  const dmax = recipe.dmaxMode === "manual" ? `manual:${recipe.manualDmax}` : "auto";
  const neutral = recipe.autoNeutralize ? `on:${keyOfRect(recipe.neutralRoi)}` : "off";
  return `${base}|${dmax}|${neutral}`;
}

function keyOfNegadoctorPreparation(recipe: Extract<Recipe, { engine: "negadoctor-5.6" }>): string {
  const base = recipe.baseMode === "manual"
    ? `manual:${recipe.dminRgb.join(",")}`
    : `${recipe.baseMode}:${keyOfRect(recipe.baseRoi)}`;
  return [
    recipe.rotate,
    keyOfRect(recipe.crop),
    recipe.inputPrimaries,
    recipe.workingSpace,
    recipe.filmStock,
    base,
  ].join("|");
}

function keyOfRect(rect: Rect | undefined): string {
  return rect === undefined ? "none" : `${rect.x},${rect.y},${rect.width},${rect.height}`;
}
