import { validateRect } from "./geometry.ts";
import { Raster, percentile } from "./raster.ts";
import type {
  ChannelFit,
  DensityAnchors,
  DensityCurve,
  NeutralizationDiagnostics,
  NeutralizationMethod,
  Rect,
  Rgb,
} from "./types.ts";

const DEFAULT_EPSILON = 1e-6;
const SAMPLE_CAP = 65_536;
const FIT_MIN_CANDIDATES = 24;
const FIT_MIN_BINS = 5;
const FIT_MIN_SPREAD = 0.1;
const FIT_MAX_CANDIDATES = 2048;
const FIT_BIN_COUNT = 32;
const FIT_ITERATIONS = 2;
const PCA_ITERATIONS = 3;
const PCA_POWER_ITERATIONS = 16;
const VALIDATION_FRACTION = 5;
const CURVE_BIN_COUNT = 12;
const CURVE_MIN_CANDIDATES = 96;
const CURVE_MIN_BINS = 8;
const CURVE_MIN_SPREAD = 0.4;
const CURVE_MAX_CORRECTION = 0.35;
const CURVE_MIN_IMPROVEMENT = 0.1;
const IDENTITY_TOLERANCE = 0.03;

interface DensitySample {
  rgb: Rgb;
  x: number;
  y: number;
  hash: number;
}

interface ScoredSample extends DensitySample {
  latent: number;
  residual: number;
}

interface FitCandidate {
  fit: ChannelFit;
  method: "neutral-axis" | "pca";
}

interface CorrectionScore {
  median: number;
  p90: number;
  combined: number;
  entries: { residual: number; density: number }[];
}

interface NeutralizationResult {
  channelFit?: ChannelFit;
  channelCurves?: [DensityCurve, DensityCurve, DensityCurve];
  diagnostics: NeutralizationDiagnostics;
}

/** Converts linear transmission to relative optical density per channel. */
export function toRelativeDensity(linear: Raster, base: Rgb, epsilon = DEFAULT_EPSILON): Raster {
  linear.assertDomain(["transmission-linear"]);
  if (
    !Number.isFinite(epsilon)
    || epsilon <= 0
    || base.some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    throw new Error("Base transmission values and epsilon must be positive finite values.");
  }

  const density = new Raster(linear.width, linear.height, "relative-density");
  toRelativeDensityRange(linear.data, density.data, 0, linear.width * linear.height, base, epsilon);
  return density;
}

/** Pixel-independent density kernel; ranges are [startPixel, endPixel). */
export function toRelativeDensityRange(
  source: Float32Array,
  target: Float32Array,
  startPixel: number,
  endPixel: number,
  base: Rgb,
  epsilon = DEFAULT_EPSILON,
): void {
  for (let offset = startPixel * 3; offset < endPixel * 3; offset += 3) {
    for (let channel = 0; channel < 3; channel += 1) {
      const ratio = source[offset + channel]! / base[channel]!;
      const safeRatio = Number.isFinite(ratio) ? Math.max(0, ratio) : 1;
      const logged = Math.log10(Math.max(safeRatio, epsilon));
      target[offset + channel] = logged === 0 ? 0 : -logged;
    }
  }
}

export interface DensityAnchorOptions {
  dmaxOverride?: number;
  neutralRoi?: Rect;
  autoNeutralize?: boolean;
}

/** Measures density range and, when requested, estimates mask neutralisation. */
export function measureDensityAnchors(
  base: Rgb,
  density: Raster,
  highPercentile = 0.995,
  options: DensityAnchorOptions = {},
): DensityAnchors {
  density.assertDomain(["relative-density"]);
  if (
    base.some((value) => !Number.isFinite(value) || value <= 0)
    || !Number.isFinite(highPercentile)
    || highPercentile <= 0
    || highPercentile > 1
  ) {
    throw new Error("Density anchor inputs must be positive and finite.");
  }
  if (
    options.dmaxOverride !== undefined
    && (!Number.isFinite(options.dmaxOverride) || options.dmaxOverride < 0 || options.dmaxOverride > 16)
  ) {
    throw new Error("Manual Dmax must be finite and between 0 and 16 D.");
  }
  if (options.neutralRoi !== undefined) validateRect(options.neutralRoi, "Neutral ROI");

  const dmin = base.reduce(
    (sum, value) => sum - Math.log10(Math.min(1, Math.max(DEFAULT_EPSILON, value))),
    0,
  ) / 3;

  const roi = options.neutralRoi;
  const left = roi === undefined ? 0 : Math.floor(roi.x * density.width);
  const top = roi === undefined ? 0 : Math.floor(roi.y * density.height);
  const right = roi === undefined ? density.width : Math.ceil((roi.x + roi.width) * density.width);
  const bottom = roi === undefined ? density.height : Math.ceil((roi.y + roi.height) * density.height);
  const roiPixels = Math.max(1, (right - left) * (bottom - top));
  const stride = Math.max(1, Math.ceil((roi === undefined ? density.width * density.height : roiPixels) / SAMPLE_CAP));

  const neutralDensities: number[] = [];
  const samples: DensitySample[] = [];
  const roiWidth = right - left;
  for (let pixel = 0; pixel < roiPixels; pixel += stride) {
    const x = left + pixel % roiWidth;
    const y = top + Math.floor(pixel / roiWidth);
    const offset = Raster.offsetOf(x, y, density.width);
    const rgb: Rgb = [
      Math.max(0, density.data[offset]!),
      Math.max(0, density.data[offset + 1]!),
      Math.max(0, density.data[offset + 2]!),
    ];
    if (rgb.every(Number.isFinite)) {
      neutralDensities.push(mean3(rgb));
      samples.push({ rgb, x, y, hash: spatialHash(x, y) });
    }
  }
  if (neutralDensities.length === 0) throw new Error("密度栅格中没有可用样本。");

  const range = options.dmaxOverride === undefined
    ? percentile(neutralDensities, highPercentile)
    : Math.max(0, options.dmaxOverride - dmin);
  const dmax = dmin + range;
  if (roi === undefined && options.autoNeutralize !== true) return { dmin, dmax, range };

  const sampleUpper = options.dmaxOverride === undefined
    ? range
    : percentile(neutralDensities, 0.995);
  const result = resolveNeutralization(samples, neutralDensities, sampleUpper, highPercentile, roi !== undefined);
  return {
    dmin,
    dmax,
    range,
    ...(result.channelFit === undefined ? {} : { channelFit: result.channelFit }),
    ...(result.channelCurves === undefined ? {} : { channelCurves: result.channelCurves }),
    neutralization: result.diagnostics,
  };
}

/** Monotone interpolation with bounded terminal slopes and correction size. */
export function applyDensityCurve(value: number, curve: DensityCurve): number {
  const count = curve.input.length;
  if (count < 2 || curve.output.length !== count) return value;
  let output: number;
  if (value <= curve.input[0]!) {
    output = curve.output[0]! + (value - curve.input[0]!) * terminalSlope(curve, 0, 1);
  } else if (value >= curve.input[count - 1]!) {
    output = curve.output[count - 1]!
      + (value - curve.input[count - 1]!) * terminalSlope(curve, count - 2, count - 1);
  } else {
    let low = 0;
    let high = count - 1;
    while (high - low > 1) {
      const middle = (low + high) >>> 1;
      if (curve.input[middle]! <= value) low = middle;
      else high = middle;
    }
    const span = curve.input[high]! - curve.input[low]!;
    const mix = span <= 0 ? 0 : (value - curve.input[low]!) / span;
    output = curve.output[low]! * (1 - mix) + curve.output[high]! * mix;
  }
  return Math.min(value + CURVE_MAX_CORRECTION, Math.max(value - CURVE_MAX_CORRECTION, output));
}

function resolveNeutralization(
  allSamples: readonly DensitySample[],
  neutralDensities: readonly number[],
  sampleUpper: number,
  highPercentile: number,
  roiMode: boolean,
): NeutralizationResult {
  const valid = filterAndStratify(allSamples, sampleUpper);
  const span = sampleSpan(valid);
  const train = valid.filter((sample) => sample.hash % VALIDATION_FRACTION !== 0);
  const validation = valid.filter((sample) => sample.hash % VALIDATION_FRACTION === 0);
  const validationNeutrals = train.length >= FIT_MIN_CANDIDATES
    ? selectNeutralAxisSamples(validation, initialChannelFit(train))
    : [];
  const evaluation = validationNeutrals.length >= 16 ? validationNeutrals : validation;
  const candidates = [fitNeutralAxis(train), fitPcaAxis(train)].filter(
    (candidate): candidate is FitCandidate => candidate !== undefined,
  );

  let best: FitCandidate | undefined;
  let bestScore: CorrectionScore | undefined;
  if (evaluation.length >= 16) {
    for (const candidate of candidates) {
      const score = scoreCorrection(evaluation, candidate.fit);
      if (
        bestScore === undefined
        || score.combined < bestScore.combined
        || (score.combined === bestScore.combined && score.p90 < bestScore.p90)
      ) {
        best = candidate;
        bestScore = score;
      }
    }
  }

  if (best !== undefined && bestScore !== undefined) {
    const identityScore = scoreCorrection(evaluation);
    const affineImprovement = relativeImprovement(identityScore.combined, bestScore.combined);
    if (affineImprovement >= 0.05 && !isIdentityFit(best.fit)) {
      const curves = fitResidualCurves(train, best.fit);
      if (curves !== undefined && acceptCurves(evaluation, best.fit, curves)) {
        const curveScore = scoreCorrection(evaluation, best.fit, curves);
        return {
          channelFit: best.fit,
          channelCurves: curves,
          diagnostics: diagnostics("curve", relativeImprovement(bestScore.combined, curveScore.combined), valid, span),
        };
      }
      return {
        channelFit: best.fit,
        diagnostics: diagnostics(best.method, affineImprovement, valid, span),
      };
    }
  }

  const triples = allSamples.map(({ rgb }) => rgb);
  const anchor = roiMode
    ? rangeFitFromRoi(triples, highPercentile)
    : tailAnchorFit(neutralDensities, triples, highPercentile);
  if (anchor !== undefined && !isIdentityFit(anchor)) {
    return { channelFit: anchor, diagnostics: diagnostics("anchor", 0, valid, span) };
  }
  return { diagnostics: diagnostics("none", 0, valid, span) };
}

function diagnostics(
  method: NeutralizationMethod,
  improvement: number,
  samples: readonly DensitySample[],
  span: number,
): NeutralizationDiagnostics {
  return {
    method,
    improvement: Math.min(1, Math.max(0, Number.isFinite(improvement) ? improvement : 0)),
    sampleCount: samples.length,
    densitySpan: Number.isFinite(span) ? span : 0,
  };
}

function filterAndStratify(samples: readonly DensitySample[], upper: number): DensitySample[] {
  let usable = samples.filter(({ rgb }) => rgb.every(Number.isFinite) && mean3(rgb) > 0.02 && mean3(rgb) <= upper);
  if (usable.length < FIT_MIN_CANDIDATES) return [];
  // The estimator ultimately consumes at most 2048 points. Bound the input to
  // the stratifier first so sorting a multi-megapixel preview is unnecessary.
  if (usable.length > FIT_MAX_CANDIDATES * 4) {
    const stride = Math.ceil(usable.length / (FIT_MAX_CANDIDATES * 4));
    usable = usable.filter((_, index) => index % stride === 0);
  }
  return stratifiedSample(usable, FIT_MAX_CANDIDATES);
}

function stratifiedSample(samples: readonly DensitySample[], cap: number): DensitySample[] {
  if (samples.length <= cap) return [...samples];
  const sorted = [...samples].sort((left, right) => mean3(left.rgb) - mean3(right.rgb));
  const bins: DensitySample[][] = Array.from({ length: FIT_BIN_COUNT }, () => []);
  for (let index = 0; index < sorted.length; index += 1) {
    const bin = Math.min(FIT_BIN_COUNT - 1, Math.floor(index * FIT_BIN_COUNT / sorted.length));
    bins[bin]!.push(sorted[index]!);
  }
  const perBin = Math.max(1, Math.floor(cap / FIT_BIN_COUNT));
  const selected = bins.flatMap((bin) => [...bin].sort((a, b) => a.hash - b.hash).slice(0, perBin));
  return selected.slice(0, cap);
}

/** Existing two-pass, density-stratified Theil-Sen neutral-axis candidate. */
function fitNeutralAxis(samples: readonly DensitySample[]): FitCandidate | undefined {
  if (samples.length < FIT_MIN_CANDIDATES || sampleSpan(samples) < FIT_MIN_SPREAD) return undefined;
  let fit = initialChannelFit(samples);
  let selected: ScoredSample[] = [];
  for (let iteration = 0; iteration < FIT_ITERATIONS; iteration += 1) {
    selected = selectNeutralAxisSamples(samples, fit);
    const next = regressNeutralAxis(selected);
    if (next === undefined) return undefined;
    fit = next;
  }
  if (selected.length < FIT_MIN_CANDIDATES) return undefined;
  return { fit, method: "neutral-axis" };
}

/** Robust 3-D principal-axis candidate with MAD/Tukey IRLS. */
function fitPcaAxis(samples: readonly DensitySample[]): FitCandidate | undefined {
  if (samples.length < FIT_MIN_CANDIDATES || sampleSpan(samples) < FIT_MIN_SPREAD) return undefined;
  let center: Rgb = [
    percentile(samples.map(({ rgb }) => rgb[0]), 0.5),
    percentile(samples.map(({ rgb }) => rgb[1]), 0.5),
    percentile(samples.map(({ rgb }) => rgb[2]), 0.5),
  ];
  let axis = unitVector(initialChannelFit(samples).slope);
  let weights = samples.map(() => 1);

  for (let iteration = 0; iteration < PCA_ITERATIONS; iteration += 1) {
    center = weightedCenter(samples, weights);
    const residuals = samples.map(({ rgb }) => orthogonalResidual(rgb, center, axis));
    const residualMedian = percentile(residuals, 0.5);
    const mad = percentile(residuals.map((value) => Math.abs(value - residualMedian)), 0.5);
    const cutoff = Math.max(0.025, 4.685 * Math.max(1e-4, 1.4826 * mad));
    weights = residuals.map((residual) => {
      const u = residual / cutoff;
      if (u >= 1) return 0;
      const remaining = 1 - u * u;
      return remaining * remaining;
    });
    if (weights.reduce((sum, value) => sum + value, 0) < FIT_MIN_CANDIDATES / 2) return undefined;
    axis = principalAxis(weightedCovariance(samples, center, weights), axis);
  }

  if (axis[0] + axis[1] + axis[2] < 0) axis = axis.map((value) => -value) as Rgb;
  if (axis.some((value) => !Number.isFinite(value) || value <= 0.02)) return undefined;
  const fit = normalizeFit({ offset: center, slope: axis });
  if (!validFit(fit)) return undefined;
  return { fit, method: "pca" };
}

function initialChannelFit(samples: readonly DensitySample[]): ChannelFit {
  const channels = ([0, 1, 2] as const).map((channel) => samples.map(({ rgb }) => rgb[channel]));
  const lows = channels.map((values) => percentile(values, 0.1)) as Rgb;
  const spans = channels.map((values, channel) => Math.max(0.05, percentile(values, 0.9) - lows[channel]!)) as Rgb;
  const meanSpan = mean3(spans);
  const slope = spans.map((span) => span / meanSpan) as Rgb;
  const meanLow = mean3(lows);
  return normalizeFit({ slope, offset: lows.map((low, channel) => low - slope[channel]! * meanLow) as Rgb });
}

function selectNeutralAxisSamples(samples: readonly DensitySample[], fit: ChannelFit): ScoredSample[] {
  const scored = samples.map((sample) => {
    const normalized = normalizeTriple(sample.rgb, fit);
    const latent = median3(normalized[0], normalized[1], normalized[2]);
    return { ...sample, latent, residual: channelSpread(normalized) / Math.max(0.08, Math.abs(latent)) };
  }).filter(({ latent, residual }) => Number.isFinite(latent) && Number.isFinite(residual) && latent > 0.02);
  if (scored.length < FIT_MIN_CANDIDATES) return [];

  const min = percentile(scored.map(({ latent }) => latent), 0.005);
  const max = percentile(scored.map(({ latent }) => latent), 0.995);
  if (max - min < FIT_MIN_SPREAD) return [];
  const selected: ScoredSample[] = [];
  for (let bin = 0; bin < FIT_BIN_COUNT; bin += 1) {
    const low = min + (max - min) * bin / FIT_BIN_COUNT;
    const high = min + (max - min) * (bin + 1) / FIT_BIN_COUNT;
    const members = scored
      .filter(({ latent }) => latent >= low && (latent < high || bin === FIT_BIN_COUNT - 1))
      .sort((left, right) => left.residual - right.residual || left.hash - right.hash);
    if (members.length === 0) continue;
    const keep = Math.max(1, Math.ceil(members.length * 0.25));
    selected.push(...members.slice(0, keep).filter(({ residual }) => residual <= 0.5));
  }
  return selected;
}

function regressNeutralAxis(candidates: readonly ScoredSample[]): ChannelFit | undefined {
  if (candidates.length < FIT_MIN_CANDIDATES) return undefined;
  const min = Math.min(...candidates.map(({ latent }) => latent));
  const max = Math.max(...candidates.map(({ latent }) => latent));
  if (max - min < FIT_MIN_SPREAD) return undefined;
  const bins: { latent: number; rgb: Rgb }[] = [];
  for (let bin = 0; bin < FIT_BIN_COUNT; bin += 1) {
    const low = min + (max - min) * bin / FIT_BIN_COUNT;
    const high = min + (max - min) * (bin + 1) / FIT_BIN_COUNT;
    const members = candidates.filter(({ latent }) => latent >= low && (latent < high || bin === FIT_BIN_COUNT - 1));
    if (members.length < 3) continue;
    bins.push({
      latent: percentile(members.map(({ latent }) => latent), 0.5),
      rgb: [0, 1, 2].map((channel) => percentile(members.map(({ rgb }) => rgb[channel]!), 0.5)) as Rgb,
    });
  }
  if (bins.length < FIT_MIN_BINS) return undefined;

  const slope: Rgb = [0, 0, 0];
  const offset: Rgb = [0, 0, 0];
  for (let channel = 0; channel < 3; channel += 1) {
    const pairwise: number[] = [];
    for (let left = 0; left < bins.length; left += 1) {
      for (let right = left + 1; right < bins.length; right += 1) {
        const delta = bins[right]!.latent - bins[left]!.latent;
        if (delta >= 0.02) pairwise.push((bins[right]!.rgb[channel]! - bins[left]!.rgb[channel]!) / delta);
      }
    }
    if (pairwise.length < 4) return undefined;
    slope[channel] = percentile(pairwise, 0.5);
    offset[channel] = percentile(bins.map((point) => point.rgb[channel]! - slope[channel]! * point.latent), 0.5);
  }
  const fit = normalizeFit({ offset, slope });
  return validFit(fit) ? fit : undefined;
}

function fitResidualCurves(samples: readonly DensitySample[], fit: ChannelFit): [DensityCurve, DensityCurve, DensityCurve] | undefined {
  const selected = selectCurveSamples(samples, fit);
  if (selected.length < CURVE_MIN_CANDIDATES) return undefined;
  const min = percentile(selected.map(({ latent }) => latent), 0.02);
  const max = percentile(selected.map(({ latent }) => latent), 0.98);
  if (max - min < CURVE_MIN_SPREAD) return undefined;

  const binned: ScoredSample[][] = [];
  for (let bin = 0; bin < CURVE_BIN_COUNT; bin += 1) {
    const low = min + (max - min) * bin / CURVE_BIN_COUNT;
    const high = min + (max - min) * (bin + 1) / CURVE_BIN_COUNT;
    const members = selected.filter(({ latent }) => latent >= low && (latent < high || bin === CURVE_BIN_COUNT - 1));
    if (members.length >= 3) binned.push(members);
  }
  if (binned.length < CURVE_MIN_BINS) return undefined;

  const curves = ([0, 1, 2] as const).map((channel) => makeMonotoneCurve(binned, fit, channel));
  if (curves.some((curve) => curve === undefined)) return undefined;
  return curves as [DensityCurve, DensityCurve, DensityCurve];
}

function selectCurveSamples(samples: readonly DensitySample[], fit: ChannelFit): ScoredSample[] {
  const scored = samples.map((sample) => {
    const normalized = normalizeTriple(sample.rgb, fit);
    const latent = median3(normalized[0], normalized[1], normalized[2]);
    return { ...sample, latent, residual: channelSpread(normalized) };
  }).filter(({ latent, residual }) => Number.isFinite(latent) && Number.isFinite(residual) && latent > 0.02);
  if (scored.length < CURVE_MIN_CANDIDATES) return [];
  const min = percentile(scored.map(({ latent }) => latent), 0.005);
  const max = percentile(scored.map(({ latent }) => latent), 0.995);
  if (max - min < CURVE_MIN_SPREAD) return [];

  const selected: ScoredSample[] = [];
  for (let bin = 0; bin < FIT_BIN_COUNT; bin += 1) {
    const low = min + (max - min) * bin / FIT_BIN_COUNT;
    const high = min + (max - min) * (bin + 1) / FIT_BIN_COUNT;
    const members = scored
      .filter(({ latent }) => latent >= low && (latent < high || bin === FIT_BIN_COUNT - 1))
      .sort((left, right) => left.residual - right.residual || left.hash - right.hash);
    if (members.length === 0) continue;
    selected.push(...members.slice(0, Math.max(1, Math.ceil(members.length * 0.25)))
      .filter(({ residual }) => residual <= CURVE_MAX_CORRECTION * 2));
  }
  return selected;
}

function makeMonotoneCurve(bins: readonly ScoredSample[][], fit: ChannelFit, channel: 0 | 1 | 2): DensityCurve | undefined {
  const points = bins.map((members) => ({
    input: percentile(members.map(({ rgb }) => normalizeTriple(rgb, fit)[channel]), 0.5),
    output: percentile(members.map(({ latent }) => latent), 0.5),
    weight: members.length,
  }));
  // The physical density origin is raw D=0. After the affine seed that point
  // is generally not x=0, so anchor its transformed coordinate to neutral 0.
  points.push({
    input: -fit.offset[channel] / fit.slope[channel],
    output: 0,
    weight: Math.max(1, Math.round(points.reduce((sum, point) => sum + point.weight, 0) / points.length)),
  });
  points.sort((left, right) => left.input - right.input);

  const merged: typeof points = [];
  for (const point of points) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && Math.abs(previous.input - point.input) < 1e-6) {
      const total = previous.weight + point.weight;
      previous.output = (previous.output * previous.weight + point.output * point.weight) / total;
      previous.weight = total;
    } else {
      merged.push({ ...point });
    }
  }
  if (merged.length < 2) return undefined;
  const output = pava(merged.map(({ output }) => output), merged.map(({ weight }) => weight));
  const input = merged.map(({ input }) => input);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Math.min(input[index]! + CURVE_MAX_CORRECTION, Math.max(input[index]! - CURVE_MAX_CORRECTION, output[index]!));
  }
  if (
    input.some((value, index) => !Number.isFinite(value) || (index > 0 && value <= input[index - 1]!))
    || output.some((value, index) => !Number.isFinite(value) || (index > 0 && value < output[index - 1]!))
  ) return undefined;
  return { input, output };
}

function pava(values: readonly number[], weights: readonly number[]): number[] {
  const blocks: { start: number; end: number; value: number; weight: number }[] = [];
  for (let index = 0; index < values.length; index += 1) {
    blocks.push({ start: index, end: index, value: values[index]!, weight: weights[index]! });
    while (blocks.length >= 2) {
      const right = blocks[blocks.length - 1]!;
      const left = blocks[blocks.length - 2]!;
      if (left.value <= right.value) break;
      const weight = left.weight + right.weight;
      blocks.splice(blocks.length - 2, 2, {
        start: left.start,
        end: right.end,
        value: (left.value * left.weight + right.value * right.weight) / weight,
        weight,
      });
    }
  }
  const result = new Array<number>(values.length);
  for (const block of blocks) {
    for (let index = block.start; index <= block.end; index += 1) result[index] = block.value;
  }
  return result;
}

function acceptCurves(evaluation: readonly DensitySample[], fit: ChannelFit, curves: [DensityCurve, DensityCurve, DensityCurve]): boolean {
  // Both transforms are scored on the exact same held-out subset, frozen
  // before candidate selection and curve fitting.
  if (evaluation.length < 16) return false;
  const affine = scoreCorrection(evaluation, fit);
  const curved = scoreCorrection(evaluation, fit, curves);
  if (relativeImprovement(affine.combined, curved.combined) < CURVE_MIN_IMPROVEMENT) return false;
  if (curved.p90 > affine.p90 * 1.02 + 1e-6) return false;

  const densities = affine.entries.map(({ density }) => density);
  const lowThreshold = percentile(densities, 1 / 3);
  const highThreshold = percentile(densities, 2 / 3);
  const affineLow = scoreEntries(affine.entries.filter(({ density }) => density <= lowThreshold));
  const curveLow = scoreEntries(curved.entries.filter(({ density }) => density <= lowThreshold));
  const affineHigh = scoreEntries(affine.entries.filter(({ density }) => density >= highThreshold));
  const curveHigh = scoreEntries(curved.entries.filter(({ density }) => density >= highThreshold));
  return relativeImprovement(affineLow.combined, curveLow.combined) >= CURVE_MIN_IMPROVEMENT
    || relativeImprovement(affineHigh.combined, curveHigh.combined) >= CURVE_MIN_IMPROVEMENT;
}

function scoreCorrection(
  samples: readonly DensitySample[],
  fit?: ChannelFit,
  curves?: [DensityCurve, DensityCurve, DensityCurve],
): CorrectionScore {
  const entries = samples.map(({ rgb }) => {
    let corrected = fit === undefined ? rgb : normalizeTriple(rgb, fit);
    if (curves !== undefined) corrected = corrected.map((value, channel) => applyDensityCurve(value, curves[channel]!)) as Rgb;
    return { residual: channelSpread(corrected), density: median3(corrected[0], corrected[1], corrected[2]) };
  }).filter(({ residual, density }) => Number.isFinite(residual) && Number.isFinite(density));
  return scoreEntries(entries);
}

function scoreEntries(entries: { residual: number; density: number }[]): CorrectionScore {
  if (entries.length === 0) return { median: Number.POSITIVE_INFINITY, p90: Number.POSITIVE_INFINITY, combined: Number.POSITIVE_INFINITY, entries };
  const residuals = entries.map(({ residual }) => residual);
  const median = percentile(residuals, 0.5);
  const p90 = percentile(residuals, 0.9);
  return { median, p90, combined: median * 0.7 + p90 * 0.3, entries };
}

function normalizeFit(fit: ChannelFit): ChannelFit {
  const meanSlope = mean3(fit.slope);
  const slope = fit.slope.map((value) => value / meanSlope) as Rgb;
  const meanOffset = mean3(fit.offset);
  return { slope, offset: fit.offset.map((value, channel) => value - slope[channel]! * meanOffset) as Rgb };
}

function normalizeTriple(rgb: Rgb, fit: ChannelFit): Rgb {
  return [
    (rgb[0] - fit.offset[0]) / fit.slope[0],
    (rgb[1] - fit.offset[1]) / fit.slope[1],
    (rgb[2] - fit.offset[2]) / fit.slope[2],
  ];
}

function validFit(fit: ChannelFit): boolean {
  return fit.slope.every((value) => Number.isFinite(value) && value >= 0.2 && value <= 5)
    && fit.offset.every((value) => Number.isFinite(value) && Math.abs(value) <= 2);
}

function isIdentityFit(fit: ChannelFit): boolean {
  return fit.slope.every((value) => Math.abs(value - 1) <= IDENTITY_TOLERANCE)
    && fit.offset.every((value) => Math.abs(value) <= IDENTITY_TOLERANCE);
}

function relativeImprovement(before: number, after: number): number {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 1e-9) return 0;
  return (before - after) / before;
}

function weightedCenter(samples: readonly DensitySample[], weights: readonly number[]): Rgb {
  const total = Math.max(1e-9, weights.reduce((sum, value) => sum + value, 0));
  return [0, 1, 2].map((channel) => samples.reduce(
    (sum, sample, index) => sum + sample.rgb[channel]! * weights[index]!,
    0,
  ) / total) as Rgb;
}

function weightedCovariance(samples: readonly DensitySample[], center: Rgb, weights: readonly number[]): number[][] {
  const covariance = Array.from({ length: 3 }, () => [0, 0, 0]);
  let total = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const weight = weights[index]!;
    if (weight <= 0) continue;
    const delta = samples[index]!.rgb.map((value, channel) => value - center[channel]!) as Rgb;
    total += weight;
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        covariance[row]![column] = covariance[row]![column]! + weight * delta[row]! * delta[column]!;
      }
    }
  }
  const divisor = Math.max(1e-9, total);
  return covariance.map((row) => row.map((value) => value / divisor));
}

function principalAxis(covariance: readonly number[][], seed: Rgb): Rgb {
  let vector = unitVector(seed);
  for (let iteration = 0; iteration < PCA_POWER_ITERATIONS; iteration += 1) {
    vector = unitVector([0, 1, 2].map((row) => (
      covariance[row]![0]! * vector[0]
      + covariance[row]![1]! * vector[1]
      + covariance[row]![2]! * vector[2]
    )) as Rgb);
  }
  return vector;
}

function unitVector(vector: Rgb): Rgb {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length <= 1e-12 || !Number.isFinite(length)
    ? [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)]
    : vector.map((value) => value / length) as Rgb;
}

function orthogonalResidual(rgb: Rgb, center: Rgb, axis: Rgb): number {
  const delta = rgb.map((value, channel) => value - center[channel]!) as Rgb;
  const projection = delta[0] * axis[0] + delta[1] * axis[1] + delta[2] * axis[2];
  return Math.hypot(
    delta[0] - projection * axis[0],
    delta[1] - projection * axis[1],
    delta[2] - projection * axis[2],
  );
}

function sampleSpan(samples: readonly DensitySample[]): number {
  if (samples.length < 2) return 0;
  const means = samples.map(({ rgb }) => mean3(rgb));
  return percentile(means, 0.995) - percentile(means, 0.005);
}

function channelSpread(rgb: Rgb): number {
  return Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
}

function mean3(rgb: Rgb): number {
  return (rgb[0] + rgb[1] + rgb[2]) / 3;
}

function median3(a: number, b: number, c: number): number {
  return a + b + c - Math.min(a, b, c) - Math.max(a, b, c);
}

function spatialHash(x: number, y: number): number {
  let value = Math.imul(x + 1, 0x1f123bb5) ^ Math.imul(y + 1, 0x5f356495);
  value ^= value >>> 16;
  value = Math.imul(value, 0x45d9f3b);
  value ^= value >>> 16;
  return value >>> 0;
}

function terminalSlope(curve: DensityCurve, left: number, right: number): number {
  const span = curve.input[right]! - curve.input[left]!;
  const slope = span <= 0 ? 1 : (curve.output[right]! - curve.output[left]!) / span;
  return Math.min(4, Math.max(0.25, Number.isFinite(slope) ? slope : 1));
}

/** Single-anchor fallback for a user-drawn neutral ROI. */
function rangeFitFromRoi(triples: readonly Rgb[], highPercentile: number): ChannelFit | undefined {
  if (triples.length === 0) return undefined;
  const channels: [number[], number[], number[]] = [[], [], []];
  for (const triple of triples) {
    channels[0].push(triple[0]);
    channels[1].push(triple[1]);
    channels[2].push(triple[2]);
  }
  return {
    offset: [0, 0, 0],
    slope: [
      Math.max(0.05, percentile(channels[0], highPercentile)),
      Math.max(0.05, percentile(channels[1], highPercentile)),
      Math.max(0.05, percentile(channels[2], highPercentile)),
    ],
  };
}

/** Conservative low-chroma, high-density single-anchor fallback. */
function tailAnchorFit(
  neutralDensities: readonly number[],
  triples: readonly Rgb[],
  highPercentile: number,
): ChannelFit | undefined {
  if (triples.length < 32) return undefined;
  const threshold = percentile(neutralDensities, Math.max(0.99, highPercentile));
  const candidates: [number[], number[], number[]] = [[], [], []];
  for (let index = 0; index < triples.length; index += 1) {
    const triple = triples[index]!;
    const mean = neutralDensities[index]!;
    if (mean >= threshold && channelSpread(triple) <= Math.max(0.08, mean * 0.16)) {
      candidates[0].push(triple[0]);
      candidates[1].push(triple[1]);
      candidates[2].push(triple[2]);
    }
  }
  if (candidates[0].length < 8) return undefined;
  return {
    offset: [0, 0, 0],
    slope: [
      Math.max(0.05, percentile(candidates[0], 0.5)),
      Math.max(0.05, percentile(candidates[1], 0.5)),
      Math.max(0.05, percentile(candidates[2], 0.5)),
    ],
  };
}
