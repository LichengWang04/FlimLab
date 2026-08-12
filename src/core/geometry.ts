import { Raster } from "./raster.ts";
import type { GeometrySettings, NormalizedRoi, PerspectivePoint, PerspectiveQuad } from "./types.ts";

export function applyGeometry(
  transmission: Raster,
  settings: GeometrySettings = {},
): Raster {
  transmission.assertDomain("transmission-linear-rgb");
  const rotated = rotateRightAngles(transmission, settings.rotation ?? 0);
  const perspectiveCorrected = settings.perspective === undefined || isIdentityPerspective(settings.perspective)
    ? rotated
    : rectifyPerspective(rotated, settings.perspective);
  const straighten = settings.straighten ?? 0;
  const aligned = Math.abs(straighten) < 1e-9
    ? perspectiveCorrected
    : rotateAndConstrain(perspectiveCorrected, straighten);
  return settings.crop === undefined ? aligned : crop(aligned, settings.crop);
}

function isIdentityPerspective(quad: PerspectiveQuad): boolean {
  const epsilon = 1e-12;
  return Math.abs(quad.topLeft.x) < epsilon
    && Math.abs(quad.topLeft.y) < epsilon
    && Math.abs(quad.topRight.x - 1) < epsilon
    && Math.abs(quad.topRight.y) < epsilon
    && Math.abs(quad.bottomRight.x - 1) < epsilon
    && Math.abs(quad.bottomRight.y - 1) < epsilon
    && Math.abs(quad.bottomLeft.x) < epsilon
    && Math.abs(quad.bottomLeft.y - 1) < epsilon;
}

export function rotateRightAngles(
  source: Raster,
  rotation: 0 | 90 | 180 | 270,
): Raster {
  if (rotation === 0) {
    return source;
  }

  const swapsAxes = rotation === 90 || rotation === 270;
  const target = new Raster(
    swapsAxes ? source.height : source.width,
    swapsAxes ? source.width : source.height,
    source.domain,
  );

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const from = (y * source.width + x) * 3;
      let targetX: number;
      let targetY: number;
      if (rotation === 90) {
        targetX = source.height - 1 - y;
        targetY = x;
      } else if (rotation === 180) {
        targetX = source.width - 1 - x;
        targetY = source.height - 1 - y;
      } else {
        targetX = y;
        targetY = source.width - 1 - x;
      }
      const to = (targetY * target.width + targetX) * 3;
      target.data[to] = source.data[from];
      target.data[to + 1] = source.data[from + 1];
      target.data[to + 2] = source.data[from + 2];
    }
  }
  return target;
}

/**
 * Applies a fine clockwise rotation while scaling just enough to keep every
 * output pixel inside the source image. This mirrors a constrained crop in
 * photo editors: alignment never introduces empty or repeated corner pixels.
 */
export function rotateAndConstrain(source: Raster, angleDegrees: number): Raster {
  if (!Number.isFinite(angleDegrees) || Math.abs(angleDegrees) > 15) {
    throw new Error("Straighten angle must be a finite value in [-15, 15].");
  }
  if (Math.abs(angleDegrees) < 1e-9) return source;

  const radians = angleDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const absoluteCosine = Math.abs(cosine);
  const absoluteSine = Math.abs(sine);
  const scale = Math.max(
    absoluteCosine + absoluteSine * source.height / source.width,
    absoluteCosine + absoluteSine * source.width / source.height,
  );
  const centerX = (source.width - 1) * 0.5;
  const centerY = (source.height - 1) * 0.5;
  const output = new Raster(source.width, source.height, source.domain);

  for (let y = 0; y < output.height; y += 1) {
    for (let x = 0; x < output.width; x += 1) {
      const outputX = (x - centerX) / scale;
      const outputY = (y - centerY) / scale;
      const sourceX = cosine * outputX + sine * outputY + centerX;
      const sourceY = -sine * outputX + cosine * outputY + centerY;
      writeBilinearSample(output, x, y, source, sourceX, sourceY);
    }
  }
  return output;
}

export function crop(source: Raster, roi: NormalizedRoi): Raster {
  validateRoi(roi);
  const left = Math.floor(roi.x * source.width);
  const top = Math.floor(roi.y * source.height);
  const right = Math.ceil((roi.x + roi.width) * source.width);
  const bottom = Math.ceil((roi.y + roi.height) * source.height);
  const width = right - left;
  const height = bottom - top;

  if (width <= 0 || height <= 0) {
    throw new Error("Crop resolves to an empty raster.");
  }

  const target = new Raster(width, height, source.domain);
  for (let y = 0; y < height; y += 1) {
    const from = ((top + y) * source.width + left) * 3;
    const to = y * width * 3;
    target.data.set(source.data.subarray(from, from + width * 3), to);
  }
  return target;
}

export function validateRoi(roi: NormalizedRoi): void {
  const values = [roi.x, roi.y, roi.width, roi.height];
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("ROI values must be finite.");
  }
  if (roi.x < 0 || roi.y < 0 || roi.width <= 0 || roi.height <= 0 || roi.x + roi.width > 1 || roi.y + roi.height > 1) {
    throw new Error("ROI must be contained in the normalized [0, 1] image area.");
  }
}

/**
 * Rectifies a user-selected film quadrilateral into a rectangle. The output
 * size follows the average opposing-edge lengths, preserving useful detail
 * without inventing pixels. The mapping is intentionally inverse/bilinear so
 * every output sample has a stable source coordinate.
 */
export function rectifyPerspective(source: Raster, quad: PerspectiveQuad): Raster {
  source.assertDomain("transmission-linear-rgb");
  validatePerspectiveQuad(quad);
  const top = distance(quad.topLeft, quad.topRight) * source.width;
  const bottom = distance(quad.bottomLeft, quad.bottomRight) * source.width;
  const left = distance(quad.topLeft, quad.bottomLeft) * source.height;
  const right = distance(quad.topRight, quad.bottomRight) * source.height;
  const width = Math.max(1, Math.round((top + bottom) * 0.5));
  const height = Math.max(1, Math.round((left + right) * 0.5));
  const output = new Raster(width, height, source.domain);
  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      const point = bilinearPoint(quad, u, v);
      writeBilinearSample(output, x, y, source, point.x * source.width - 0.5, point.y * source.height - 0.5);
    }
  }
  return output;
}

export function validatePerspectiveQuad(quad: PerspectiveQuad): void {
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) {
    throw new Error("Perspective points must be finite normalized image coordinates.");
  }
  const area = Math.abs(
    quad.topLeft.x * quad.topRight.y - quad.topRight.x * quad.topLeft.y
    + quad.topRight.x * quad.bottomRight.y - quad.bottomRight.x * quad.topRight.y
    + quad.bottomRight.x * quad.bottomLeft.y - quad.bottomLeft.x * quad.bottomRight.y
    + quad.bottomLeft.x * quad.topLeft.y - quad.topLeft.x * quad.bottomLeft.y,
  ) * 0.5;
  if (area < 1e-5) {
    throw new Error("Perspective quadrilateral must enclose a non-zero area.");
  }
}

function bilinearPoint(quad: PerspectiveQuad, u: number, v: number): PerspectivePoint {
  const topX = quad.topLeft.x + (quad.topRight.x - quad.topLeft.x) * u;
  const topY = quad.topLeft.y + (quad.topRight.y - quad.topLeft.y) * u;
  const bottomX = quad.bottomLeft.x + (quad.bottomRight.x - quad.bottomLeft.x) * u;
  const bottomY = quad.bottomLeft.y + (quad.bottomRight.y - quad.bottomLeft.y) * u;
  return { x: topX + (bottomX - topX) * v, y: topY + (bottomY - topY) * v };
}

function distance(left: PerspectivePoint, right: PerspectivePoint): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function writeBilinearSample(target: Raster, targetX: number, targetY: number, source: Raster, sourceX: number, sourceY: number): void {
  const x = Math.max(0, Math.min(source.width - 1, sourceX));
  const y = Math.max(0, Math.min(source.height - 1, sourceY));
  const left = Math.floor(x);
  const top = Math.floor(y);
  const right = Math.min(source.width - 1, left + 1);
  const bottom = Math.min(source.height - 1, top + 1);
  const fractionX = x - left;
  const fractionY = y - top;
  const topLeft = (top * source.width + left) * 3;
  const topRight = (top * source.width + right) * 3;
  const bottomLeft = (bottom * source.width + left) * 3;
  const bottomRight = (bottom * source.width + right) * 3;
  const offset = (targetY * target.width + targetX) * 3;
  for (let channel = 0; channel < 3; channel += 1) {
    const upper = source.data[topLeft + channel] + (source.data[topRight + channel] - source.data[topLeft + channel]) * fractionX;
    const lower = source.data[bottomLeft + channel] + (source.data[bottomRight + channel] - source.data[bottomLeft + channel]) * fractionX;
    target.data[offset + channel] = upper + (lower - upper) * fractionY;
  }
}
