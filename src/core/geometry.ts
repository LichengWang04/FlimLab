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

/** Normalizes an angle to [-180, 180). */
export function normalizeRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) throw new Error("Rotation must be finite.");
  const normalized = ((degrees + 180) % 360 + 360) % 360 - 180;
  return Math.abs(normalized) < 1e-10 ? 0 : normalized;
}

/**
 * Returns the correction that makes an undirected image-space line
 * horizontal. Positive image angles run clockwise because canvas Y runs
 * downward; the returned correction therefore has the opposite sign.
 */
export function straightenAngle(start: { x: number; y: number }, end: { x: number; y: number }): number {
  if ([start.x, start.y, end.x, end.y].some((value) => !Number.isFinite(value))) {
    throw new Error("Straighten line coordinates must be finite.");
  }
  if (start.x === end.x && start.y === end.y) throw new Error("Straighten line must have non-zero length.");
  let lineAngle = Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;
  while (lineAngle >= 90) lineAngle -= 180;
  while (lineAngle < -90) lineAngle += 180;
  return -lineAngle;
}

/**
 * Rotates linear pixels clockwise. Exact quarter turns remain lossless; other
 * angles use bilinear inverse sampling into the largest centered rectangle
 * that contains no empty corners.
 */
export function rotateRaster(source: Raster, degrees: number): Raster {
  source.assertDomain(["transmission-linear", "scene-linear-rgb", "display-linear"]);
  const normalized = normalizeRotation(degrees);
  if (normalized === 0) return source;

  // Keep the interpolated residual within +/-45 degrees. This makes the
  // maximum-inscribed-rectangle calculation stable close to quarter turns.
  const nearestQuarter = Math.round(normalized / 90) * 90;
  const quarter = (((nearestQuarter % 360) + 360) % 360) as QuarterTurn;
  const residual = normalizeRotation(normalized - nearestQuarter);
  const oriented = rotateQuarter(source, quarter);
  if (Math.abs(residual) < 1e-10) return oriented;

  const radians = residual * Math.PI / 180;
  const dimensions = largestInscribedDimensions(oriented.width, oriented.height, Math.abs(radians));
  const target = new Raster(dimensions.width, dimensions.height, source.domain);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const sourceCenterX = oriented.width / 2 - 0.5;
  const sourceCenterY = oriented.height / 2 - 0.5;
  const targetCenterX = target.width / 2 - 0.5;
  const targetCenterY = target.height / 2 - 0.5;

  for (let y = 0; y < target.height; y += 1) {
    for (let x = 0; x < target.width; x += 1) {
      const targetX = x - targetCenterX;
      const targetY = y - targetCenterY;
      const sourceX = cosine * targetX + sine * targetY + sourceCenterX;
      const sourceY = -sine * targetX + cosine * targetY + sourceCenterY;
      sampleBilinear(oriented, target, sourceX, sourceY, x, y);
    }
  }
  return target;
}

export interface GeometryPlan {
  sourceWidth: number;
  sourceHeight: number;
  quarter: QuarterTurn;
  residualRadians: number;
  orientedWidth: number;
  orientedHeight: number;
  rotatedWidth: number;
  rotatedHeight: number;
  cropX: number;
  cropY: number;
  width: number;
  height: number;
}

/** Describes rotation plus the following normalized crop without touching pixels. */
export function createGeometryPlan(
  sourceWidth: number,
  sourceHeight: number,
  degrees: number,
  crop?: Rect,
): GeometryPlan {
  if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1) {
    throw new Error("Raster dimensions must be positive integers.");
  }
  const normalized = normalizeRotation(degrees);
  const nearestQuarter = Math.round(normalized / 90) * 90;
  const quarter = (((nearestQuarter % 360) + 360) % 360) as QuarterTurn;
  const residual = normalizeRotation(normalized - nearestQuarter);
  const orientedWidth = quarter === 90 || quarter === 270 ? sourceHeight : sourceWidth;
  const orientedHeight = quarter === 90 || quarter === 270 ? sourceWidth : sourceHeight;
  const residualRadians = Math.abs(residual) < 1e-10 ? 0 : residual * Math.PI / 180;
  const rotated = residualRadians === 0
    ? { width: orientedWidth, height: orientedHeight }
    : largestInscribedDimensions(orientedWidth, orientedHeight, Math.abs(residualRadians));
  const cropPixels = crop === undefined
    ? { x: 0, y: 0, width: rotated.width, height: rotated.height }
    : rectToPixels(crop, rotated.width, rotated.height);
  return {
    sourceWidth,
    sourceHeight,
    quarter,
    residualRadians,
    orientedWidth,
    orientedHeight,
    rotatedWidth: rotated.width,
    rotatedHeight: rotated.height,
    cropX: cropPixels.x,
    cropY: cropPixels.y,
    width: cropPixels.width,
    height: cropPixels.height,
  };
}

/** Pixel-independent geometry sampler used by the export worker pool. */
export function sampleGeometryRange(
  source: Float32Array,
  target: Float32Array,
  startPixel: number,
  endPixel: number,
  plan: GeometryPlan,
): void {
  const cosine = Math.cos(plan.residualRadians);
  const sine = Math.sin(plan.residualRadians);
  const sourceCenterX = plan.orientedWidth / 2 - 0.5;
  const sourceCenterY = plan.orientedHeight / 2 - 0.5;
  const targetCenterX = plan.rotatedWidth / 2 - 0.5;
  const targetCenterY = plan.rotatedHeight / 2 - 0.5;

  for (let pixel = startPixel; pixel < endPixel; pixel += 1) {
    const targetX = pixel % plan.width;
    const targetY = Math.floor(pixel / plan.width);
    const rotatedX = targetX + plan.cropX;
    const rotatedY = targetY + plan.cropY;
    const relativeX = rotatedX - targetCenterX;
    const relativeY = rotatedY - targetCenterY;
    const orientedX = plan.residualRadians === 0
      ? rotatedX
      : cosine * relativeX + sine * relativeY + sourceCenterX;
    const orientedY = plan.residualRadians === 0
      ? rotatedY
      : -sine * relativeX + cosine * relativeY + sourceCenterY;
    const clampedX = Math.min(plan.orientedWidth - 1, Math.max(0, orientedX));
    const clampedY = Math.min(plan.orientedHeight - 1, Math.max(0, orientedY));
    const left = Math.floor(clampedX);
    const top = Math.floor(clampedY);
    const right = Math.min(plan.orientedWidth - 1, left + 1);
    const bottom = Math.min(plan.orientedHeight - 1, top + 1);
    const mixX = clampedX - left;
    const mixY = clampedY - top;
    const targetOffset = pixel * 3;

    for (let channel = 0; channel < 3; channel += 1) {
      const topLeft = sourceOffsetForOriented(left, top, channel, plan);
      const topRight = sourceOffsetForOriented(right, top, channel, plan);
      const bottomLeft = sourceOffsetForOriented(left, bottom, channel, plan);
      const bottomRight = sourceOffsetForOriented(right, bottom, channel, plan);
      const upper = source[topLeft]! * (1 - mixX) + source[topRight]! * mixX;
      const lower = source[bottomLeft]! * (1 - mixX) + source[bottomRight]! * mixX;
      target[targetOffset + channel] = upper * (1 - mixY) + lower * mixY;
    }
  }
}

function sourceOffsetForOriented(x: number, y: number, channel: number, plan: GeometryPlan): number {
  let sourceX: number;
  let sourceY: number;
  if (plan.quarter === 0) {
    sourceX = x;
    sourceY = y;
  } else if (plan.quarter === 90) {
    sourceX = y;
    sourceY = plan.sourceHeight - 1 - x;
  } else if (plan.quarter === 180) {
    sourceX = plan.sourceWidth - 1 - x;
    sourceY = plan.sourceHeight - 1 - y;
  } else {
    sourceX = plan.sourceWidth - 1 - y;
    sourceY = x;
  }
  return (sourceY * plan.sourceWidth + sourceX) * 3 + channel;
}

function rotateQuarter(source: Raster, quarter: QuarterTurn): Raster {
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

function largestInscribedDimensions(width: number, height: number, angle: number): { width: number; height: number } {
  const sine = Math.abs(Math.sin(angle));
  const cosine = Math.abs(Math.cos(angle));
  const widthIsLonger = width >= height;
  const longSide = widthIsLonger ? width : height;
  const shortSide = widthIsLonger ? height : width;
  let resultWidth: number;
  let resultHeight: number;

  if (shortSide <= 2 * sine * cosine * longSide) {
    const halfShort = shortSide / 2;
    resultWidth = widthIsLonger ? halfShort / sine : halfShort / cosine;
    resultHeight = widthIsLonger ? halfShort / cosine : halfShort / sine;
  } else {
    const cosineDouble = cosine * cosine - sine * sine;
    resultWidth = (width * cosine - height * sine) / cosineDouble;
    resultHeight = (height * cosine - width * sine) / cosineDouble;
  }
  return {
    width: Math.max(1, Math.floor(Math.min(width * cosine + height * sine, resultWidth))),
    height: Math.max(1, Math.floor(Math.min(width * sine + height * cosine, resultHeight))),
  };
}

function sampleBilinear(source: Raster, target: Raster, x: number, y: number, targetX: number, targetY: number): void {
  const clampedX = Math.min(source.width - 1, Math.max(0, x));
  const clampedY = Math.min(source.height - 1, Math.max(0, y));
  const left = Math.floor(clampedX);
  const top = Math.floor(clampedY);
  const right = Math.min(source.width - 1, left + 1);
  const bottom = Math.min(source.height - 1, top + 1);
  const mixX = clampedX - left;
  const mixY = clampedY - top;
  const targetOffset = Raster.offsetOf(targetX, targetY, target.width);
  const topLeft = Raster.offsetOf(left, top, source.width);
  const topRight = Raster.offsetOf(right, top, source.width);
  const bottomLeft = Raster.offsetOf(left, bottom, source.width);
  const bottomRight = Raster.offsetOf(right, bottom, source.width);
  for (let channel = 0; channel < 3; channel += 1) {
    const upper = source.data[topLeft + channel]! * (1 - mixX) + source.data[topRight + channel]! * mixX;
    const lower = source.data[bottomLeft + channel]! * (1 - mixX) + source.data[bottomRight + channel]! * mixX;
    target.data[targetOffset + channel] = upper * (1 - mixY) + lower * mixY;
  }
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
