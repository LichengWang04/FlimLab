import { Raster } from "./raster.ts";
import type { QuarterTurn, Rect } from "./types.ts";

/** Validates a normalized rectangle; throws on degenerate input. */
export function validateRect(rect: Rect, name = "Rectangle"): void {
  const values = [rect.x, rect.y, rect.width, rect.height];
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${name} values must be finite.`);
  }
  if (rect.width <= 0 || rect.height <= 0) {
    throw new Error(`${name} must have positive width and height.`);
  }
}

/** Rounds a normalized rectangle to integer pixel bounds, clamped to size. */
export function rectToPixels(rect: Rect, width: number, height: number): Rect {
  validateRect(rect);
  const left = Math.min(width - 1, Math.max(0, Math.round(rect.x * width)));
  const top = Math.min(height - 1, Math.max(0, Math.round(rect.y * height)));
  const right = Math.min(width, Math.max(left + 1, Math.round((rect.x + rect.width) * width)));
  const bottom = Math.min(height, Math.max(top + 1, Math.round((rect.y + rect.height) * height)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Rotates by a quarter-turn multiple. The domain is unchanged. */
export function rotateRaster(source: Raster, quarter: QuarterTurn): Raster {
  source.assertDomain(["transmission-linear", "scene-linear-rgb", "display-linear"]);
  if (quarter === 0) return source;
  const width = quarter === 180 ? source.width : source.height;
  const height = quarter === 180 ? source.height : source.width;
  const target = new Raster(width, height, source.domain);
  const sourceData = source.data;
  const targetData = target.data;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sourceX: number;
      let sourceY: number;
      if (quarter === 90) {
        sourceX = y;
        sourceY = source.height - 1 - x;
      } else if (quarter === 180) {
        sourceX = source.width - 1 - x;
        sourceY = source.height - 1 - y;
      } else {
        sourceX = source.width - 1 - y;
        sourceY = x;
      }
      const sourceOffset = Raster.offsetOf(sourceX, sourceY, source.width);
      const targetOffset = Raster.offsetOf(x, y, width);
      targetData[targetOffset] = sourceData[sourceOffset]!;
      targetData[targetOffset + 1] = sourceData[sourceOffset + 1]!;
      targetData[targetOffset + 2] = sourceData[sourceOffset + 2]!;
    }
  }
  return target;
}

/** Crops a normalized rectangle out of the raster. The domain is unchanged. */
export function cropRaster(source: Raster, rect: Rect): Raster {
  source.assertDomain(["transmission-linear", "scene-linear-rgb", "display-linear"]);
  const pixelRect = rectToPixels(rect, source.width, source.height);
  const target = new Raster(pixelRect.width, pixelRect.height, source.domain);
  const sourceData = source.data;
  const targetData = target.data;
  for (let y = 0; y < pixelRect.height; y += 1) {
    const sourceRow = Raster.offsetOf(pixelRect.x, pixelRect.y + y, source.width);
    const targetRow = Raster.offsetOf(0, y, pixelRect.width);
    targetData.set(sourceData.subarray(sourceRow, sourceRow + pixelRect.width * 3), targetRow);
  }
  return target;
}

/**
 * Area-average downscale so previews stay bounded. Every target pixel is the
 * mean of the source region it covers; this keeps borders and film grain
 * representable without sharpening or ringing.
 */
export function downscaleRaster(source: Raster, maxSide: number): Raster {
  source.assertDomain(["transmission-linear", "scene-linear-rgb", "display-linear"]);
  if (!Number.isFinite(maxSide) || maxSide < 1) {
    throw new Error("Downscale max side must be a positive finite value.");
  }
  const longest = Math.max(source.width, source.height);
  if (longest <= maxSide) return source;
  const scale = maxSide / longest;
  const targetWidth = Math.max(1, Math.round(source.width * scale));
  const targetHeight = Math.max(1, Math.round(source.height * scale));
  const target = new Raster(targetWidth, targetHeight, source.domain);
  const sourceData = source.data;
  const targetData = target.data;

  for (let y = 0; y < targetHeight; y += 1) {
    const top = Math.floor(y * source.height / targetHeight);
    const bottom = Math.max(top + 1, Math.ceil((y + 1) * source.height / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const left = Math.floor(x * source.width / targetWidth);
      const right = Math.max(left + 1, Math.ceil((x + 1) * source.width / targetWidth));
      const count = (right - left) * (bottom - top);
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let sourceY = top; sourceY < bottom; sourceY += 1) {
        for (let sourceX = left; sourceX < right; sourceX += 1) {
          const offset = Raster.offsetOf(sourceX, sourceY, source.width);
          red += sourceData[offset]!;
          green += sourceData[offset + 1]!;
          blue += sourceData[offset + 2]!;
        }
      }
      const offset = Raster.offsetOf(x, y, targetWidth);
      targetData[offset] = red / count;
      targetData[offset + 1] = green / count;
      targetData[offset + 2] = blue / count;
    }
  }
  return target;
}
