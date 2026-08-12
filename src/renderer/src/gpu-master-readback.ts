/**
 * The display pass writes an OpenGL-oriented texture, then the encode pass
 * samples it through the shared top-origin full-screen vertex mapping. That
 * second pass performs the required vertical conversion already, so PBO rows
 * are in top-to-bottom export order and must not be flipped a second time.
 */
export function unpackEncodedMasterPixels(
  rgba: Uint16Array,
  width: number,
  height: number,
): Uint16Array {
  if (rgba.length !== width * height * 4) {
    throw new Error("GPU master RGBA buffer dimensions are invalid.");
  }
  const rgb = new Uint16Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const sourceOffset = pixel * 4;
    const targetOffset = pixel * 3;
    rgb[targetOffset] = rgba[sourceOffset];
    rgb[targetOffset + 1] = rgba[sourceOffset + 1];
    rgb[targetOffset + 2] = rgba[sourceOffset + 2];
  }
  return rgb;
}
