import { validateRect } from "./geometry.ts";
import { Raster, percentile } from "./raster.ts";
import type { ChannelFit, DensityAnchors, Rect, Rgb } from "./types.ts";

const DEFAULT_EPSILON = 1e-6;
const SAMPLE_CAP = 65_536;

/**
 * Converts linear transmission to relative density per channel:
 * D = -log10(T / Tbase). Corrupt or non-finite samples map to the film base
 * (density 0) so a single broken pixel cannot fail the whole frame.
 */
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
  const source = linear.data;
  const target = density.data;
  for (let offset = 0; offset < source.length; offset += 3) {
    for (let channel = 0; channel < 3; channel += 1) {
      const ratio = source[offset + channel]! / base[channel]!;
      // Non-finite samples map to the film base; negative or zero samples
      // (physically impossible transmission) map to extreme density, which
      // the inversion stage caps at 4x the measured anchor.
      const safeRatio = Number.isFinite(ratio) ? Math.max(0, ratio) : 1;
      const logged = Math.log10(Math.max(safeRatio, epsilon));
      target[offset + channel] = logged === 0 ? 0 : -logged;
    }
  }
  return density;
}

export interface DensityAnchorOptions {
  /** Absolute density override; `range` becomes max(0, override - dmin). */
  dmaxOverride?: number;
  /** Per-channel range measured inside this ROI (normalized coords). */
  neutralRoi?: Rect;
  /** Infer a per-channel range from a convincingly neutral high-density tail. */
  autoNeutralize?: boolean;
}

/**
 * Measures Dmin (optical density of the sampled film base relative to scan
 * white) and Dmax (99.5th percentile of neutral relative density, so a few
 * dust pixels cannot define the usable range). A neutral ROI or heuristic
 * additionally provides a per-channel density range for mask neutralisation.
 */
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

  // Neutral density per pixel, stride-sampled so huge frames stay bounded.
  const roi = options.neutralRoi;
  const left = roi === undefined ? 0 : Math.floor(roi.x * density.width);
  const top = roi === undefined ? 0 : Math.floor(roi.y * density.height);
  const right = roi === undefined ? density.width : Math.ceil((roi.x + roi.width) * density.width);
  const bottom = roi === undefined ? density.height : Math.ceil((roi.y + roi.height) * density.height);
  const roiPixels = Math.max(1, (right - left) * (bottom - top));
  const stride = Math.max(1, Math.ceil((roi === undefined ? density.width * density.height : roiPixels) / SAMPLE_CAP));

  const neutralDensities: number[] = [];
  const triples: Rgb[] = [];
  let sampled = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (sampled % stride !== 0) {
        sampled += 1;
        continue;
      }
      sampled += 1;
      const offset = Raster.offsetOf(x, y, density.width);
      const rgb: Rgb = [
        Math.max(0, density.data[offset]!),
        Math.max(0, density.data[offset + 1]!),
        Math.max(0, density.data[offset + 2]!),
      ];
      if (rgb.every((value) => Number.isFinite(value))) {
        neutralDensities.push((rgb[0] + rgb[1] + rgb[2]) / 3);
        triples.push(rgb);
      }
    }
  }
  if (neutralDensities.length === 0) {
    throw new Error("密度栅格中没有可用样本。");
  }

  const range = options.dmaxOverride === undefined
    ? percentile(neutralDensities, highPercentile)
    : Math.max(0, options.dmaxOverride - dmin);
  const dmax = dmin + range;

  const channelFit = roi !== undefined
    ? resolveChannelFit(triples, neutralDensities, highPercentile, true)
    : options.autoNeutralize === true
      ? resolveChannelFit(triples, neutralDensities, highPercentile, false)
      : undefined;

  return channelFit === undefined
    ? { dmin, dmax, range }
    : { dmin, dmax, range, channelFit };
}

/**
 * Prefers a robust affine fit over near-neutral pixels (handles residual
 * per-channel offsets and contrast differences across the whole tonal
 * range), then falls back to the single-anchor methods of the original
 * implementation when the fit has too little support. A result close to
 * identity is suppressed either way: an effectively neutral negative needs
 * no correction, and suppressing it keeps colourful scenes from receiving
 * a phantom "calibration".
 */
function resolveChannelFit(
  triples: readonly Rgb[],
  neutralDensities: readonly number[],
  highPercentile: number,
  roiMode: boolean,
): ChannelFit | undefined {
  const fit = fitNeutralResponse(triples)
    ?? (roiMode
      ? rangeFitFromRoi(triples, highPercentile)
      : tailAnchorFit(neutralDensities, triples, highPercentile));
  if (fit === undefined) return undefined;
  const isIdentity = fit.slope.every((value) => Math.abs(value - 1) <= IDENTITY_TOLERANCE)
    && fit.offset.every((value) => Math.abs(value) <= IDENTITY_TOLERANCE);
  return isIdentity ? undefined : fit;
}

const FIT_MIN_CANDIDATES = 24;
const FIT_MIN_BINS = 5;
const FIT_MIN_SPREAD = 0.1;
const FIT_MAX_CANDIDATES = 2048;
const FIT_BIN_COUNT = 32;
const IDENTITY_TOLERANCE = 0.03;

/**
 * Robust per-channel affine fit density_c ≈ offset_c + slope_c × neutral.
 * Near-neutral pixels are binned by mean density (per-bin channel medians
 * absorb outliers), then each channel gets a Theil–Sen line through the
 * binned points: the median of pairwise slopes and of intercepts is stable
 * even when a share of the candidates is coloured content that slipped
 * through the chroma gate. Near-identity suppression happens in the caller.
 */
function fitNeutralResponse(triples: readonly Rgb[]): ChannelFit | undefined {
  let candidates: Rgb[] = [];
  let candidateMeans: number[] = [];
  for (const triple of triples) {
    const mean = (triple[0] + triple[1] + triple[2]) / 3;
    const chroma = Math.max(triple[0], triple[1], triple[2]) - Math.min(triple[0], triple[1], triple[2]);
    if (chroma <= Math.max(0.08, mean * 0.25)) {
      candidates.push(triple);
      candidateMeans.push(mean);
    }
  }
  if (candidates.length < FIT_MIN_CANDIDATES) return undefined;
  if (candidates.length > FIT_MAX_CANDIDATES) {
    const stride = Math.ceil(candidates.length / FIT_MAX_CANDIDATES);
    candidates = candidates.filter((_, index) => index % stride === 0);
    candidateMeans = candidateMeans.filter((_, index) => index % stride === 0);
  }
  const minMean = Math.min(...candidateMeans);
  const maxMean = Math.max(...candidateMeans);
  if (maxMean - minMean < FIT_MIN_SPREAD) return undefined;

  // Bin by mean density; the per-channel median of each bin is one robust
  // point, keeping the Theil–Sen stage small and outlier-resistant.
  const bins: { mean: number; rgb: Rgb }[] = [];
  for (let bin = 0; bin < FIT_BIN_COUNT; bin += 1) {
    const low = minMean + (maxMean - minMean) * bin / FIT_BIN_COUNT;
    const high = minMean + (maxMean - minMean) * (bin + 1) / FIT_BIN_COUNT;
    const members: Rgb[] = [];
    const means: number[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const mean = candidateMeans[index]!;
      if (mean >= low && (mean < high || bin === FIT_BIN_COUNT - 1)) {
        members.push(candidates[index]!);
        means.push(mean);
      }
    }
    if (members.length < 3) continue;
    const rgb: Rgb = [
      percentile(members.map((triple) => triple[0]), 0.5),
      percentile(members.map((triple) => triple[1]), 0.5),
      percentile(members.map((triple) => triple[2]), 0.5),
    ];
    bins.push({ mean: percentile(means, 0.5), rgb });
  }
  if (bins.length < FIT_MIN_BINS) return undefined;

  const slope: Rgb = [0, 0, 0];
  const offset: Rgb = [0, 0, 0];
  for (let channel = 0; channel < 3; channel += 1) {
    const pairwise: number[] = [];
    for (let left = 0; left < bins.length; left += 1) {
      for (let right = left + 1; right < bins.length; right += 1) {
        const delta = bins[right]!.mean - bins[left]!.mean;
        if (delta >= 0.02) {
          pairwise.push((bins[right]!.rgb[channel]! - bins[left]!.rgb[channel]!) / delta);
        }
      }
    }
    if (pairwise.length < 4) return undefined;
    slope[channel] = percentile(pairwise, 0.5);
    offset[channel] = percentile(bins.map((point) => point.rgb[channel]! - slope[channel]! * point.mean), 0.5);
  }
  if (
    slope.some((value) => !Number.isFinite(value) || value < 0.2 || value > 5)
    || offset.some((value) => !Number.isFinite(value) || Math.abs(value) > 2)
  ) {
    return undefined;
  }
  return { offset, slope };
}

/** Single-anchor fallback for a user-drawn neutral ROI: per-channel 99.5th
 * percentile, normalized through the origin as before. */
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

/**
 * Conservative single-anchor fallback: only activates when the high-density
 * tail contains enough low-chroma samples, so a colourful scene keeps the
 * plain relative transform instead of being forced towards grey.
 */
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
    const maximum = Math.max(triple[0], triple[1], triple[2]);
    const minimum = Math.min(triple[0], triple[1], triple[2]);
    const mean = neutralDensities[index]!;
    if (mean >= threshold && maximum - minimum <= Math.max(0.08, mean * 0.16)) {
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
