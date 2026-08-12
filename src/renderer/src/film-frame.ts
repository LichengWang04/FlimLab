import type { NormalizedRoi } from "../../core/types.ts";

export interface FilmFrameCropEstimate {
  readonly crop: NormalizedRoi;
  readonly confidence: number;
}

/**
 * Detects the long, axis-aligned boundaries of a copied film frame and crops
 * directly to the inner exposed-image edges.
 */
export function estimateFilmFrameCropFromRgba(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): FilmFrameCropEstimate {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || rgba.length !== width * height * 4) {
    throw new Error("Film-frame preview dimensions are invalid.");
  }
  const field = downsampleLuminance(rgba, width, height, 720);
  const vertical = new Float64Array(field.width);
  const horizontal = new Float64Array(field.height);
  for (let y = 1; y < field.height - 1; y += 1) {
    for (let x = 1; x < field.width - 1; x += 1) {
      const topLeft = field.data[(y - 1) * field.width + x - 1];
      const top = field.data[(y - 1) * field.width + x];
      const topRight = field.data[(y - 1) * field.width + x + 1];
      const left = field.data[y * field.width + x - 1];
      const right = field.data[y * field.width + x + 1];
      const bottomLeft = field.data[(y + 1) * field.width + x - 1];
      const bottom = field.data[(y + 1) * field.width + x];
      const bottomRight = field.data[(y + 1) * field.width + x + 1];
      const gradientX = Math.abs(-topLeft + topRight - 2 * left + 2 * right - bottomLeft + bottomRight);
      const gradientY = Math.abs(-topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight);
      if (gradientX > 0.035) vertical[x] += Math.min(0.8, gradientX) + 0.04;
      if (gradientY > 0.035) horizontal[y] += Math.min(0.8, gradientY) + 0.04;
    }
  }

  const verticalSmooth = smoothProjection(vertical, 2);
  const horizontalSmooth = smoothProjection(horizontal, 2);
  const left = detectBoundary(verticalSmooth, "start");
  const right = detectBoundary(verticalSmooth, "end");
  const top = detectBoundary(horizontalSmooth, "start");
  const bottom = detectBoundary(horizontalSmooth, "end");
  const cropLeft = clamp(left.inner, 0, field.width - 1);
  const cropRight = clamp(right.inner, 1, field.width);
  const cropTop = clamp(top.inner, 0, field.height - 1);
  const cropBottom = clamp(bottom.inner, 1, field.height);

  if (cropRight - cropLeft < field.width * 0.35 || cropBottom - cropTop < field.height * 0.35) {
    return {
      crop: { x: 0, y: 0, width: 1, height: 1 },
      confidence: 0,
    };
  }

  const crop = normalizedRoi(cropLeft, cropTop, cropRight, cropBottom, field.width, field.height);
  const confidence = clamp((left.confidence + right.confidence + top.confidence + bottom.confidence) * 0.25, 0, 1);
  return { crop, confidence };
}

interface Boundary {
  readonly inner: number;
  readonly confidence: number;
}

function detectBoundary(scores: Float64Array, side: "start" | "end"): Boundary {
  const length = scores.length;
  const regionStart = side === "start" ? Math.max(1, Math.floor(length * 0.01)) : Math.floor(length * 0.58);
  const regionEnd = side === "start" ? Math.ceil(length * 0.42) : Math.min(length - 2, Math.ceil(length * 0.99));
  let maximum = 0;
  let sum = 0;
  let squared = 0;
  let count = 0;
  for (let index = regionStart; index <= regionEnd; index += 1) {
    const score = scores[index];
    maximum = Math.max(maximum, score);
    sum += score;
    squared += score * score;
    count += 1;
  }
  const mean = sum / Math.max(1, count);
  const deviation = Math.sqrt(Math.max(0, squared / Math.max(1, count) - mean * mean));
  const threshold = Math.max(maximum * 0.2, mean + deviation * 0.45);
  const peaks: Array<{ readonly position: number; readonly score: number }> = [];
  for (let index = regionStart + 1; index < regionEnd; index += 1) {
    if (scores[index] >= threshold && scores[index] >= scores[index - 1] && scores[index] >= scores[index + 1]) {
      peaks.push({ position: index, score: scores[index] });
    }
  }
  if (peaks.length === 0) {
    let position = regionStart;
    for (let index = regionStart + 1; index <= regionEnd; index += 1) {
      if (scores[index] > scores[position]) position = index;
    }
    peaks.push({ position, score: scores[position] });
  }

  peaks.sort((left, right) => left.position - right.position);
  if (side === "end") peaks.reverse();
  const outer = peaks[0];
  const minimumGap = Math.max(2, Math.round(length * 0.008));
  const maximumGap = Math.max(minimumGap, Math.round(length * 0.14));
  const inward = peaks.filter((peak) => {
    const distance = side === "start" ? peak.position - outer.position : outer.position - peak.position;
    return distance >= minimumGap && distance <= maximumGap;
  });
  const inner = inward.length === 0
    ? outer
    : inward.reduce((best, peak) => peak.score > best.score ? peak : best);
  const hasOuterEdge = inner !== outer;
  const prominence = maximum <= 1e-9 ? 0 : (maximum - mean) / maximum;
  const pairBonus = hasOuterEdge ? 0.14 : 0;
  return {
    inner: inner.position,
    confidence: clamp(prominence * 0.86 + pairBonus, 0, 1),
  };
}

function normalizedRoi(left: number, top: number, right: number, bottom: number, width: number, height: number): NormalizedRoi {
  const x = clamp(left / width, 0, 0.999);
  const y = clamp(top / height, 0, 0.999);
  return {
    x,
    y,
    width: Math.max(0.001, Math.min(1 - x, (right - left) / width)),
    height: Math.max(0.001, Math.min(1 - y, (bottom - top) / height)),
  };
}

function downsampleLuminance(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  maximumEdge: number,
): { readonly width: number; readonly height: number; readonly data: Float32Array } {
  const scale = Math.min(1, maximumEdge / Math.max(width, height));
  const targetWidth = Math.max(16, Math.round(width * scale));
  const targetHeight = Math.max(16, Math.round(height * scale));
  const data = new Float32Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / targetWidth));
      const offset = (sourceY * width + sourceX) * 4;
      data[y * targetWidth + x] = (rgba[offset] * 0.2126 + rgba[offset + 1] * 0.7152 + rgba[offset + 2] * 0.0722) / 255;
    }
  }
  return { width: targetWidth, height: targetHeight, data };
}

function smoothProjection(source: Float64Array, radius: number): Float64Array {
  const target = new Float64Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    let sum = 0;
    let weight = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const sample = index + offset;
      if (sample < 0 || sample >= source.length) continue;
      const sampleWeight = radius + 1 - Math.abs(offset);
      sum += source[sample] * sampleWeight;
      weight += sampleWeight;
    }
    target[index] = sum / Math.max(1, weight);
  }
  return target;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
