import { Raster, percentile } from "./raster.ts";
import type { Rgb } from "./types.ts";

const SAMPLE_CAP = 65_536;
const GAIN_MIN = 0.25;
const GAIN_MAX = 4;

/**
 * Robust gray-world white balance: per-channel MEDIANS of the scene-linear
 * positive are equalized (green stays at 1). Medians ignore both the black
 * film border and a moderate share of colourful content, so a sunset does
 * not swing the correction as hard as a mean-based gray world would. Gains
 * are clamped to [0.25, 4] (±2 stops) so near-black channels cannot amplify
 * noise without bound; a median near zero still disables the correction.
 * Returns identity when the frame is too small or essentially black.
 */
export function estimateWhiteBalance(scene: Raster): Rgb {
  scene.assertDomain(["scene-linear-rgb"]);
  const pixelCount = scene.width * scene.height;
  const stride = Math.max(1, Math.ceil(pixelCount / SAMPLE_CAP));
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  for (let pixel = 0; pixel < pixelCount; pixel += stride) {
    const offset = pixel * 3;
    const r = scene.data[offset]!;
    const g = scene.data[offset + 1]!;
    const b = scene.data[offset + 2]!;
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && r >= 0 && g >= 0 && b >= 0) {
      red.push(r);
      green.push(g);
      blue.push(b);
    }
  }
  if (red.length < 32) return [1, 1, 1];
  const medianRed = percentile(red, 0.5);
  const medianGreen = percentile(green, 0.5);
  const medianBlue = percentile(blue, 0.5);
  if (medianRed <= 1e-6 || medianGreen <= 1e-6 || medianBlue <= 1e-6) {
    return [1, 1, 1];
  }
  return [
    clamp(medianGreen / medianRed, GAIN_MIN, GAIN_MAX),
    1,
    clamp(medianGreen / medianBlue, GAIN_MIN, GAIN_MAX),
  ];
}

/** Multiplies each channel by its gain; the domain stays scene-linear. */
export function applyGains(scene: Raster, gains: Rgb): Raster {
  scene.assertDomain(["scene-linear-rgb"]);
  if (gains.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("White balance gains must be finite and non-negative.");
  }
  const target = new Raster(scene.width, scene.height, "scene-linear-rgb");
  const source = scene.data;
  const data = target.data;
  for (let offset = 0; offset < source.length; offset += 3) {
    data[offset] = source[offset]! * gains[0];
    data[offset + 1] = source[offset + 1]! * gains[1];
    data[offset + 2] = source[offset + 2]! * gains[2];
  }
  return target;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
