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
  return new Raster(width, height, "transmission-linear-rgb", pixels);
}
