import { Raster } from "./raster.ts";
import type { ToneSettings } from "./types.ts";

const LUMA = [0.2126, 0.7152, 0.0722] as const;
const EPSILON = 1e-8;
const DISPLAY_CEILING = 1 - 1 / 65_536;

export const defaultToneSettings: ToneSettings = {
  exposureStops: 0,
  blackPoint: 0,
  whitePoint: 1,
  contrast: 1,
  highlightCompression: 0,
  saturation: 1,
};

export function toneMap(
  scene: Raster,
  overrides: Partial<ToneSettings> = {},
): Raster {
  scene.assertDomain("scene-linear-rgb");
  const settings: ToneSettings = { ...defaultToneSettings, ...overrides };
  validateToneSettings(settings);

  const exposure = Math.pow(2, settings.exposureStops);
  const range = settings.whitePoint - settings.blackPoint;
  const target = new Raster(scene.width, scene.height, "display-linear-rgb");

  for (let offset = 0; offset < scene.data.length; offset += 3) {
    const normalizedRed = (scene.data[offset] * exposure - settings.blackPoint) / range;
    const normalizedGreen = (scene.data[offset + 1] * exposure - settings.blackPoint) / range;
    const normalizedBlue = (scene.data[offset + 2] * exposure - settings.blackPoint) / range;
    const sourceLuma = Math.max(0, luminance(normalizedRed, normalizedGreen, normalizedBlue));
    const mappedLuma = mapLuminance(sourceLuma, settings);
    const scale = sourceLuma > EPSILON ? mappedLuma / sourceLuma : 0;

    let red = normalizedRed * scale;
    let green = normalizedGreen * scale;
    let blue = normalizedBlue * scale;
    const outputLuma = luminance(red, green, blue);
    red = outputLuma + (red - outputLuma) * settings.saturation;
    green = outputLuma + (green - outputLuma) * settings.saturation;
    blue = outputLuma + (blue - outputLuma) * settings.saturation;
    const gamutScale = displayGamutScale(red, green, blue, settings.highlightCompression);

    target.data[offset] = red * gamutScale;
    target.data[offset + 1] = green * gamutScale;
    target.data[offset + 2] = blue * gamutScale;
  }
  return target;
}

/**
 * Preview-specialised tone mapping. It writes final 8-bit sRGB pixels in the
 * same pass, avoiding a full display-linear raster allocation and a second
 * multi-megapixel traversal for interactive previews.
 */
export function toneMapToSrgbRgba(
  scene: Raster,
  overrides: Partial<ToneSettings> = {},
): Uint8Array {
  scene.assertDomain("scene-linear-rgb");
  const settings: ToneSettings = { ...defaultToneSettings, ...overrides };
  validateToneSettings(settings);

  const exposure = Math.pow(2, settings.exposureStops);
  const range = settings.whitePoint - settings.blackPoint;
  const output = new Uint8Array(scene.width * scene.height * 4);
  for (let inputOffset = 0, outputOffset = 0; inputOffset < scene.data.length; inputOffset += 3, outputOffset += 4) {
    const normalizedRed = (scene.data[inputOffset] * exposure - settings.blackPoint) / range;
    const normalizedGreen = (scene.data[inputOffset + 1] * exposure - settings.blackPoint) / range;
    const normalizedBlue = (scene.data[inputOffset + 2] * exposure - settings.blackPoint) / range;
    const sourceLuma = Math.max(0, luminance(normalizedRed, normalizedGreen, normalizedBlue));
    const mappedLuma = mapLuminance(sourceLuma, settings);
    const scale = sourceLuma > EPSILON ? mappedLuma / sourceLuma : 0;
    let red = normalizedRed * scale;
    let green = normalizedGreen * scale;
    let blue = normalizedBlue * scale;
    const outputLuma = luminance(red, green, blue);
    red = outputLuma + (red - outputLuma) * settings.saturation;
    green = outputLuma + (green - outputLuma) * settings.saturation;
    blue = outputLuma + (blue - outputLuma) * settings.saturation;
    const gamutScale = displayGamutScale(red, green, blue, settings.highlightCompression);
    output[outputOffset] = linearToSrgbByte(red * gamutScale);
    output[outputOffset + 1] = linearToSrgbByte(green * gamutScale);
    output[outputOffset + 2] = linearToSrgbByte(blue * gamutScale);
    output[outputOffset + 3] = 255;
  }
  return output;
}

export function rasterToSrgbRgba(source: Raster): Uint8Array {
  const output = new Uint8Array(source.width * source.height * 4);
  for (let inputOffset = 0, outputOffset = 0; inputOffset < source.data.length; inputOffset += 3, outputOffset += 4) {
    output[outputOffset] = linearToSrgbByte(source.data[inputOffset]);
    output[outputOffset + 1] = linearToSrgbByte(source.data[inputOffset + 1]);
    output[outputOffset + 2] = linearToSrgbByte(source.data[inputOffset + 2]);
    output[outputOffset + 3] = 255;
  }
  return output;
}

function mapLuminance(input: number, settings: ToneSettings): number {
  let result = input;
  if (result > 0 && result < 1 && settings.contrast !== 1) {
    result = 1 / (1 + Math.pow((1 - result) / result, settings.contrast));
  } else if (result >= 1 && settings.contrast !== 1) {
    result = 1 + (result - 1) * settings.contrast;
  }
  if (result > 0 && settings.highlightCompression > 0) {
    const knee = 1 / (1 + settings.highlightCompression);
    if (result > knee) {
      const shoulder = 1 - knee;
      result = knee + shoulder * (1 - Math.exp(-(result - knee) / shoulder));
    }
  }
  return result;
}

function displayGamutScale(red: number, green: number, blue: number, highlightCompression: number): number {
  if (highlightCompression <= 0) return 1;
  const maximum = Math.max(red, green, blue);
  return maximum > DISPLAY_CEILING ? DISPLAY_CEILING / maximum : 1;
}

function luminance(red: number, green: number, blue: number): number {
  return red * LUMA[0] + green * LUMA[1] + blue * LUMA[2];
}

function validateToneSettings(settings: ToneSettings): void {
  const values = Object.values(settings);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("Tone settings must be finite.");
  }
  if (settings.whitePoint <= settings.blackPoint) {
    throw new Error("whitePoint must be greater than blackPoint.");
  }
  if (settings.contrast <= 0 || settings.highlightCompression < 0 || settings.saturation < 0) {
    throw new Error("contrast must be positive; highlightCompression and saturation cannot be negative.");
  }
}

function linearToSrgbByte(value: number): number {
  const linear = Math.max(0, Math.min(1, value));
  return srgbByteLut[Math.round(linear * (srgbByteLut.length - 1))];
}

const srgbByteLut = createSrgbByteLut();

function createSrgbByteLut(): Uint8Array {
  const lookup = new Uint8Array(65_536);
  for (let index = 0; index < lookup.length; index += 1) {
    const linear = index / (lookup.length - 1);
    const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
    lookup[index] = Math.round(encoded * 255);
  }
  return lookup;
}
