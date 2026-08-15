import { Raster } from "../core/raster.ts";

/**
 * Convert Sharp's native-endian float scRGB output into FilmLab's explicit
 * linear transmission domain. scRGB is linear-light sRGB with an extended
 * numeric range, so it avoids quantising ICC-converted input before density
 * inversion.
 */
export function scrgbFloatBufferToRaster(
  buffer: Uint8Array,
  width: number,
  height: number,
): Raster {
  const sampleCount = width * height * 3;
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
    || buffer.byteLength !== sampleCount * Float32Array.BYTES_PER_ELEMENT
  ) {
    throw new Error("Float scRGB buffer dimensions are invalid.");
  }

  const values = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pixels = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = values.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
    if (!Number.isFinite(value)) {
      throw new Error("Float scRGB data contains a non-finite sample.");
    }
    pixels[index] = value;
  }

  // Density is defined on positive channel signals, but silently clipping
  // each negative scRGB component destroys the hue of wide-gamut scans. Do a
  // single, explicit relative-colorimetric projection per pixel instead:
  // move the colour toward the neutral white axis until its first component
  // reaches zero. This preserves channel relationships and leaves in-gamut
  // values untouched; the final sRGB boundary remains visible in metadata.
  for (let offset = 0; offset < pixels.length; offset += 3) {
    const minimum = Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    if (minimum >= 0) continue;
    const scale = 1 / (1 - minimum);
    pixels[offset] = 1 + (pixels[offset] - 1) * scale;
    pixels[offset + 1] = 1 + (pixels[offset + 1] - 1) * scale;
    pixels[offset + 2] = 1 + (pixels[offset + 2] - 1) * scale;
  }
  return new Raster(width, height, "transmission-linear-rgb", pixels);
}
