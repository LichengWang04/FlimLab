import { Raster } from "./raster.ts";

const SRGB_QUANTIZER_BUCKETS = 4096;

interface SrgbQuantizer {
  readonly scale: 255 | 65_535;
  readonly thresholds: Float32Array;
  readonly bucketOffsets: Uint32Array;
}

let quantizer8: SrgbQuantizer | undefined;
let quantizer16: SrgbQuantizer | undefined;

/**
 * IEC 61966-2-1 sRGB transfer functions. The pipeline stays linear until
 * this final step; nothing upstream ever sees these values.
 */
export function srgbOetf(linear: number): number {
  const value = Math.min(1, Math.max(0, linear));
  return value <= 0.0031308
    ? value * 12.92
    : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

export function srgbToLinear(encoded: number): number {
  const value = Math.max(0, encoded);
  return value <= 0.04045
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** Quantizes display-linear pixels to packed 8-bit sRGB RGB. */
export function encode8(display: Raster): Uint8Array {
  display.assertDomain(["display-linear"]);
  const source = display.data;
  const target = new Uint8Array(source.length);
  encode8Range(source, target, 0, source.length);
  return target;
}

/** Quantizes display-linear pixels to packed 16-bit sRGB RGB. */
export function encode16(display: Raster): Uint16Array {
  display.assertDomain(["display-linear"]);
  const source = display.data;
  const target = new Uint16Array(source.length);
  encode16Range(source, target, 0, source.length);
  return target;
}

export function encode8Range(source: Float32Array, target: Uint8Array, start: number, end: number): void {
  const quantizer = quantizer8 ??= createSrgbQuantizer(255);
  for (let offset = start; offset < end; offset += 1) {
    target[offset] = quantizeSrgbFloat(source[offset]!, quantizer);
  }
}

export function encode16Range(source: Float32Array, target: Uint16Array, start: number, end: number): void {
  const quantizer = quantizer16 ??= createSrgbQuantizer(65_535);
  for (let offset = start; offset < end; offset += 1) {
    target[offset] = quantizeSrgbFloat(source[offset]!, quantizer);
  }
}

/**
 * Returns an exact integer encoder for Float32 display-linear samples. The
 * thresholds are adjusted to the first Float32 value that changes the legacy
 * `Math.round(srgbOetf(value) * scale)` result. A small linear bucket narrows
 * the binary search without approximating the transfer curve.
 */
export function getSrgb8Quantizer(): (linear: number) => number {
  const quantizer = quantizer8 ??= createSrgbQuantizer(255);
  return (linear) => quantizeSrgbFloat(linear, quantizer);
}

export function getSrgb16Quantizer(): (linear: number) => number {
  const quantizer = quantizer16 ??= createSrgbQuantizer(65_535);
  return (linear) => quantizeSrgbFloat(linear, quantizer);
}

function createSrgbQuantizer(scale: 255 | 65_535): SrgbQuantizer {
  const thresholds = new Float32Array(scale);
  const storage = new ArrayBuffer(Float32Array.BYTES_PER_ELEMENT);
  const float = new Float32Array(storage);
  const bits = new Uint32Array(storage);
  const nextFloat = (value: number): number => {
    float[0] = value;
    bits[0] = bits[0]! + 1;
    return float[0]!;
  };
  const previousFloat = (value: number): number => {
    float[0] = value;
    bits[0] = bits[0]! - 1;
    return float[0]!;
  };
  const legacyCode = (value: number): number => Math.round(srgbOetf(value) * scale);
  for (let code = 0; code < scale; code += 1) {
    const encodedBoundary = (code + 0.5) / scale;
    let threshold = Math.fround(srgbToLinear(encodedBoundary));
    let previous = previousFloat(threshold);
    while (legacyCode(previous) > code) {
      threshold = previous;
      previous = previousFloat(threshold);
    }
    while (legacyCode(threshold) <= code) threshold = nextFloat(threshold);
    thresholds[code] = threshold;
  }

  const bucketOffsets = new Uint32Array(SRGB_QUANTIZER_BUCKETS + 1);
  let thresholdIndex = 0;
  for (let bucket = 0; bucket <= SRGB_QUANTIZER_BUCKETS; bucket += 1) {
    const lowerBound = bucket / SRGB_QUANTIZER_BUCKETS;
    while (thresholdIndex < thresholds.length && thresholds[thresholdIndex]! < lowerBound) thresholdIndex += 1;
    bucketOffsets[bucket] = thresholdIndex;
  }
  return { scale, thresholds, bucketOffsets };
}

function quantizeSrgbFloat(linear: number, quantizer: SrgbQuantizer): number {
  if (!(linear > 0)) return 0;
  if (linear >= 1) return quantizer.scale;
  const bucket = Math.min(SRGB_QUANTIZER_BUCKETS - 1, Math.floor(linear * SRGB_QUANTIZER_BUCKETS));
  let low = quantizer.bucketOffsets[bucket]!;
  let high = quantizer.bucketOffsets[bucket + 1]!;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (linear < quantizer.thresholds[middle]!) high = middle;
    else low = middle + 1;
  }
  return low;
}
