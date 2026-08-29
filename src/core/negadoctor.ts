import { convertLinearRgb, convertRasterPrimaries, workingPrimaries } from "./color-space.ts";
import { toRelativeDensity, measureDensityAnchors } from "./density.ts";
import { estimateFilmBase, sampleFilmBase } from "./film-base.ts";
import { cropRaster, rotateRaster, validateRect } from "./geometry.ts";
import { Raster, percentile } from "./raster.ts";
import type { BaseSample, DensityAnchors, LinearPrimaries, NegadoctorRecipe, Rect, Rgb } from "./types.ts";

const THRESHOLD = 2 ** -32;
const SAMPLE_CAP = 65_536;

export interface NegadoctorAnalysis {
  dminRgb: Rgb;
  dmax: number;
  scanExposureBias: number;
  shadowCastRgb: Rgb;
  highlightBalanceRgb: Rgb;
  paperBlack: number;
  printExposure: number;
  base: BaseSample;
}

export interface PreparedNegadoctor56 {
  framed: Raster;
  base: BaseSample;
  dmin: Rgb;
  primaries: LinearPrimaries;
}

export function processNegadoctor56(
  source: Raster,
  recipe: NegadoctorRecipe,
): { display: Raster; base: BaseSample; anchors: DensityAnchors } {
  source.assertDomain(["transmission-linear"]);
  validateNegadoctor56(recipe);
  return renderPreparedNegadoctor56(prepareNegadoctor56(source, recipe), recipe);
}

/** Geometry, working-space conversion and film-base resolution are invariant
 * while the print controls are adjusted, so preview sessions may cache them. */
export function prepareNegadoctor56(source: Raster, recipe: NegadoctorRecipe): PreparedNegadoctor56 {
  source.assertDomain(["transmission-linear"]);
  validateNegadoctor56(recipe);
  const rotated = rotateRaster(source, recipe.rotate);
  const framedInput = recipe.crop === undefined ? rotated : cropRaster(rotated, recipe.crop);
  const primaries = workingPrimaries(recipe.workingSpace);
  const framed = convertRasterPrimaries(framedInput, recipe.inputPrimaries, primaries);
  const base = resolveBase(framed, recipe);
  const dmin = effectiveDmin(base.rgb, recipe.filmStock);
  return { framed, base, dmin, primaries };
}

export function renderPreparedNegadoctor56(
  prepared: PreparedNegadoctor56,
  recipe: NegadoctorRecipe,
): { display: Raster; base: BaseSample; anchors: DensityAnchors } {
  validateNegadoctor56(recipe);
  const { framed, base, dmin, primaries } = prepared;
  const displayWorking = new Raster(framed.width, framed.height, "display-linear");
  negadoctor56Range(framed.data, displayWorking.data, 0, framed.width * framed.height, recipe, dmin);
  const display = primaries === "srgb"
    ? displayWorking
    : convertRasterPrimaries(displayWorking, "rec2020", "srgb", "display-linear");
  const meanDmin = mean3(dmin);
  return {
    display,
    base: { ...base, rgb: dmin },
    anchors: { dmin: -Math.log10(Math.max(THRESHOLD, meanDmin)), dmax: recipe.dmax, range: recipe.dmax },
  };
}

/** Pixel-independent 5.6-compatible transform. Input and output use the same
 * working primaries; output conversion to sRGB is deliberately separate. */
export function negadoctor56Range(
  source: Float32Array,
  target: Float32Array,
  startPixel: number,
  endPixel: number,
  recipe: Pick<NegadoctorRecipe,
    "dmax" | "scanExposureBias" | "shadowCastRgb" | "highlightBalanceRgb"
    | "paperBlack" | "paperGrade" | "paperGloss" | "printExposure">,
  dminRgb: Rgb,
): void {
  const softComplement = 1 - recipe.paperGloss;
  for (let offset = startPixel * 3; offset < endPixel * 3; offset += 3) {
    for (let channel = 0; channel < 3; channel += 1) {
      // darktable clamps transmission with fmaxf(input, 2^-32), which maps
      // NaN onto the threshold; a bare Math.max would propagate NaN through
      // log/pow into the raster and surface as silent black speckle.
      const sampledTransmission = source[offset + channel]!;
      const transmission = sampledTransmission >= THRESHOLD ? sampledTransmission : THRESHOLD;
      const density = -Math.log10(dminRgb[channel]! / transmission);
      const high = recipe.highlightBalanceRgb[channel]!;
      const corrected = high / recipe.dmax * density
        + high * recipe.scanExposureBias * recipe.shadowCastRgb[channel]!;
      const printLinear = Math.max(
        0,
        recipe.printExposure * (1 + recipe.paperBlack - Math.pow(10, corrected)),
      );
      const printGamma = Math.pow(printLinear, recipe.paperGrade);
      target[offset + channel] = printGamma > recipe.paperGloss
        ? recipe.paperGloss
          + (1 - Math.exp(-(printGamma - recipe.paperGloss) / softComplement)) * softComplement
        : printGamma;
    }
  }
}

export function validateNegadoctor56(recipe: NegadoctorRecipe): void {
  const rgbValid = (rgb: Rgb, min: number, max: number) => rgb.every((value) => Number.isFinite(value) && value >= min && value <= max);
  if (!rgbValid(recipe.dminRgb, 0.00001, 1.5)) throw new Error("Dmin RGB 超出 darktable 5.6 允许范围。");
  if (!rgbValid(recipe.shadowCastRgb, 0.25, 2) || !rgbValid(recipe.highlightBalanceRgb, 0.25, 2)) {
    throw new Error("阴影/高光三通道校正超出 darktable 5.6 允许范围。");
  }
  const scalarChecks: Array<[number, number, number, string]> = [
    [recipe.dmax, 0.1, 6, "Dmax"],
    [recipe.scanExposureBias, -1, 1, "扫描曝光偏置"],
    [recipe.paperBlack, -0.5, 0.5, "相纸黑位"],
    [recipe.paperGrade, 1, 8, "相纸等级"],
    [recipe.paperGloss, 0.0001, 1, "相纸光泽"],
    [recipe.printExposure, 0.5, 2, "打印曝光"],
  ];
  for (const [value, min, max, label] of scalarChecks) {
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label}超出 darktable 5.6 允许范围。`);
  }
  for (const [roi, label] of [
    [recipe.baseRoi, "片基 ROI"],
    [recipe.contentRoi, "内容 ROI"],
    [recipe.shadowRoi, "阴影 ROI"],
    [recipe.highlightRoi, "高光 ROI"],
  ] as const) if (roi !== undefined) validateRect(roi, label);
}

/** Robust one-shot analysis. Unlike darktable's extrema-based pickers, the
 * returned values use percentiles and the existing neutral-axis fit, but are
 * written using the exact 5.6 parameter semantics. */
export function analyzeNegadoctor56(source: Raster, recipe: NegadoctorRecipe): NegadoctorAnalysis {
  validateNegadoctor56(recipe);
  const rotated = rotateRaster(source, recipe.rotate);
  const framedInput = recipe.crop === undefined ? rotated : cropRaster(rotated, recipe.crop);
  const primaries = workingPrimaries(recipe.workingSpace);
  const framed = convertRasterPrimaries(framedInput, recipe.inputPrimaries, primaries);
  const sampledBase = recipe.baseRoi === undefined ? estimateFilmBase(framed) : sampleFilmBase(framed, recipe.baseRoi);
  const dminRgb = effectiveDmin(sampledBase.rgb, recipe.filmStock);
  const density = toRelativeDensity(framed, dminRgb);
  const samples = sampleDensity(density, recipe.contentRoi);
  const perChannel = ([0, 1, 2] as const).map((channel) => samples.map((sample) => sample[channel]));
  const dmax = clamp(Math.max(...perChannel.map((channel) => percentile([...channel], 0.995))), 0.1, 6);
  const lowDensity = perChannel.map((channel) => percentile([...channel], 0.005)) as Rgb;
  const scanExposureBias = clamp(Math.min(...lowDensity) / dmax, -1, 1);

  const anchors = measureDensityAnchors(dminRgb, density, 0.995, {
    neutralRoi: undefined,
    autoNeutralize: true,
  });
  const fit = anchors.channelFit;
  const fittedHighlight = fit === undefined
    ? [1, 1, 1] as Rgb
    : normalizeGains(fit.slope.map((slope) => 1 / slope) as Rgb);
  const fittedShadow = fit === undefined || Math.abs(scanExposureBias) < 1e-4
    ? [1, 1, 1] as Rgb
    : normalizeGains(fit.offset.map((offset) => 1 + offset / Math.max(dmax, 0.1)) as Rgb);
  const shadowCastRgb = recipe.shadowRoi === undefined
    ? fittedShadow
    : shadowBalanceFromRoi(sampleDensity(density, recipe.shadowRoi), dmax);
  const highlightBalanceRgb = recipe.highlightRoi === undefined
    ? fittedHighlight
    : highlightBalanceFromRoi(
        sampleDensity(density, recipe.highlightRoi),
        dmax,
        scanExposureBias,
        shadowCastRgb,
      );

  const highDensity = perChannel.map((channel) => percentile([...channel], 0.995)) as Rgb;
  const lowCorrected = correctedDensity(lowDensity, dmax, scanExposureBias, shadowCastRgb, highlightBalanceRgb);
  const highCorrected = correctedDensity(highDensity, dmax, scanExposureBias, shadowCastRgb, highlightBalanceRgb);
  const paperBlack = clamp(Math.max(...lowCorrected.map((value) => 0.1 - (1 - Math.pow(10, -value)))), -0.5, 0.5);
  const printExposure = clamp(Math.min(...highCorrected.map(
    (value) => 0.96 / Math.max(THRESHOLD, 1 - Math.pow(10, -value) + paperBlack),
  )), 0.5, 2);

  return {
    dminRgb,
    dmax,
    scanExposureBias,
    shadowCastRgb,
    highlightBalanceRgb,
    paperBlack,
    printExposure,
    base: sampledBase,
  };
}

function resolveBase(framed: Raster, recipe: NegadoctorRecipe): BaseSample {
  if (recipe.baseMode === "manual") {
    return { rgb: recipe.dminRgb, confidence: 1, method: "manual", sampleCount: 0 };
  }
  return recipe.baseMode === "roi" && recipe.baseRoi !== undefined
    ? sampleFilmBase(framed, recipe.baseRoi)
    : estimateFilmBase(framed);
}

function effectiveDmin(rgb: Rgb, filmStock: NegadoctorRecipe["filmStock"]): Rgb {
  return filmStock === "black-and-white" ? [rgb[0], rgb[0], rgb[0]] : [...rgb];
}

function sampleDensity(density: Raster, roi?: Rect): Rgb[] {
  const rawLeft = roi === undefined ? Math.floor(density.width * 0.02) : Math.floor(roi.x * density.width);
  const rawTop = roi === undefined ? Math.floor(density.height * 0.02) : Math.floor(roi.y * density.height);
  const rawRight = roi === undefined ? Math.max(rawLeft + 1, Math.ceil(density.width * 0.98)) : Math.ceil((roi.x + roi.width) * density.width);
  const rawBottom = roi === undefined ? Math.max(rawTop + 1, Math.ceil(density.height * 0.98)) : Math.ceil((roi.y + roi.height) * density.height);
  // IPC validation keeps ROIs within [0,1] up to a rounding slack, so an
  // edge can still land one pixel out of bounds; clamp every edge so
  // sampling never wraps onto unrelated rows or columns.
  const left = Math.min(Math.max(rawLeft, 0), density.width - 1);
  const top = Math.min(Math.max(rawTop, 0), density.height - 1);
  const right = Math.min(Math.max(rawRight, left + 1), density.width);
  const bottom = Math.min(Math.max(rawBottom, top + 1), density.height);
  const count = Math.max(1, (right - left) * (bottom - top));
  const stride = Math.max(1, Math.ceil(count / SAMPLE_CAP));
  const samples: Rgb[] = [];
  const width = right - left;
  for (let sample = 0; sample < count; sample += stride) {
    const x = left + sample % width;
    const y = top + Math.floor(sample / width);
    const offset = Raster.offsetOf(x, y, density.width);
    const rgb: Rgb = [density.data[offset]!, density.data[offset + 1]!, density.data[offset + 2]!];
    if (rgb.every((value) => Number.isFinite(value) && value >= 0)) samples.push(rgb);
  }
  if (samples.length < 32) throw new Error("Negadoctor 自动分析至少需要 32 个有效内容像素。");
  return samples;
}

function correctedDensity(
  positiveDensity: Rgb,
  dmax: number,
  bias: number,
  shadow: Rgb,
  highlight: Rgb,
): Rgb {
  return positiveDensity.map((density, channel) => (
    -highlight[channel]! * density / dmax + highlight[channel]! * bias * shadow[channel]!
  )) as Rgb;
}

function normalizeGains(values: Rgb): Rgb {
  const center = values[1] > 0 ? values[1] : 1;
  return values.map((value) => clamp(value / center, 0.25, 2)) as Rgb;
}

function medianDensity(samples: Rgb[]): Rgb {
  return ([0, 1, 2] as const).map((channel) => percentile(samples.map((sample) => sample[channel]), 0.5)) as Rgb;
}

function shadowBalanceFromRoi(samples: Rgb[], dmax: number): Rgb {
  const normalized = medianDensity(samples).map((value) => value / dmax) as Rgb;
  const minimum = Math.max(THRESHOLD, Math.min(...normalized));
  return normalized.map((value) => clamp(minimum / Math.max(THRESHOLD, value), 0.25, 2)) as Rgb;
}

function highlightBalanceFromRoi(samples: Rgb[], dmax: number, bias: number, shadow: Rgb): Rgb {
  const density = medianDensity(samples);
  const factors = density.map((value, channel) => (
    Math.abs(-1 / (bias * shadow[channel]! - value / dmax))
  )) as Rgb;
  const minimum = Math.max(THRESHOLD, Math.min(...factors));
  return factors.map((value) => clamp(value / minimum, 0.25, 2)) as Rgb;
}

function mean3(rgb: Rgb): number {
  return (rgb[0] + rgb[1] + rgb[2]) / 3;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
