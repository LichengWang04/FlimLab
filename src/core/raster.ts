import type { RasterDomain } from "./types.ts";

/**
 * A width x height RGB buffer in a declared pixel domain. The domain tag is
 * enforced at every stage boundary so that, for example, sRGB values can
 * never be fed into the density logarithm.
 */
export class Raster {
  readonly width: number;
  readonly height: number;
  readonly domain: RasterDomain;
  readonly data: Float32Array;

  constructor(width: number, height: number, domain: RasterDomain, data?: Float32Array) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error("Raster dimensions must be positive integers.");
    }
    const length = width * height * 3;
    this.width = width;
    this.height = height;
    this.domain = domain;
    this.data = data === undefined
      ? new Float32Array(length)
      : data.length === length
        ? data
        : (() => {
          throw new Error("Raster data length does not match dimensions.");
        })();
  }

  assertDomain(allowed: readonly RasterDomain[]): void {
    if (!allowed.includes(this.domain)) {
      throw new Error(
        `Expected raster domain ${allowed.join(" or ")}, got ${this.domain}.`,
      );
    }
  }

  /** Offsets for the pixel at (x, y); no bounds checking. */
  static offsetOf(x: number, y: number, width: number): number {
    return (y * width + x) * 3;
  }

  clone(): Raster {
    return new Raster(this.width, this.height, this.domain, this.data.slice());
  }
}

/** Median of a Float32Array slice, using in-place quickselect (mutates). */
export function medianInPlace(values: Float32Array, length: number): number {
  if (length < 1) throw new Error("Cannot take a median of an empty set.");
  const middle = Math.floor(length / 2);
  const upper = quickSelect(values, middle, length);
  return length % 2 === 0
    ? (quickSelect(values, middle - 1, length) + upper) / 2
    : upper;
}

/** Mutating quickselect; leaves values partially ordered. */
export function quickSelect(values: Float32Array, target: number, length: number): number {
  let left = 0;
  let right = length - 1;
  while (left < right) {
    const pivot = values[(left + right) >>> 1]!;
    let low = left;
    let high = right;
    while (low <= high) {
      while (values[low]! < pivot) low += 1;
      while (values[high]! > pivot) high -= 1;
      if (low <= high) {
        const value = values[low]!;
        values[low] = values[high]!;
        values[high] = value;
        low += 1;
        high -= 1;
      }
    }
    if (target <= high) right = high;
    else if (target >= low) left = low;
    else return values[target]!;
  }
  return values[target]!;
}

/**
 * Percentile of a number array (0..1 fraction), linearly interpolated.
 * Sorts a copy; callers keep sample counts bounded.
 */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) throw new Error("Cannot take a percentile of an empty set.");
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
