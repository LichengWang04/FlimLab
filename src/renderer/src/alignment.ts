export interface AlignmentEstimate {
  /** Clockwise correction to add to the current fine rotation. */
  readonly correctionDegrees: number;
  readonly detectedAngleDegrees: number;
  readonly confidence: number;
}

const maximumAngle = 15;
const binSize = 0.25;
const binCount = Math.round(maximumAngle * 2 / binSize) + 1;

/**
 * Finds the dominant near-horizontal/vertical edge direction in the preview.
 * Film-frame edges are favoured by weighting the outer third of the image.
 */
export function estimateAlignmentFromRgba(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): AlignmentEstimate {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3 || rgba.length !== width * height * 4) {
    throw new Error("Alignment preview dimensions are invalid.");
  }

  const stride = Math.max(1, Math.ceil(Math.max(width, height) / 640));
  const edgePoints: Array<{
    readonly x: number;
    readonly y: number;
    readonly gradientX: number;
    readonly gradientY: number;
    readonly magnitude: number;
    readonly weight: number;
  }> = [];
  let totalWeight = 0;
  for (let y = stride; y < height - stride; y += stride) {
    for (let x = stride; x < width - stride; x += stride) {
      const topLeft = luminance(rgba, width, x - stride, y - stride);
      const top = luminance(rgba, width, x, y - stride);
      const topRight = luminance(rgba, width, x + stride, y - stride);
      const left = luminance(rgba, width, x - stride, y);
      const right = luminance(rgba, width, x + stride, y);
      const bottomLeft = luminance(rgba, width, x - stride, y + stride);
      const bottom = luminance(rgba, width, x, y + stride);
      const bottomRight = luminance(rgba, width, x + stride, y + stride);
      const gradientX = -topLeft + topRight - 2 * left + 2 * right - bottomLeft + bottomRight;
      const gradientY = -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;
      const magnitude = Math.hypot(gradientX, gradientY);
      if (magnitude < 0.09) continue;

      const edgeDistance = Math.min(x / width, 1 - x / width, y / height, 1 - y / height);
      const positionWeight = edgeDistance < 0.42 ? 2.25 : 0.3;
      const weight = magnitude * positionWeight;
      edgePoints.push({ x, y, gradientX, gradientY, magnitude, weight });
      totalWeight += weight;
    }
  }

  if (totalWeight <= 1e-9) return { correctionDegrees: 0, detectedAngleDegrees: 0, confidence: 0 };
  const diagonal = Math.hypot(width, height);
  const rhoBinSize = Math.max(1.5, stride * 1.5);
  const rhoBinCount = Math.ceil(diagonal * 2 / rhoBinSize) + 3;
  const scores = new Float64Array(binCount);
  for (let angleIndex = 0; angleIndex < binCount; angleIndex += 1) {
    const angleDegrees = angleIndex * binSize - maximumAngle;
    const radians = angleDegrees * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const horizontalAccumulator = new Float64Array(rhoBinCount);
    const verticalAccumulator = new Float64Array(rhoBinCount);
    for (const point of edgePoints) {
      const horizontalRho = point.y * cosine - point.x * sine;
      const verticalRho = point.x * cosine + point.y * sine;
      const horizontalBin = Math.round((horizontalRho + diagonal) / rhoBinSize);
      const verticalBin = Math.round((verticalRho + diagonal) / rhoBinSize);
      const horizontalAlignment = Math.abs((-sine * point.gradientX + cosine * point.gradientY) / point.magnitude);
      const verticalAlignment = Math.abs((cosine * point.gradientX + sine * point.gradientY) / point.magnitude);
      if (horizontalAlignment > 0.55) {
        horizontalAccumulator[horizontalBin] += point.weight * horizontalAlignment * horizontalAlignment;
      }
      if (verticalAlignment > 0.55) {
        verticalAccumulator[verticalBin] += point.weight * verticalAlignment * verticalAlignment;
      }
    }
    const peakSeparation = Math.max(2, Math.round(stride * 3 / rhoBinSize));
    scores[angleIndex] = pairedPeakScore(horizontalAccumulator, peakSeparation)
      + pairedPeakScore(verticalAccumulator, peakSeparation);
  }

  let bestIndex = 0;
  for (let index = 1; index < scores.length; index += 1) {
    if (scores[index] > scores[bestIndex]) bestIndex = index;
  }

  let refinedIndex = bestIndex;
  if (bestIndex > 0 && bestIndex < scores.length - 1) {
    const previous = scores[bestIndex - 1];
    const current = scores[bestIndex];
    const next = scores[bestIndex + 1];
    const denominator = previous - 2 * current + next;
    if (Math.abs(denominator) > 1e-9) {
      refinedIndex += Math.max(-0.5, Math.min(0.5, 0.5 * (previous - next) / denominator));
    }
  }
  const detectedAngleDegrees = refinedIndex * binSize - maximumAngle;
  let averageScore = 0;
  for (const score of scores) averageScore += score;
  averageScore /= scores.length;
  const support = scores[bestIndex] / Math.max(totalWeight, 1e-9);
  const contrast = (scores[bestIndex] - averageScore) / Math.max(scores[bestIndex], 1e-9);
  return {
    correctionDegrees: -detectedAngleDegrees,
    detectedAngleDegrees,
    confidence: clamp01(support * 0.82 + Math.max(0, contrast) * 0.18),
  };
}

function pairedPeakScore(accumulator: Float64Array, minimumSeparation: number): number {
  let firstIndex = 0;
  for (let index = 1; index < accumulator.length; index += 1) {
    if (accumulator[index] > accumulator[firstIndex]) firstIndex = index;
  }
  let second = 0;
  for (let index = 0; index < accumulator.length; index += 1) {
    if (Math.abs(index - firstIndex) >= minimumSeparation) second = Math.max(second, accumulator[index]);
  }
  return accumulator[firstIndex] + second * 0.82;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function luminance(rgba: Uint8Array | Uint8ClampedArray, width: number, x: number, y: number): number {
  const offset = (y * width + x) * 4;
  return (rgba[offset] * 0.2126 + rgba[offset + 1] * 0.7152 + rgba[offset + 2] * 0.0722) / 255;
}
