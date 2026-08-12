import { validateRoi } from "./geometry.ts";
import { regularizePhotonTransferSignal } from "./photon-transfer.ts";
import { Raster } from "./raster.ts";
import type { BaseSample, DensityAnchorOptions, DensityAnchors, NormalizedRoi, PhotonTransferModel, Rgb } from "./types.ts";

const DEFAULT_EPSILON = 1e-6;

export function sampleFilmBase(transmission: Raster, roi: NormalizedRoi): BaseSample {
  transmission.assertDomain("transmission-linear-rgb");
  validateRoi(roi);

  const samples = collectChannelSamples(transmission, roi);
  if (samples.count < 3) {
    throw new Error("Film-base ROI must contain at least three pixels.");
  }

  const medians: Rgb = [
    medianTypedCopy(samples.red, samples.count),
    medianTypedCopy(samples.green, samples.count),
    medianTypedCopy(samples.blue, samples.count),
  ];
  const deviations = new Float32Array(samples.count);
  const mad = (values: Float32Array, center: number): number => {
    for (let index = 0; index < samples.count; index += 1) {
      deviations[index] = Math.abs(values[index] - center);
    }
    return medianInPlace(deviations, samples.count);
  };
  const mads: Rgb = [
    mad(samples.red, medians[0]),
    mad(samples.green, medians[1]),
    mad(samples.blue, medians[2]),
  ];

  const filteredRed = new Float32Array(samples.count);
  const filteredGreen = new Float32Array(samples.count);
  const filteredBlue = new Float32Array(samples.count);
  let filteredCount = 0;
  const thresholds: Rgb = [
    Math.max(mads[0] * 6, DEFAULT_EPSILON),
    Math.max(mads[1] * 6, DEFAULT_EPSILON),
    Math.max(mads[2] * 6, DEFAULT_EPSILON),
  ];
  for (let index = 0; index < samples.count; index += 1) {
    const red = samples.red[index];
    const green = samples.green[index];
    const blue = samples.blue[index];
    if (
      Math.abs(red - medians[0]) <= thresholds[0]
      && Math.abs(green - medians[1]) <= thresholds[1]
      && Math.abs(blue - medians[2]) <= thresholds[2]
    ) {
      filteredRed[filteredCount] = red;
      filteredGreen[filteredCount] = green;
      filteredBlue[filteredCount] = blue;
      filteredCount += 1;
    }
  }
  const useFiltered = filteredCount >= 3;
  const usableCount = useFiltered ? filteredCount : samples.count;
  const base: Rgb = useFiltered
    ? [
      medianInPlace(filteredRed, filteredCount),
      medianInPlace(filteredGreen, filteredCount),
      medianInPlace(filteredBlue, filteredCount),
    ]
    : medians;

  if (base.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("Film-base ROI contains no usable positive transmission samples.");
  }

  return {
    rgb: base,
    sampleCount: usableCount,
    rejectedCount: samples.count - usableCount,
    method: "roi",
    confidence: usableCount / samples.count,
  };
}

/** Uses a previously measured film-base transmission value. This is the
 * preferred path when the delivered crop contains no unexposed film border. */
export function referenceFilmBase(rgb: Rgb, confidence = 1): BaseSample {
  if (
    rgb.some((value) => !Number.isFinite(value) || value <= 0 || value > 16)
    || !Number.isFinite(confidence)
    || confidence < 0
    || confidence > 1
  ) {
    throw new Error("Film-base reference values and confidence must be finite and valid.");
  }
  return { rgb: [...rgb] as Rgb, sampleCount: 0, rejectedCount: 0, method: "reference", confidence };
}

/**
 * Estimates the film-base upper transmission envelope when no border or
 * separate reference is available. This cannot identify the true Dmin from a
 * single cropped scene, so confidence is deliberately capped below 0.7.
 */
export function estimateFilmBase(transmission: Raster, upperPercentile = 0.9995): BaseSample {
  transmission.assertDomain("transmission-linear-rgb");
  if (!Number.isFinite(upperPercentile) || upperPercentile < 0.98 || upperPercentile > 1) {
    throw new Error("Automatic film-base percentile must be between 0.98 and 1.");
  }

  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  const pixelCount = transmission.width * transmission.height;
  const stride = Math.max(1, Math.ceil(pixelCount / 65_536));
  for (let pixel = 0; pixel < pixelCount; pixel += stride) {
    const offset = pixel * 3;
    const values = [transmission.data[offset], transmission.data[offset + 1], transmission.data[offset + 2]];
    if (values.every((value) => Number.isFinite(value) && value > 0)) {
      red.push(values[0]);
      green.push(values[1]);
      blue.push(values[2]);
    }
  }
  if (red.length < 32) {
    throw new Error("Automatic film-base estimation requires at least 32 valid pixels.");
  }

  const base: Rgb = [
    percentile(red, upperPercentile),
    percentile(green, upperPercentile),
    percentile(blue, upperPercentile),
  ];
  if (base.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("Automatic film-base estimation found no positive upper envelope.");
  }

  // A plausible base candidate must be jointly close to the high-transmission
  // envelope in all three channels. Coloured scene highlights that reach only
  // one channel therefore do not create false high confidence.
  const scores = red.map((value, index) => Math.min(
    value / base[0],
    green[index] / base[1],
    blue[index] / base[2],
  ));
  const candidateThreshold = percentile(scores, 0.99);
  const candidateIndices = scores.flatMap((score, index) => score >= candidateThreshold ? [index] : []);
  const selected = candidateIndices.length >= 3 ? candidateIndices : scores.map((_score, index) => index);
  const channelMads = ([red, green, blue] as const).map((channel, channelIndex) => {
    const deviations = selected.map((index) => Math.abs(channel[index] - base[channelIndex]));
    return percentile(deviations, 0.5) / Math.max(base[channelIndex], DEFAULT_EPSILON);
  });
  const uniformity = clamp01(1 - Math.max(...channelMads) * 24);
  const jointHighCount = scores.filter((score) => score >= 0.985).length;
  const support = clamp01(jointHighCount / Math.max(4, red.length * 0.001));
  const coherence = clamp01(percentile(selected.map((index) => scores[index]), 0.5));
  const confidence = Math.min(0.65, 0.18 + uniformity * 0.22 + support * 0.15 + coherence * 0.1);

  return {
    rgb: base,
    sampleCount: selected.length,
    rejectedCount: red.length - selected.length,
    method: "automatic",
    confidence,
  };
}

export function toRelativeDensity(
  transmission: Raster,
  base: Rgb,
  epsilon = DEFAULT_EPSILON,
  photonTransfer?: PhotonTransferModel,
): Raster {
  transmission.assertDomain("transmission-linear-rgb");
  if (!Number.isFinite(epsilon) || epsilon <= 0 || base.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("Base transmission values and epsilon must be positive finite values.");
  }

  const density = new Raster(transmission.width, transmission.height, "relative-density");
  for (let offset = 0; offset < transmission.data.length; offset += 3) {
    for (let channel = 0; channel < 3; channel += 1) {
      const signal = photonTransfer === undefined
        ? transmission.data[offset + channel]
        : regularizePhotonTransferSignal(
            transmission.data[offset + channel],
            photonTransfer.normalizationRangeDn[channel],
            photonTransfer,
          );
      density.data[offset + channel] = -Math.log10(Math.max(signal / base[channel], epsilon));
    }
  }
  return density;
}

/**
 * Measure the two density anchors used by film-inversion tools. Dmin is the
 * mean optical density of the sampled film base relative to normalized scan
 * white. Dmax adds the 99.5th percentile of neutral relative density, which
 * avoids letting a few dust/scratch pixels define the usable film range.
 */
export function measureDensityAnchors(
  base: Rgb,
  density: Raster,
  highPercentile = 0.995,
  options: DensityAnchorOptions = {},
): DensityAnchors {
  density.assertDomain("relative-density");
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
  if (options.dmaxRoi !== undefined) validateRoi(options.dmaxRoi);

  const dmin = base.reduce(
    (sum, value) => sum - Math.log10(Math.min(1, Math.max(DEFAULT_EPSILON, value))),
    0,
  ) / 3;
  const neutralDensities: number[] = [];
  const roi = options.dmaxRoi;
  const left = roi === undefined ? 0 : Math.floor(roi.x * density.width);
  const top = roi === undefined ? 0 : Math.floor(roi.y * density.height);
  const right = roi === undefined ? density.width : Math.ceil((roi.x + roi.width) * density.width);
  const bottom = roi === undefined ? density.height : Math.ceil((roi.y + roi.height) * density.height);
  const samplePixelCount = Math.max(1, (right - left) * (bottom - top));
  const pixelCount = density.width * density.height;
  const sampleStride = Math.max(1, Math.ceil((roi === undefined ? pixelCount : samplePixelCount) / 65_536));
  let sampledPixel = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (sampledPixel % sampleStride !== 0) {
        sampledPixel += 1;
        continue;
      }
      sampledPixel += 1;
      const offset = (y * density.width + x) * 3;
      const value = (
        Math.max(0, density.data[offset])
        + Math.max(0, density.data[offset + 1])
        + Math.max(0, density.data[offset + 2])
      ) / 3;
      if (Number.isFinite(value)) neutralDensities.push(value);
    }
  }
  if (neutralDensities.length === 0) {
    throw new Error("Density raster contains no usable samples.");
  }

  const automaticRange = percentile(neutralDensities, highPercentile);
  const range = options.dmaxOverride === undefined
    ? automaticRange
    : Math.max(0, options.dmaxOverride - dmin);
  return { dmin, dmax: dmin + range, range };
}

function collectChannelSamples(transmission: Raster, roi: NormalizedRoi): ChannelSamples {
  const left = Math.floor(roi.x * transmission.width);
  const top = Math.floor(roi.y * transmission.height);
  const right = Math.ceil((roi.x + roi.width) * transmission.width);
  const bottom = Math.ceil((roi.y + roi.height) * transmission.height);
  const capacity = Math.max(0, right - left) * Math.max(0, bottom - top);
  const red = new Float32Array(capacity);
  const green = new Float32Array(capacity);
  const blue = new Float32Array(capacity);
  let count = 0;

  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * transmission.width + x) * 3;
      const redValue = transmission.data[offset];
      const greenValue = transmission.data[offset + 1];
      const blueValue = transmission.data[offset + 2];
      if (
        Number.isFinite(redValue) && redValue > 0
        && Number.isFinite(greenValue) && greenValue > 0
        && Number.isFinite(blueValue) && blueValue > 0
      ) {
        red[count] = redValue;
        green[count] = greenValue;
        blue[count] = blueValue;
        count += 1;
      }
    }
  }
  return { red, green, blue, count };
}

function medianTypedCopy(values: Float32Array, length: number): number {
  return medianInPlace(values.slice(0, length), length);
}

function medianInPlace(values: Float32Array, length: number): number {
  if (length === 0) {
    throw new Error("Cannot calculate a median of an empty set.");
  }
  const middle = Math.floor(length / 2);
  const upper = quickSelect(values, middle, length);
  return length % 2 === 0
    ? (quickSelect(values, middle - 1, length) + upper) / 2
    : upper;
}

function quickSelect(values: Float32Array, target: number, length: number): number {
  let left = 0;
  let right = length - 1;
  while (left < right) {
    const pivot = values[(left + right) >>> 1];
    let low = left;
    let high = right;
    while (low <= high) {
      while (values[low] < pivot) low += 1;
      while (values[high] > pivot) high -= 1;
      if (low <= high) {
        const value = values[low];
        values[low] = values[high];
        values[high] = value;
        low += 1;
        high -= 1;
      }
    }
    if (target <= high) {
      right = high;
    } else if (target >= low) {
      left = low;
    } else {
      return values[target];
    }
  }
  return values[target];
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

interface ChannelSamples {
  readonly red: Float32Array;
  readonly green: Float32Array;
  readonly blue: Float32Array;
  readonly count: number;
}
