import { Raster } from "./raster.ts";

/**
 * Restoration filters operate on linear-light RGB samples and preserve the raster's
 * declared domain. They are suitable for camera-, transmission-, scene-, and
 * display-linear rasters, but deliberately reject non-finite input. Thresholds are
 * absolute linear values, so callers should normalize captures consistently before
 * applying a shared preset. Do not apply these filters to gamma-encoded JPEG/sRGB
 * code values.
 */

const LUMA = [0.2126, 0.7152, 0.0722] as const;
const EPSILON = 1e-8;

export type RepairStage =
  | "dust-detection"
  | "dust-removal"
  | "scratch-detection"
  | "scratch-removal"
  | "denoise"
  | "sharpen-blur"
  | "sharpen";

export interface RepairProgress {
  readonly stage: RepairStage;
  readonly completed: number;
  readonly total: number;
  readonly fraction: number;
}

/** Optional synchronous-operation hooks. Cancellation is checked once per image row. */
export interface RepairControl {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: RepairProgress) => void;
}

export class RepairAbortedError extends Error {
  public constructor() {
    super("Image restoration was cancelled.");
    this.name = "RepairAbortedError";
  }
}

export interface RepairMask {
  readonly width: number;
  readonly height: number;
  /** One means the pixel should be repaired; zero means leave it untouched. */
  readonly data: Uint8Array;
}

export interface ScratchMask extends RepairMask {
  /** Pixels diagnosed as a vertical scratch and therefore sampled left-to-right. */
  readonly vertical: Uint8Array;
  /** Pixels diagnosed as a horizontal scratch and therefore sampled top-to-bottom. */
  readonly horizontal: Uint8Array;
}

export type DefectPolarity = "dark" | "bright" | "both";
export type ScratchOrientation = "vertical" | "horizontal" | "both";

export interface DustDetectionSettings {
  /** Half-width of the local square neighbourhood. Defaults to 1 pixel. */
  readonly radius?: number;
  /** Robust-MAD multiplier required for a pixel to be considered an outlier. */
  readonly threshold?: number;
  /** Lower bound on the absolute linear-light difference. */
  readonly minDifference?: number;
  /** Require this many RGB channels to agree with the luminance outlier. */
  readonly minimumAffectedChannels?: 1 | 2 | 3;
  readonly polarity?: DefectPolarity;
}

export interface DustRemovalSettings {
  /** Half-width of the donor neighbourhood. Defaults to 2 pixels. */
  readonly repairRadius?: number;
}

export interface DustRepairSettings {
  readonly detection?: DustDetectionSettings;
  readonly removal?: DustRemovalSettings;
}

export interface ScratchDetectionSettings {
  readonly orientation?: ScratchOrientation;
  /** Distance on each side used as a clean reference. Defaults to 2 pixels. */
  readonly halfWidth?: number;
  /** Minimum contiguous extent of a candidate scratch. Defaults to 8 pixels. */
  readonly minLength?: number;
  /** Multiplier for disagreement between the two reference sides. */
  readonly threshold?: number;
  /** Lower bound on the absolute linear-light difference. */
  readonly minDifference?: number;
  readonly polarity?: DefectPolarity;
}

export interface ScratchRepairSettings {
  readonly detection?: ScratchDetectionSettings;
}

export interface EdgePreservingDenoiseSettings {
  /** Spatial radius in pixels. Zero is a no-op. Defaults to 2. */
  readonly radius?: number;
  readonly spatialSigma?: number;
  /** Luminance difference (in linear light) controlling the bilateral fall-off. */
  readonly rangeSigma?: number;
  readonly iterations?: number;
}

export interface UnsharpSettings {
  /** Gaussian radius in pixels. Zero is a no-op. Defaults to 1. */
  readonly radius?: number;
  readonly sigma?: number;
  /** Amount of high-frequency detail added back. Defaults to 0.75. */
  readonly amount?: number;
  /** Do not sharpen channel differences smaller than this linear-light value. */
  readonly threshold?: number;
}

export interface DustRepairResult {
  readonly image: Raster;
  readonly mask: RepairMask;
}

export interface ScratchRepairResult {
  readonly image: Raster;
  readonly mask: ScratchMask;
}

export interface RestorationSettings {
  readonly dust?: false | DustRepairSettings;
  readonly scratches?: false | ScratchRepairSettings;
  readonly denoise?: false | EdgePreservingDenoiseSettings;
  readonly sharpen?: false | UnsharpSettings;
}

export interface RestorationResult {
  readonly image: Raster;
  readonly dustMask?: RepairMask;
  readonly scratchMask?: ScratchMask;
}

/**
 * Detects isolated dust and pinhole defects using a local median and MAD estimate.
 * The returned mask is immutable by convention; pass it to removeDust to repair
 * exactly the reviewed/edited set of pixels.
 */
export function detectDust(
  source: Raster,
  settings: DustDetectionSettings = {},
  control: RepairControl = {},
): RepairMask {
  assertFiniteRaster(source);
  const options = normalizeDustDetection(settings);
  const mask = new Uint8Array(source.width * source.height);
  const values: number[] = [];
  const redValues: number[] = [];
  const greenValues: number[] = [];
  const blueValues: number[] = [];

  report(control, "dust-detection", 0, source.height);
  for (let y = 0; y < source.height; y += 1) {
    throwIfAborted(control.signal);
    for (let x = 0; x < source.width; x += 1) {
      values.length = 0;
      redValues.length = 0;
      greenValues.length = 0;
      blueValues.length = 0;
      collectNeighbourhood(source, x, y, options.radius, values, redValues, greenValues, blueValues);
      if (values.length < 3) {
        continue;
      }

      const offset = (y * source.width + x) * 3;
      const centerLuma = luminance(source.data[offset], source.data[offset + 1], source.data[offset + 2]);
      const lumaMedian = median(values);
      const lumaScale = robustScale(values, lumaMedian);
      const difference = centerLuma - lumaMedian;
      const requiredDifference = Math.max(options.minDifference, options.threshold * lumaScale);
      if (!matchesPolarity(difference, requiredDifference, options.polarity)) {
        continue;
      }

      const channelValues = [redValues, greenValues, blueValues] as const;
      let affectedChannels = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const channelMedian = median(channelValues[channel]);
        const channelDifference = source.data[offset + channel] - channelMedian;
        const channelRequired = Math.max(options.minDifference, options.threshold * robustScale(channelValues[channel], channelMedian));
        if (matchesPolarity(channelDifference, channelRequired, options.polarity)) {
          affectedChannels += 1;
        }
      }
      if (affectedChannels >= options.minimumAffectedChannels) {
        mask[y * source.width + x] = 1;
      }
    }
    report(control, "dust-detection", y + 1, source.height);
  }
  return { width: source.width, height: source.height, data: mask };
}

/** Replaces flagged dust pixels from nearby unflagged pixels without changing the domain. */
export function removeDust(
  source: Raster,
  mask: RepairMask,
  settings: DustRemovalSettings = {},
  control: RepairControl = {},
): Raster {
  assertFiniteRaster(source);
  assertMask(mask, source, "dust");
  const repairRadius = positiveInteger(settings.repairRadius ?? 2, "repairRadius", 1, 32);
  return inpaintMask(source, mask, repairRadius, "dust-removal", control);
}

/** Detects then repairs dust. Use the returned mask for a UI review/edit step when needed. */
export function repairDust(
  source: Raster,
  settings: DustRepairSettings = {},
  control: RepairControl = {},
): DustRepairResult {
  const mask = detectDust(source, settings.detection, control);
  return {
    image: removeDust(source, mask, settings.removal, control),
    mask,
  };
}

/**
 * Detects long, narrow bright or dark marks. Vertical marks are analysed against
 * clean pixels to their left and right; horizontal marks are analysed above/below.
 */
export function detectScratches(
  source: Raster,
  settings: ScratchDetectionSettings = {},
  control: RepairControl = {},
): ScratchMask {
  assertFiniteRaster(source);
  const options = normalizeScratchDetection(settings);
  const pixelCount = source.width * source.height;
  const vertical = new Uint8Array(pixelCount);
  const horizontal = new Uint8Array(pixelCount);

  report(control, "scratch-detection", 0, source.height);
  for (let y = 0; y < source.height; y += 1) {
    throwIfAborted(control.signal);
    for (let x = 0; x < source.width; x += 1) {
      const offset = (y * source.width + x) * 3;
      const center = luminance(source.data[offset], source.data[offset + 1], source.data[offset + 2]);
      const index = y * source.width + x;
      if (options.orientation !== "horizontal" && x >= options.halfWidth && x + options.halfWidth < source.width) {
        const left = luminanceAt(source, x - options.halfWidth, y);
        const right = luminanceAt(source, x + options.halfWidth, y);
        if (isScratchOutlier(center, left, right, options)) {
          vertical[index] = 1;
        }
      }
      if (options.orientation !== "vertical" && y >= options.halfWidth && y + options.halfWidth < source.height) {
        const above = luminanceAt(source, x, y - options.halfWidth);
        const below = luminanceAt(source, x, y + options.halfWidth);
        if (isScratchOutlier(center, above, below, options)) {
          horizontal[index] = 1;
        }
      }
    }
    report(control, "scratch-detection", y + 1, source.height);
  }

  retainRuns(vertical, source.width, source.height, "vertical", options.minLength);
  retainRuns(horizontal, source.width, source.height, "horizontal", options.minLength);
  const data = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    data[index] = vertical[index] || horizontal[index] ? 1 : 0;
  }
  return { width: source.width, height: source.height, data, vertical, horizontal };
}

/** Repairs a reviewed scratch mask by interpolating across its narrow direction. */
export function removeScratches(
  source: Raster,
  mask: ScratchMask,
  control: RepairControl = {},
): Raster {
  assertFiniteRaster(source);
  assertMask(mask, source, "scratch");
  assertScratchMask(mask, source);
  const target = source.clone();

  report(control, "scratch-removal", 0, source.height);
  for (let y = 0; y < source.height; y += 1) {
    throwIfAborted(control.signal);
    for (let x = 0; x < source.width; x += 1) {
      const index = y * source.width + x;
      if (mask.data[index] === 0) {
        continue;
      }
      const candidates: readonly (readonly [number, number, number])[] = [
        ...(mask.vertical[index] === 1 ? [acrossScratch(source, mask.data, x, y, 1, 0)] : []),
        ...(mask.horizontal[index] === 1 ? [acrossScratch(source, mask.data, x, y, 0, 1)] : []),
      ].filter((candidate): candidate is readonly [number, number, number] => candidate !== undefined);
      if (candidates.length > 0) {
        const offset = index * 3;
        target.data[offset] = averageComponent(candidates, 0);
        target.data[offset + 1] = averageComponent(candidates, 1);
        target.data[offset + 2] = averageComponent(candidates, 2);
      }
    }
    report(control, "scratch-removal", y + 1, source.height);
  }
  return target;
}

/** Detects then repairs long scratches. */
export function repairScratches(
  source: Raster,
  settings: ScratchRepairSettings = {},
  control: RepairControl = {},
): ScratchRepairResult {
  const mask = detectScratches(source, settings.detection, control);
  return { image: removeScratches(source, mask, control), mask };
}

/** A deterministic RGB bilateral filter using linear-light luminance to preserve edges. */
export function denoiseEdgePreserving(
  source: Raster,
  settings: EdgePreservingDenoiseSettings = {},
  control: RepairControl = {},
): Raster {
  assertFiniteRaster(source);
  const options = normalizeDenoise(settings);
  if (options.radius === 0 || options.iterations === 0) {
    report(control, "denoise", 0, 0);
    return source.clone();
  }
  const spatialWeights = gaussianWeights(options.radius, options.spatialSigma);
  let input = source;
  const total = source.height * options.iterations;
  report(control, "denoise", 0, total);
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const target = new Raster(source.width, source.height, source.domain);
    for (let y = 0; y < source.height; y += 1) {
      throwIfAborted(control.signal);
      for (let x = 0; x < source.width; x += 1) {
        const offset = (y * source.width + x) * 3;
        const centerLuma = luminance(input.data[offset], input.data[offset + 1], input.data[offset + 2]);
        let weightSum = 0;
        let red = 0;
        let green = 0;
        let blue = 0;
        for (let dy = -options.radius; dy <= options.radius; dy += 1) {
          const sampleY = clamp(y + dy, 0, source.height - 1);
          for (let dx = -options.radius; dx <= options.radius; dx += 1) {
            const sampleX = clamp(x + dx, 0, source.width - 1);
            const sampleOffset = (sampleY * source.width + sampleX) * 3;
            const sampleLuma = luminance(input.data[sampleOffset], input.data[sampleOffset + 1], input.data[sampleOffset + 2]);
            const difference = sampleLuma - centerLuma;
            const rangeWeight = Math.exp(-(difference * difference) / (2 * options.rangeSigma * options.rangeSigma));
            const weight = spatialWeights[dy + options.radius][dx + options.radius] * rangeWeight;
            weightSum += weight;
            red += input.data[sampleOffset] * weight;
            green += input.data[sampleOffset + 1] * weight;
            blue += input.data[sampleOffset + 2] * weight;
          }
        }
        target.data[offset] = red / weightSum;
        target.data[offset + 1] = green / weightSum;
        target.data[offset + 2] = blue / weightSum;
      }
      report(control, "denoise", iteration * source.height + y + 1, total);
    }
    input = target;
  }
  return input;
}

/**
 * Adds thresholded high-frequency detail from a Gaussian blur. It never clips;
 * preserving HDR linear values is intentional and clipping belongs to tone mapping.
 */
export function sharpenUnsharp(
  source: Raster,
  settings: UnsharpSettings = {},
  control: RepairControl = {},
): Raster {
  assertFiniteRaster(source);
  const options = normalizeUnsharp(settings);
  if (options.radius === 0 || options.amount === 0) {
    report(control, "sharpen-blur", 0, 0);
    report(control, "sharpen", 0, 0);
    return source.clone();
  }

  const blurred = gaussianBlur(source, options.radius, options.sigma, control);
  const target = new Raster(source.width, source.height, source.domain);
  report(control, "sharpen", 0, source.height);
  for (let y = 0; y < source.height; y += 1) {
    throwIfAborted(control.signal);
    for (let x = 0; x < source.width; x += 1) {
      const offset = (y * source.width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const detail = source.data[offset + channel] - blurred.data[offset + channel];
        target.data[offset + channel] = Math.abs(detail) >= options.threshold
          ? source.data[offset + channel] + options.amount * detail
          : source.data[offset + channel];
      }
    }
    report(control, "sharpen", y + 1, source.height);
  }
  return target;
}

/**
 * Applies restoration in the safe order: defect replacement, edge-preserving
 * denoise, then unsharp masking. All stages receive the same cancellation/progress hooks.
 */
export function restoreRaster(
  source: Raster,
  settings: RestorationSettings = {},
  control: RepairControl = {},
): RestorationResult {
  assertFiniteRaster(source);
  let image = source;
  let dustMask: RepairMask | undefined;
  let scratchMask: ScratchMask | undefined;

  if (settings.dust !== false && settings.dust !== undefined) {
    const result = repairDust(image, settings.dust, control);
    image = result.image;
    dustMask = result.mask;
  }
  if (settings.scratches !== false && settings.scratches !== undefined) {
    const result = repairScratches(image, settings.scratches, control);
    image = result.image;
    scratchMask = result.mask;
  }
  if (settings.denoise !== false && settings.denoise !== undefined) {
    image = denoiseEdgePreserving(image, settings.denoise, control);
  }
  if (settings.sharpen !== false && settings.sharpen !== undefined) {
    image = sharpenUnsharp(image, settings.sharpen, control);
  }
  return { image: image === source ? source.clone() : image, dustMask, scratchMask };
}

/** Alias kept intentionally descriptive for callers that deal in complete images. */
export const restoreImage = restoreRaster;

function inpaintMask(
  source: Raster,
  mask: RepairMask,
  radius: number,
  stage: "dust-removal",
  control: RepairControl,
): Raster {
  // The mask is updated in place: entries whose defect cannot be reached by
  // any unmasked donor within radius are cleared, so the caller's mask always
  // describes the pixels that were actually repaired.
  const target = source.clone();
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];
  const distances: number[] = [];
  report(control, stage, 0, source.height);
  for (let y = 0; y < source.height; y += 1) {
    throwIfAborted(control.signal);
    for (let x = 0; x < source.width; x += 1) {
      const index = y * source.width + x;
      if (mask.data[index] === 0) {
        continue;
      }
      reds.length = 0;
      greens.length = 0;
      blues.length = 0;
      distances.length = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (dx === 0 && dy === 0) {
            continue;
          }
          const sampleX = x + dx;
          const sampleY = y + dy;
          if (sampleX < 0 || sampleX >= source.width || sampleY < 0 || sampleY >= source.height) {
            continue;
          }
          const sampleIndex = sampleY * source.width + sampleX;
          if (mask.data[sampleIndex] !== 0) {
            continue;
          }
          const sampleOffset = sampleIndex * 3;
          reds.push(source.data[sampleOffset]);
          greens.push(source.data[sampleOffset + 1]);
          blues.push(source.data[sampleOffset + 2]);
          distances.push(Math.hypot(dx, dy));
        }
      }
      if (reds.length > 0) {
        const targetOffset = index * 3;
        target.data[targetOffset] = weightedMedian(reds, distances);
        target.data[targetOffset + 1] = weightedMedian(greens, distances);
        target.data[targetOffset + 2] = weightedMedian(blues, distances);
      } else {
        // No unmasked donor within radius: keep the pixel's original value
        // and stop reporting it as repaired.
        mask.data[index] = 0;
      }
    }
    report(control, stage, y + 1, source.height);
  }
  return target;
}

function acrossScratch(
  source: Raster,
  mask: Uint8Array,
  x: number,
  y: number,
  stepX: number,
  stepY: number,
): readonly [number, number, number] | undefined {
  const before = nearestUnmasked(source, mask, x, y, -stepX, -stepY);
  const after = nearestUnmasked(source, mask, x, y, stepX, stepY);
  if (before === undefined && after === undefined) {
    return undefined;
  }
  if (before === undefined) {
    return after?.value;
  }
  if (after === undefined) {
    return before.value;
  }
  const totalDistance = before.distance + after.distance;
  return [
    (before.value[0] * after.distance + after.value[0] * before.distance) / totalDistance,
    (before.value[1] * after.distance + after.value[1] * before.distance) / totalDistance,
    (before.value[2] * after.distance + after.value[2] * before.distance) / totalDistance,
  ];
}

function nearestUnmasked(
  source: Raster,
  mask: Uint8Array,
  x: number,
  y: number,
  stepX: number,
  stepY: number,
): { readonly value: readonly [number, number, number]; readonly distance: number } | undefined {
  let sampleX = x + stepX;
  let sampleY = y + stepY;
  let distance = 1;
  while (sampleX >= 0 && sampleX < source.width && sampleY >= 0 && sampleY < source.height) {
    const index = sampleY * source.width + sampleX;
    if (mask[index] === 0) {
      const offset = index * 3;
      return {
        value: [source.data[offset], source.data[offset + 1], source.data[offset + 2]],
        distance,
      };
    }
    sampleX += stepX;
    sampleY += stepY;
    distance += 1;
  }
  return undefined;
}

function gaussianBlur(source: Raster, radius: number, sigma: number, control: RepairControl): Raster {
  const weights = gaussianWeights(radius, sigma);
  const target = new Raster(source.width, source.height, source.domain);
  report(control, "sharpen-blur", 0, source.height);
  for (let y = 0; y < source.height; y += 1) {
    throwIfAborted(control.signal);
    for (let x = 0; x < source.width; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let weightSum = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const sampleY = clamp(y + dy, 0, source.height - 1);
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sampleX = clamp(x + dx, 0, source.width - 1);
          const weight = weights[dy + radius][dx + radius];
          const offset = (sampleY * source.width + sampleX) * 3;
          weightSum += weight;
          red += source.data[offset] * weight;
          green += source.data[offset + 1] * weight;
          blue += source.data[offset + 2] * weight;
        }
      }
      const targetOffset = (y * source.width + x) * 3;
      target.data[targetOffset] = red / weightSum;
      target.data[targetOffset + 1] = green / weightSum;
      target.data[targetOffset + 2] = blue / weightSum;
    }
    report(control, "sharpen-blur", y + 1, source.height);
  }
  return target;
}

function collectNeighbourhood(
  source: Raster,
  x: number,
  y: number,
  radius: number,
  values: number[],
  redValues: number[],
  greenValues: number[],
  blueValues: number[],
): void {
  for (let dy = -radius; dy <= radius; dy += 1) {
    const sampleY = y + dy;
    if (sampleY < 0 || sampleY >= source.height) {
      continue;
    }
    for (let dx = -radius; dx <= radius; dx += 1) {
      const sampleX = x + dx;
      if ((dx === 0 && dy === 0) || sampleX < 0 || sampleX >= source.width) {
        continue;
      }
      const offset = (sampleY * source.width + sampleX) * 3;
      redValues.push(source.data[offset]);
      greenValues.push(source.data[offset + 1]);
      blueValues.push(source.data[offset + 2]);
      values.push(luminance(source.data[offset], source.data[offset + 1], source.data[offset + 2]));
    }
  }
}

function isScratchOutlier(center: number, firstSide: number, secondSide: number, options: Required<ScratchDetectionSettings>): boolean {
  const reference = (firstSide + secondSide) / 2;
  const sideDisagreement = Math.abs(firstSide - secondSide) / 2;
  const requiredDifference = Math.max(options.minDifference, options.threshold * Math.max(sideDisagreement, EPSILON));
  return matchesPolarity(center - reference, requiredDifference, options.polarity);
}

function retainRuns(data: Uint8Array, width: number, height: number, orientation: "vertical" | "horizontal", minLength: number): void {
  const outer = orientation === "vertical" ? width : height;
  const inner = orientation === "vertical" ? height : width;
  for (let outerIndex = 0; outerIndex < outer; outerIndex += 1) {
    let runStart = -1;
    for (let innerIndex = 0; innerIndex <= inner; innerIndex += 1) {
      const index = innerIndex < inner
        ? orientation === "vertical"
          ? innerIndex * width + outerIndex
          : outerIndex * width + innerIndex
        : -1;
      if (index >= 0 && data[index] === 1) {
        if (runStart < 0) {
          runStart = innerIndex;
        }
        continue;
      }
      if (runStart >= 0 && innerIndex - runStart < minLength) {
        for (let clearIndex = runStart; clearIndex < innerIndex; clearIndex += 1) {
          const clearOffset = orientation === "vertical"
            ? clearIndex * width + outerIndex
            : outerIndex * width + clearIndex;
          data[clearOffset] = 0;
        }
      }
      runStart = -1;
    }
  }
}

function normalizeDustDetection(settings: DustDetectionSettings): Required<DustDetectionSettings> {
  const minimumAffectedChannels = settings.minimumAffectedChannels ?? 2;
  if (minimumAffectedChannels !== 1 && minimumAffectedChannels !== 2 && minimumAffectedChannels !== 3) {
    throw new Error("minimumAffectedChannels must be 1, 2, or 3.");
  }
  return {
    radius: positiveInteger(settings.radius ?? 1, "radius", 1, 8),
    threshold: positiveFinite(settings.threshold ?? 6, "threshold", false),
    minDifference: positiveFinite(settings.minDifference ?? 0.01, "minDifference", true),
    minimumAffectedChannels,
    polarity: validatePolarity(settings.polarity ?? "both"),
  };
}

function normalizeScratchDetection(settings: ScratchDetectionSettings): Required<ScratchDetectionSettings> {
  const orientation = settings.orientation ?? "both";
  if (orientation !== "vertical" && orientation !== "horizontal" && orientation !== "both") {
    throw new Error("orientation must be vertical, horizontal, or both.");
  }
  return {
    orientation,
    halfWidth: positiveInteger(settings.halfWidth ?? 2, "halfWidth", 1, 64),
    minLength: positiveInteger(settings.minLength ?? 8, "minLength", 2, Number.MAX_SAFE_INTEGER),
    threshold: positiveFinite(settings.threshold ?? 3, "threshold", false),
    minDifference: positiveFinite(settings.minDifference ?? 0.02, "minDifference", true),
    polarity: validatePolarity(settings.polarity ?? "both"),
  };
}

function normalizeDenoise(settings: EdgePreservingDenoiseSettings): Required<EdgePreservingDenoiseSettings> {
  const radius = nonNegativeInteger(settings.radius ?? 2, "radius", 16);
  return {
    radius,
    spatialSigma: positiveFinite(settings.spatialSigma ?? Math.max(radius / 1.5, 0.5), "spatialSigma", false),
    rangeSigma: positiveFinite(settings.rangeSigma ?? 0.04, "rangeSigma", false),
    iterations: nonNegativeInteger(settings.iterations ?? 1, "iterations", 4),
  };
}

function normalizeUnsharp(settings: UnsharpSettings): Required<UnsharpSettings> {
  const radius = nonNegativeInteger(settings.radius ?? 1, "radius", 16);
  return {
    radius,
    sigma: positiveFinite(settings.sigma ?? Math.max(radius / 1.5, 0.5), "sigma", false),
    amount: positiveFinite(settings.amount ?? 0.75, "amount", true),
    // Matches the worker's explicit sharpen threshold and the WebGL shader
    // constant so direct core callers and the production path agree.
    threshold: positiveFinite(settings.threshold ?? 0.004, "threshold", true),
  };
}

function gaussianWeights(radius: number, sigma: number): number[][] {
  const weights: number[][] = [];
  const denominator = 2 * sigma * sigma;
  for (let dy = -radius; dy <= radius; dy += 1) {
    const row: number[] = [];
    for (let dx = -radius; dx <= radius; dx += 1) {
      row.push(Math.exp(-(dx * dx + dy * dy) / denominator));
    }
    weights.push(row);
  }
  return weights;
}

function weightedMedian(values: readonly number[], distances: readonly number[]): number {
  const entries = values.map((value, index) => ({ value, weight: 1 / Math.max(distances[index], EPSILON) }));
  entries.sort((left, right) => left.value - right.value);
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let accumulated = 0;
  for (const entry of entries) {
    accumulated += entry.weight;
    if (accumulated >= total / 2) {
      return entry.value;
    }
  }
  return entries[entries.length - 1].value;
}

function robustScale(values: readonly number[], center: number): number {
  const deviations = values.map((value) => Math.abs(value - center));
  return Math.max(median(deviations) * 1.4826, EPSILON);
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("Cannot calculate a median of an empty collection.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function matchesPolarity(difference: number, requiredDifference: number, polarity: DefectPolarity): boolean {
  if (polarity === "dark") {
    return difference <= -requiredDifference;
  }
  if (polarity === "bright") {
    return difference >= requiredDifference;
  }
  return Math.abs(difference) >= requiredDifference;
}

function luminanceAt(source: Raster, x: number, y: number): number {
  const offset = (y * source.width + x) * 3;
  return luminance(source.data[offset], source.data[offset + 1], source.data[offset + 2]);
}

function luminance(red: number, green: number, blue: number): number {
  return red * LUMA[0] + green * LUMA[1] + blue * LUMA[2];
}

function averageComponent(values: readonly (readonly [number, number, number])[], component: 0 | 1 | 2): number {
  return values.reduce((sum, value) => sum + value[component], 0) / values.length;
}

function assertFiniteRaster(source: Raster): void {
  for (const value of source.data) {
    if (!Number.isFinite(value)) {
      throw new Error("Restoration input must contain only finite linear-light samples.");
    }
  }
}

function assertMask(mask: RepairMask, source: Raster, label: string): void {
  if (mask.width !== source.width || mask.height !== source.height || mask.data.length !== source.width * source.height) {
    throw new Error("The " + label + " mask dimensions must match the source image.");
  }
}

function assertScratchMask(mask: ScratchMask, source: Raster): void {
  if (mask.vertical.length !== source.width * source.height || mask.horizontal.length !== source.width * source.height) {
    throw new Error("The scratch orientation masks must match the source image.");
  }
}

function positiveFinite(value: number, name: string, allowZero: boolean): number {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(name + (allowZero ? " must be non-negative and finite." : " must be positive and finite."));
  }
  return value;
}

function positiveInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(name + " must be an integer between " + minimum + " and " + maximum + ".");
  }
  return value;
}

function nonNegativeInteger(value: number, name: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new Error(name + " must be an integer between 0 and " + maximum + ".");
  }
  return value;
}

function validatePolarity(value: DefectPolarity): DefectPolarity {
  if (value !== "dark" && value !== "bright" && value !== "both") {
    throw new Error("polarity must be dark, bright, or both.");
  }
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new RepairAbortedError();
  }
}

function report(control: RepairControl, stage: RepairStage, completed: number, total: number): void {
  control.onProgress?.({
    stage,
    completed,
    total,
    fraction: total === 0 ? 1 : completed / total,
  });
  throwIfAborted(control.signal);
}
