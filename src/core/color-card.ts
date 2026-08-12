import { fitColorChartMatrix } from "./calibration.ts";
import { Raster } from "./raster.ts";
import type { ColorChartPatch, MatrixFitOptions, MatrixFitResult } from "./calibration.ts";
import type { NormalizedRoi, Rgb } from "./types.ts";

/** A rectangular, axis-aligned color-card layout, in row-major order. */
export interface ColorCardLayout {
  readonly columns: number;
  readonly rows: number;
}

/** Pixel-coordinate rectangle. `right` and `bottom` are exclusive. */
export interface ColorCardBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface ColorCardPoint {
  readonly x: number;
  readonly y: number;
}

export interface ColorCardSwatchLocation {
  /** Row-major index, suitable for matching a reference patch array. */
  readonly index: number;
  readonly row: number;
  readonly column: number;
  readonly center: ColorCardPoint;
  readonly bounds: ColorCardBounds;
}

/**
 * A detected regular grid. Coordinates refer to the raster pixel coordinate
 * system; cells use half-open bounds, so the full image is [0, width) x
 * [0, height).
 */
export interface ColorCardGrid extends ColorCardLayout {
  readonly bounds: ColorCardBounds;
  readonly swatches: readonly ColorCardSwatchLocation[];
  /** Edge-response score for diagnostics; it is not a calibrated probability. */
  readonly edgeScore: number;
}

export interface ColorCardDetectionOptions {
  /** Number of columns and rows expected in the card. */
  readonly layout: ColorCardLayout;
  /** Limit detection to a normalized, axis-aligned part of the image. */
  readonly searchRoi?: NormalizedRoi;
  /** Smallest permitted cell edge in pixels. Defaults to 8. */
  readonly minimumSwatchSize?: number;
  /** Maximum count of one-dimensional edge candidates examined per axis. */
  readonly maximumEdgeCandidates?: number;
  /**
   * Search distance around each ideal grid line, in pixels. When omitted the
   * distance adapts to the candidate cell size.
   */
  readonly edgeSearchRadius?: number;
  /**
   * Required median internal-line response relative to the strongest edge on
   * an axis. Defaults to 0.04 and rejects a plain rectangular object.
   */
  readonly minimumInternalEdgeRatio?: number;
}

export interface ColorCardSamplingOptions {
  /** Fraction removed from every side of a cell. Defaults to 0.2. */
  readonly insetFraction?: number;
  /** Least usable pixels required from every swatch. Defaults to 9. */
  readonly minimumSamplePixels?: number;
  /** MAD multiplier for rejecting dust, glare, and dead pixels. Defaults to 6. */
  readonly madMultiplier?: number;
  /** Absolute floor for a zero-MAD rejection band. Defaults to 1e-6. */
  readonly outlierFloor?: number;
}

export interface ColorCardSwatchSample extends ColorCardSwatchLocation {
  /** Per-channel median after robust outlier rejection. */
  readonly rgb: Rgb;
  readonly sampleCount: number;
  readonly rejectedCount: number;
  /** Per-channel median absolute deviation before rejection. */
  readonly mad: Rgb;
}

/** Reference values must be in the same row-major order as the card layout. */
export interface ColorCardReferencePatch {
  readonly id: string;
  /** Reference linear sRGB D65 value for this swatch. */
  readonly target: Rgb;
  readonly weight?: number;
  readonly include?: boolean;
}

export interface FitColorCardRasterOptions {
  /** Skip automatic detection when a caller has an approved/manual grid. */
  readonly grid?: ColorCardGrid;
  readonly detection?: ColorCardDetectionOptions;
  readonly sampling?: ColorCardSamplingOptions;
  readonly matrix?: MatrixFitOptions;
}

export interface ColorCardRasterFitResult {
  readonly grid: ColorCardGrid;
  readonly samples: readonly ColorCardSwatchSample[];
  /** Input directly accepted by the existing calibration matrix fitting API. */
  readonly patches: readonly ColorChartPatch[];
  readonly matrixFit: MatrixFitResult;
}

const DEFAULT_MINIMUM_SWATCH_SIZE = 8;
const DEFAULT_MAXIMUM_EDGE_CANDIDATES = 128;
const DEFAULT_MINIMUM_INTERNAL_EDGE_RATIO = 0.04;
const DEFAULT_INSET_FRACTION = 0.2;
const DEFAULT_MINIMUM_SAMPLE_PIXELS = 9;
const DEFAULT_MAD_MULTIPLIER = 6;
const DEFAULT_OUTLIER_FLOOR = 1e-6;

/**
 * Find an axis-aligned, regular color-card grid from edge periodicity. The
 * detector deliberately does not silently handle rotation or perspective;
 * callers should rectify such a card before detection so sampling regions
 * remain physically meaningful.
 */
export function detectColorCardGrid(
  raster: Raster,
  options: ColorCardDetectionOptions,
): ColorCardGrid {
  validateLayout(options.layout);
  const minimumSwatchSize = options.minimumSwatchSize ?? DEFAULT_MINIMUM_SWATCH_SIZE;
  const maximumEdgeCandidates = options.maximumEdgeCandidates ?? DEFAULT_MAXIMUM_EDGE_CANDIDATES;
  const minimumInternalEdgeRatio = options.minimumInternalEdgeRatio ?? DEFAULT_MINIMUM_INTERNAL_EDGE_RATIO;
  validatePositiveInteger(minimumSwatchSize, "minimumSwatchSize");
  if (!Number.isInteger(maximumEdgeCandidates) || maximumEdgeCandidates < 2) {
    throw new Error("maximumEdgeCandidates must be an integer of at least two.");
  }
  if (!Number.isFinite(minimumInternalEdgeRatio) || minimumInternalEdgeRatio < 0 || minimumInternalEdgeRatio > 1) {
    throw new Error("minimumInternalEdgeRatio must be a finite number from zero through one.");
  }
  if (options.edgeSearchRadius !== undefined && (!Number.isInteger(options.edgeSearchRadius) || options.edgeSearchRadius < 0)) {
    throw new Error("edgeSearchRadius must be a non-negative integer.");
  }

  const search = resolveSearchBounds(raster, options.searchRoi);
  if (search.right - search.left < options.layout.columns * minimumSwatchSize
    || search.bottom - search.top < options.layout.rows * minimumSwatchSize) {
    throw new Error("Color-card search area is too small for the requested layout and minimumSwatchSize.");
  }

  const verticalEdges = verticalEdgeProfile(raster);
  const horizontalEdges = horizontalEdgeProfile(raster);
  const horizontal = detectAxis(verticalEdges, options.layout.columns, search.left, search.right, {
    minimumSwatchSize,
    maximumEdgeCandidates,
    edgeSearchRadius: options.edgeSearchRadius,
    minimumInternalEdgeRatio,
    name: "vertical",
  });
  const vertical = detectAxis(horizontalEdges, options.layout.rows, search.top, search.bottom, {
    minimumSwatchSize,
    maximumEdgeCandidates,
    edgeSearchRadius: options.edgeSearchRadius,
    minimumInternalEdgeRatio,
    name: "horizontal",
  });

  const bounds: ColorCardBounds = {
    left: horizontal.start,
    top: vertical.start,
    right: horizontal.end,
    bottom: vertical.end,
  };
  return createColorCardGrid(options.layout, bounds, Math.sqrt(horizontal.score * vertical.score));
}

/**
 * Build a grid from known pixel bounds. This is useful for persisting a
 * reviewed detection or accepting a user-adjusted grid without duplicating
 * sampling and fitting logic.
 */
export function createColorCardGrid(
  layout: ColorCardLayout,
  bounds: ColorCardBounds,
  edgeScore = 0,
): ColorCardGrid {
  validateLayout(layout);
  validateBounds(bounds);
  if (!Number.isFinite(edgeScore) || edgeScore < 0) {
    throw new Error("edgeScore must be a finite non-negative number.");
  }
  const cellWidth = (bounds.right - bounds.left) / layout.columns;
  const cellHeight = (bounds.bottom - bounds.top) / layout.rows;
  const swatches: ColorCardSwatchLocation[] = [];
  for (let row = 0; row < layout.rows; row += 1) {
    for (let column = 0; column < layout.columns; column += 1) {
      const left = bounds.left + column * cellWidth;
      const top = bounds.top + row * cellHeight;
      const swatchBounds: ColorCardBounds = {
        left,
        top,
        right: left + cellWidth,
        bottom: top + cellHeight,
      };
      swatches.push({
        index: row * layout.columns + column,
        row,
        column,
        center: {
          x: (swatchBounds.left + swatchBounds.right) / 2,
          y: (swatchBounds.top + swatchBounds.bottom) / 2,
        },
        bounds: swatchBounds,
      });
    }
  }
  return { ...layout, bounds: { ...bounds }, swatches, edgeScore };
}

/**
 * Robustly sample each cell's central area. A per-channel median and MAD
 * filter make isolated scratches, dust and clipped pixels non-influential.
 */
export function sampleColorCardSwatches(
  raster: Raster,
  grid: ColorCardGrid,
  options: ColorCardSamplingOptions = {},
): readonly ColorCardSwatchSample[] {
  validateGrid(grid);
  const insetFraction = options.insetFraction ?? DEFAULT_INSET_FRACTION;
  const minimumSamplePixels = options.minimumSamplePixels ?? DEFAULT_MINIMUM_SAMPLE_PIXELS;
  const madMultiplier = options.madMultiplier ?? DEFAULT_MAD_MULTIPLIER;
  const outlierFloor = options.outlierFloor ?? DEFAULT_OUTLIER_FLOOR;
  if (!Number.isFinite(insetFraction) || insetFraction < 0 || insetFraction >= 0.5) {
    throw new Error("insetFraction must be a finite number from zero (inclusive) to 0.5 (exclusive).");
  }
  validatePositiveInteger(minimumSamplePixels, "minimumSamplePixels");
  if (!Number.isFinite(madMultiplier) || madMultiplier <= 0) {
    throw new Error("madMultiplier must be a finite positive number.");
  }
  if (!Number.isFinite(outlierFloor) || outlierFloor < 0) {
    throw new Error("outlierFloor must be a finite non-negative number.");
  }

  return grid.swatches.map((swatch) => sampleSwatch(
    raster,
    swatch,
    insetFraction,
    minimumSamplePixels,
    madMultiplier,
    outlierFloor,
  ));
}

/**
 * Convert samples to the source/target patch form consumed by
 * `fitColorChartMatrix`. `sample.rgb` must already be g(d), i.e. after any
 * characteristic-curve inversion required by the calibration workflow.
 */
export function createColorChartPatches(
  samples: readonly ColorCardSwatchSample[],
  references: readonly ColorCardReferencePatch[],
): readonly ColorChartPatch[] {
  if (!Array.isArray(samples) || !Array.isArray(references)) {
    throw new Error("Color-card samples and references must be arrays.");
  }
  if (samples.length !== references.length) {
    throw new Error("Color-card reference count must match the sampled swatch count.");
  }
  const seenIds = new Set<string>();
  return references.map((reference, index) => {
    if (typeof reference.id !== "string" || reference.id.trim().length === 0) {
      throw new Error("Color-card reference " + (index + 1) + " requires a non-empty id.");
    }
    if (seenIds.has(reference.id)) {
      throw new Error("Color-card reference ids must be unique; duplicate: " + reference.id + ".");
    }
    seenIds.add(reference.id);
    validateRgb(reference.target, "target for " + reference.id);
    validateRgb(samples[index].rgb, "sample for " + reference.id);
    return {
      id: reference.id,
      source: samples[index].rgb,
      target: reference.target,
      weight: reference.weight,
      include: reference.include,
    };
  });
}

/**
 * Detect (or reuse), sample and fit a color card in one deterministic call.
 * The returned `matrixFit` and `patches` can be written into a calibration
 * profile by the service layer without any image-specific state.
 */
export function fitColorCardRaster(
  raster: Raster,
  references: readonly ColorCardReferencePatch[],
  options: FitColorCardRasterOptions = {},
): ColorCardRasterFitResult {
  if (options.grid !== undefined && options.detection !== undefined) {
    throw new Error("Specify either grid or detection when fitting a color-card raster, not both.");
  }
  if (options.grid === undefined && options.detection === undefined) {
    throw new Error("A detected grid or color-card detection options are required.");
  }
  const grid = options.grid ?? detectColorCardGrid(raster, options.detection as ColorCardDetectionOptions);
  const samples = sampleColorCardSwatches(raster, grid, options.sampling);
  const patches = createColorChartPatches(samples, references);
  return {
    grid,
    samples,
    patches,
    matrixFit: fitColorChartMatrix(patches, options.matrix),
  };
}

interface AxisOptions {
  readonly minimumSwatchSize: number;
  readonly maximumEdgeCandidates: number;
  readonly edgeSearchRadius: number | undefined;
  readonly minimumInternalEdgeRatio: number;
  readonly name: string;
}

interface AxisFit {
  readonly start: number;
  readonly end: number;
  readonly score: number;
}

function detectAxis(
  profile: readonly number[],
  cells: number,
  minimum: number,
  maximum: number,
  options: AxisOptions,
): AxisFit {
  if (cells < 2) {
    throw new Error("Automatic color-card detection requires at least two cells on each axis.");
  }
  const strongestEdge = maxWithin(profile, minimum, maximum);
  if (strongestEdge <= Number.EPSILON) {
    throw new Error("Unable to detect color-card " + options.name + " grid lines: the search area has no usable edges.");
  }
  const candidates = edgeCandidates(profile, minimum, maximum, options.maximumEdgeCandidates);
  let best: { start: number; end: number; score: number; internalRatio: number } | undefined;

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const start = candidates[leftIndex];
      const end = candidates[rightIndex];
      const cellSize = (end - start) / cells;
      if (cellSize < options.minimumSwatchSize) {
        continue;
      }
      const radius = options.edgeSearchRadius ?? Math.max(1, Math.min(4, Math.floor(cellSize * 0.18)));
      const support: number[] = [];
      for (let line = 0; line <= cells; line += 1) {
        support.push(maxNear(profile, start + line * cellSize, radius, minimum, maximum));
      }
      const internal = support.slice(1, -1);
      const internalMedian = median(internal);
      const internalRatio = internalMedian / strongestEdge;
      const score = mean(support) + internalMedian * 0.35;
      if (best === undefined
        || score > best.score
        || (score === best.score && start < best.start)
        || (score === best.score && start === best.start && end < best.end)) {
        best = { start, end, score, internalRatio };
      }
    }
  }

  if (best === undefined || best.internalRatio < options.minimumInternalEdgeRatio) {
    throw new Error(
      "Unable to detect a regular color-card " + options.name
      + " grid; internal edge support is too weak for the requested layout.",
    );
  }

  const cellSize = (best.end - best.start) / cells;
  const radius = options.edgeSearchRadius ?? Math.max(1, Math.min(4, Math.floor(cellSize * 0.18)));
  const lines = Array.from({ length: cells + 1 }, (_, line) => strongestNear(
    profile,
    best.start + line * cellSize,
    radius,
    minimum,
    maximum,
  ));
  const refined = linearGrid(lines);
  if (refined.step < options.minimumSwatchSize || refined.start < minimum || refined.end > maximum) {
    return { start: best.start, end: best.end, score: best.score };
  }
  return { start: refined.start, end: refined.end, score: best.score };
}

function verticalEdgeProfile(raster: Raster): number[] {
  const profile = new Array<number>(raster.width + 1).fill(0);
  for (let x = 1; x < raster.width; x += 1) {
    let total = 0;
    let count = 0;
    for (let y = 0; y < raster.height; y += 1) {
      const offset = (y * raster.width + x) * 3;
      const distance = rgbDistance(
        raster.data[offset - 3], raster.data[offset - 2], raster.data[offset - 1],
        raster.data[offset], raster.data[offset + 1], raster.data[offset + 2],
      );
      if (distance !== undefined) {
        total += distance;
        count += 1;
      }
    }
    profile[x] = count === 0 ? 0 : total / count;
  }
  return profile;
}

function horizontalEdgeProfile(raster: Raster): number[] {
  const profile = new Array<number>(raster.height + 1).fill(0);
  for (let y = 1; y < raster.height; y += 1) {
    let total = 0;
    let count = 0;
    for (let x = 0; x < raster.width; x += 1) {
      const offset = (y * raster.width + x) * 3;
      const distance = rgbDistance(
        raster.data[offset - raster.width * 3], raster.data[offset - raster.width * 3 + 1], raster.data[offset - raster.width * 3 + 2],
        raster.data[offset], raster.data[offset + 1], raster.data[offset + 2],
      );
      if (distance !== undefined) {
        total += distance;
        count += 1;
      }
    }
    profile[y] = count === 0 ? 0 : total / count;
  }
  return profile;
}

function rgbDistance(
  leftRed: number,
  leftGreen: number,
  leftBlue: number,
  rightRed: number,
  rightGreen: number,
  rightBlue: number,
): number | undefined {
  if (![leftRed, leftGreen, leftBlue, rightRed, rightGreen, rightBlue].every(Number.isFinite)) {
    return undefined;
  }
  const red = rightRed - leftRed;
  const green = rightGreen - leftGreen;
  const blue = rightBlue - leftBlue;
  return Math.hypot(red, green, blue);
}

function edgeCandidates(
  profile: readonly number[],
  minimum: number,
  maximum: number,
  limit: number,
): number[] {
  const localPeaks: number[] = [];
  for (let index = Math.max(minimum + 1, 1); index < Math.min(maximum, profile.length - 1); index += 1) {
    if (profile[index] >= profile[index - 1] && profile[index] >= profile[index + 1] && profile[index] > 0) {
      localPeaks.push(index);
    }
  }
  localPeaks.sort((left, right) => profile[right] - profile[left] || left - right);
  // Keep search bounds even when a busy image has more local peaks than the
  // bounded candidate budget. This also supports a card that touches an edge.
  const selected = [...new Set([minimum, maximum, ...localPeaks.slice(0, Math.max(0, limit - 2))])];
  selected.sort((left, right) => left - right);
  return selected;
}

function strongestNear(
  profile: readonly number[],
  center: number,
  radius: number,
  minimum: number,
  maximum: number,
): number {
  let strongest = Math.max(minimum, Math.ceil(center - radius));
  const end = Math.min(maximum, Math.floor(center + radius));
  for (let index = strongest + 1; index <= end; index += 1) {
    if (profile[index] > profile[strongest]) {
      strongest = index;
    }
  }
  return strongest;
}

function maxNear(
  profile: readonly number[],
  center: number,
  radius: number,
  minimum: number,
  maximum: number,
): number {
  return profile[strongestNear(profile, center, radius, minimum, maximum)];
}

function maxWithin(profile: readonly number[], minimum: number, maximum: number): number {
  let result = 0;
  for (let index = minimum; index <= maximum; index += 1) {
    result = Math.max(result, profile[index]);
  }
  return result;
}

function linearGrid(lines: readonly number[]): { start: number; end: number; step: number } {
  const count = lines.length;
  const indexMean = (count - 1) / 2;
  const locationMean = mean(lines);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < count; index += 1) {
    const delta = index - indexMean;
    numerator += delta * (lines[index] - locationMean);
    denominator += delta * delta;
  }
  const step = numerator / denominator;
  const start = locationMean - step * indexMean;
  return { start, end: start + step * (count - 1), step };
}

function sampleSwatch(
  raster: Raster,
  swatch: ColorCardSwatchLocation,
  insetFraction: number,
  minimumSamplePixels: number,
  madMultiplier: number,
  outlierFloor: number,
): ColorCardSwatchSample {
  const insetX = (swatch.bounds.right - swatch.bounds.left) * insetFraction;
  const insetY = (swatch.bounds.bottom - swatch.bounds.top) * insetFraction;
  const left = Math.max(0, Math.ceil(swatch.bounds.left + insetX));
  const top = Math.max(0, Math.ceil(swatch.bounds.top + insetY));
  const right = Math.min(raster.width, Math.floor(swatch.bounds.right - insetX));
  const bottom = Math.min(raster.height, Math.floor(swatch.bounds.bottom - insetY));
  const raw: Rgb[] = [];
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const sample = raster.getPixel(x, y);
      if (sample.every(Number.isFinite)) {
        raw.push(sample);
      }
    }
  }
  if (raw.length < minimumSamplePixels) {
    throw new Error(
      "Color-card swatch " + (swatch.index + 1) + " has only " + raw.length
      + " usable pixels; at least " + minimumSamplePixels + " are required.",
    );
  }
  const medians = medianRgb(raw);
  const mad = medianRgb(raw.map((sample) => [
    Math.abs(sample[0] - medians[0]),
    Math.abs(sample[1] - medians[1]),
    Math.abs(sample[2] - medians[2]),
  ]));
  const filtered = raw.filter((sample) => sample.every((value, channel) =>
    Math.abs(value - medians[channel]) <= Math.max(outlierFloor, mad[channel] * madMultiplier),
  ));
  const usable = filtered.length >= minimumSamplePixels ? filtered : raw;
  return {
    ...swatch,
    rgb: medianRgb(usable),
    sampleCount: usable.length,
    rejectedCount: raw.length - usable.length,
    mad,
  };
}

function resolveSearchBounds(raster: Raster, roi: NormalizedRoi | undefined): ColorCardBounds {
  if (roi === undefined) {
    return { left: 0, top: 0, right: raster.width, bottom: raster.height };
  }
  const values = [roi.x, roi.y, roi.width, roi.height];
  if (values.some((value) => !Number.isFinite(value))
    || roi.x < 0 || roi.y < 0 || roi.width <= 0 || roi.height <= 0
    || roi.x + roi.width > 1 || roi.y + roi.height > 1) {
    throw new Error("Color-card searchRoi must be contained in the normalized [0, 1] image area.");
  }
  return {
    left: Math.floor(roi.x * raster.width),
    top: Math.floor(roi.y * raster.height),
    right: Math.ceil((roi.x + roi.width) * raster.width),
    bottom: Math.ceil((roi.y + roi.height) * raster.height),
  };
}

function validateGrid(grid: ColorCardGrid): void {
  validateLayout(grid);
  validateBounds(grid.bounds);
  if (!Array.isArray(grid.swatches) || grid.swatches.length !== grid.columns * grid.rows) {
    throw new Error("Color-card grid swatches must contain exactly one entry per layout cell.");
  }
  for (let index = 0; index < grid.swatches.length; index += 1) {
    const swatch = grid.swatches[index];
    if (swatch.index !== index || swatch.row !== Math.floor(index / grid.columns) || swatch.column !== index % grid.columns) {
      throw new Error("Color-card grid swatches must be row-major and contiguous.");
    }
    validateBounds(swatch.bounds);
  }
}

function validateLayout(layout: ColorCardLayout): void {
  validatePositiveInteger(layout.columns, "Color-card layout columns");
  validatePositiveInteger(layout.rows, "Color-card layout rows");
}

function validateBounds(bounds: ColorCardBounds): void {
  if (![bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite)
    || bounds.left < 0 || bounds.top < 0 || bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
    throw new Error("Color-card bounds must be finite, non-negative and non-empty.");
  }
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(label + " must be a positive integer.");
  }
}

function validateRgb(value: Rgb, label: string): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((channel) => !Number.isFinite(channel))) {
    throw new Error(label + " must contain exactly three finite RGB values.");
  }
}

function medianRgb(samples: readonly Rgb[]): Rgb {
  return [
    median(samples.map((sample) => sample[0])),
    median(samples.map((sample) => sample[1])),
    median(samples.map((sample) => sample[2])),
  ];
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("Cannot calculate a median from no samples.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
