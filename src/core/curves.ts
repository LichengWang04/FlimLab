import type { CurvePoint } from "./types.ts";

export function sampleMonotonicCurve(
  points: readonly CurvePoint[],
  input: number,
): number {
  validateMonotonicCurve(points);
  return samplePreparedMonotonicCurve(points, input);
}

/**
 * Samples a curve that the caller has already validated. Hot pixel loops use
 * this entry point so an invariant curve is not revalidated millions of times.
 */
export function samplePreparedMonotonicCurve(
  points: readonly CurvePoint[],
  input: number,
): number {
  if (!Number.isFinite(input)) {
    throw new Error("Curve input must be finite.");
  }

  if (input <= points[0].x) {
    return points[0].y;
  }
  const last = points.length - 1;
  if (input >= points[last].x) {
    return points[last].y;
  }

  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].x <= input) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return interpolate(points[low], points[high], input);
}

export function validateMonotonicCurve(points: readonly CurvePoint[]): void {
  if (points.length < 2) {
    throw new Error("A film curve needs at least two points.");
  }
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error("Film curve points must be finite.");
    }
    if (index > 0) {
      const previous = points[index - 1];
      if (point.x <= previous.x || point.y < previous.y) {
        throw new Error("Film curve must have increasing x and non-decreasing y values.");
      }
    }
  }
}

function interpolate(left: CurvePoint, right: CurvePoint, input: number): number {
  const progress = (input - left.x) / (right.x - left.x);
  return left.y + (right.y - left.y) * progress;
}
