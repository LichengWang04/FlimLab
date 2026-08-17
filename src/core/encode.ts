import { Raster } from "./raster.ts";

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
  for (let offset = start; offset < end; offset += 1) {
    target[offset] = Math.round(srgbOetf(source[offset]!) * 255);
  }
}

export function encode16Range(source: Float32Array, target: Uint16Array, start: number, end: number): void {
  for (let offset = start; offset < end; offset += 1) {
    target[offset] = Math.round(srgbOetf(source[offset]!) * 65535);
  }
}
