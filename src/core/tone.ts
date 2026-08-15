import { Raster } from "./raster.ts";
import type { Recipe } from "./types.ts";

const MID_GREY = 0.18;
const KNEE = 1.0;
const SAMPLE_CAP = 65_536;

/**
 * Maps scene-linear positive light through the display controls, then
 * normalizes so the frame's highlight percentile becomes display white.
 * All operations stay in linear light; gamma is applied only at encode time.
 */
export function toneMap(
  scene: Raster,
  recipe: Pick<Recipe, "exposure" | "contrast" | "highlightCompression" | "saturation">,
): { display: Raster; whitePoint: number } {
  scene.assertDomain(["scene-linear-rgb"]);
  const { exposure, contrast, highlightCompression, saturation } = recipe;
  if (
    !Number.isFinite(exposure)
    || !Number.isFinite(contrast) || contrast < 0.5 || contrast > 1.5
    || !Number.isFinite(highlightCompression) || highlightCompression < 0 || highlightCompression > 1
    || !Number.isFinite(saturation) || saturation < 0 || saturation > 2
  ) {
    throw new Error("Tone controls must be finite and within their ranges.");
  }

  const whitePoint = estimateWhitePoint(scene);
  const exposureScale = Math.pow(2, exposure);
  const kneeSlope = 1 - highlightCompression;
  const display = new Raster(scene.width, scene.height, "display-linear");
  const source = scene.data;
  const target = display.data;

  for (let offset = 0; offset < source.length; offset += 3) {
    let red = source[offset]! * exposureScale;
    let green = source[offset + 1]! * exposureScale;
    let blue = source[offset + 2]! * exposureScale;
    // Log-domain contrast around 0.18 mid grey; non-positive values stay at 0.
    red = contrastAround(red, contrast);
    green = contrastAround(green, contrast);
    blue = contrastAround(blue, contrast);
    // Soft knee above 1.0 scene-linear; slope drops as compression rises.
    if (highlightCompression > 0) {
      red = softKnee(red, kneeSlope);
      green = softKnee(green, kneeSlope);
      blue = softKnee(blue, kneeSlope);
    }
    // Saturation around Rec.709 luma, clamped to non-negative.
    const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    target[offset] = Math.max(0, luma + (red - luma) * saturation) / whitePoint;
    target[offset + 1] = Math.max(0, luma + (green - luma) * saturation) / whitePoint;
    target[offset + 2] = Math.max(0, luma + (blue - luma) * saturation) / whitePoint;
  }
  return { display, whitePoint };
}

function contrastAround(value: number, contrast: number): number {
  if (value <= 0) return 0;
  return MID_GREY * Math.pow(2, Math.log2(value / MID_GREY) * contrast);
}

function softKnee(value: number, slope: number): number {
  return value > KNEE ? KNEE + (value - KNEE) * slope : value;
}

/**
 * The scene-linear value that should become display white: the 99.5th
 * luminance percentile of the central 90% of the frame, so retained film
 * borders cannot set the exposure of the photograph.
 */
export function estimateWhitePoint(scene: Raster, highPercentile = 0.995): number {
  scene.assertDomain(["scene-linear-rgb"]);
  if (!Number.isFinite(highPercentile) || highPercentile <= 0 || highPercentile > 1) {
    throw new Error("White-point percentile must be in (0, 1].");
  }

  const left = Math.floor(scene.width * 0.05);
  const top = Math.floor(scene.height * 0.05);
  const right = Math.max(left + 1, Math.ceil(scene.width * 0.95));
  const bottom = Math.max(top + 1, Math.ceil(scene.height * 0.95));
  const pixelCount = (right - left) * (bottom - top);
  const stride = Math.max(1, Math.ceil(pixelCount / SAMPLE_CAP));
  const luminances: number[] = [];

  for (let sample = 0; sample < pixelCount; sample += stride) {
    const x = left + sample % (right - left);
    const y = top + Math.floor(sample / (right - left));
    const offset = Raster.offsetOf(x, y, scene.width);
    const luma = (
      scene.data[offset]! * 0.2126
      + scene.data[offset + 1]! * 0.7152
      + scene.data[offset + 2]! * 0.0722
    );
    if (Number.isFinite(luma) && luma > 0) luminances.push(luma);
  }
  if (luminances.length === 0) return 1;
  luminances.sort((a, b) => a - b);
  const position = Math.round((luminances.length - 1) * highPercentile);
  return Math.max(0.05, luminances[position]!);
}
