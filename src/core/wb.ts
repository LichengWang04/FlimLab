import { Raster, percentile } from "./raster.ts";
import type { Rgb } from "./types.ts";

const SAMPLE_CAP = 65_536;
const GAIN_MIN = 0.25;
const GAIN_MAX = 4;
const TEMPERATURE_MIN = 2500;
const TEMPERATURE_MAX = 10_000;
const TEMPERATURE_NEUTRAL = 5500;

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

/**
 * Converts an editor-style colour temperature to linear RGB gains. The
 * Planckian-locus white is approximated in CIE xy, converted to linear sRGB,
 * and divided against the 5500 K reference. Consequently 5500 K is exactly
 * neutral, lower values cool the image, and higher values warm it.
 */
export function temperatureToGains(kelvin: number): Rgb {
  if (!Number.isFinite(kelvin) || kelvin < TEMPERATURE_MIN || kelvin > TEMPERATURE_MAX) {
    throw new Error(`Colour temperature must be between ${TEMPERATURE_MIN} K and ${TEMPERATURE_MAX} K.`);
  }
  if (kelvin === TEMPERATURE_NEUTRAL) return [1, 1, 1];
  const reference = planckianLinearSrgb(TEMPERATURE_NEUTRAL);
  const selected = planckianLinearSrgb(kelvin);
  const relative: Rgb = [
    reference[0] / selected[0],
    reference[1] / selected[1],
    reference[2] / selected[2],
  ];
  const green = relative[1];
  return relative.map((value) => clamp(value / green, GAIN_MIN, GAIN_MAX)) as Rgb;
}

/** Multiplies each channel by its gain; the domain stays scene-linear. */
export function applyGains(scene: Raster, gains: Rgb): Raster {
  scene.assertDomain(["scene-linear-rgb"]);
  if (gains.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("White balance gains must be finite and non-negative.");
  }
  const target = new Raster(scene.width, scene.height, "scene-linear-rgb");
  applyGainsRange(scene.data, target.data, 0, scene.width * scene.height, gains);
  return target;
}

/** Pixel-independent gain kernel; source and target may be the same buffer. */
export function applyGainsRange(
  source: Float32Array,
  target: Float32Array,
  startPixel: number,
  endPixel: number,
  gains: Rgb,
): void {
  for (let offset = startPixel * 3; offset < endPixel * 3; offset += 3) {
    const red = source[offset]!;
    const green = source[offset + 1]!;
    const blue = source[offset + 2]!;
    target[offset] = red * gains[0];
    target[offset + 1] = green * gains[1];
    target[offset + 2] = blue * gains[2];
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function planckianLinearSrgb(kelvin: number): Rgb {
  const squared = kelvin * kelvin;
  const cubed = squared * kelvin;
  const x = kelvin <= 4000
    ? -0.2661239e9 / cubed - 0.234358e6 / squared + 0.8776956e3 / kelvin + 0.17991
    : -3.0258469e9 / cubed + 2.1070379e6 / squared + 0.2226347e3 / kelvin + 0.24039;
  const y = kelvin <= 2222
    ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
    : kelvin <= 4000
      ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
      : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  const cieX = x / y;
  const cieZ = (1 - x - y) / y;
  const rgb: Rgb = [
    3.2404542 * cieX - 1.5371385 - 0.4985314 * cieZ,
    -0.969266 * cieX + 1.8760108 + 0.041556 * cieZ,
    0.0556434 * cieX - 0.2040259 + 1.0572252 * cieZ,
  ];
  if (rgb.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("Colour temperature produced an invalid linear-sRGB white point.");
  }
  return rgb;
}
