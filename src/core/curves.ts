import type { CurvePoint, CurveSet, Rgb } from "./types.ts";

/**
 * Frames whose measured density range is below this carry no usable tonal
 * information; the curve domain is then left untouched instead of exploding
 * the resampling scale on an essentially blank frame.
 */
const MINIMUM_RESAMPLE_RANGE = 0.05;

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
 *
 * Inputs below the first point clamp to the first value. Inputs beyond the
 * last point continue with the terminal segment's log10-domain slope instead
 * of clamping: a hard clamp flattens every highlight denser than the curve
 * and rotates the hue of coloured highlights whose channels reach the
 * endpoint at different densities.
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
    return extrapolateCurveEnd(points, input);
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

/**
 * Continues a curve past its last point with the terminal segment's log10
 * slope, i.e. as an exponential in linear space. Falls back to the endpoint
 * value when either terminal ordinate is non-positive (log slope undefined).
 */
function extrapolateCurveEnd(points: readonly CurvePoint[], input: number): number {
  const last = points[points.length - 1];
  const previous = points[points.length - 2];
  if (last.y > 0 && previous.y > 0) {
    const slope = (Math.log10(last.y) - Math.log10(previous.y)) / (last.x - previous.x);
    return last.y * Math.pow(10, slope * (input - last.x));
  }
  return last.y;
}

/**
 * Per-channel factors that rescale relative density so a preset curve's
 * declared domain covers the frame's measured density range
 * (`measureDensityAnchors` range, including any manual Dmax override).
 * Sampling the original curve at `density * scale` is identical to
 * resampling the curve's x-axis onto `[0, densityRange]`, and is shared by
 * the CPU transform and the WebGL shader so both paths stay in lockstep.
 * Preset curves are a synthetic look, so adapting them per frame is
 * scanner-like auto-ranging; calibrated profiles must NOT be rescaled
 * because their absolute density domain is the device-match claim.
 */
export function computeCurveDomainScale(
  curves: CurveSet,
  densityRange?: number,
): Rgb {
  if (
    densityRange === undefined
    || !Number.isFinite(densityRange)
    || densityRange < MINIMUM_RESAMPLE_RANGE
  ) {
    return [1, 1, 1];
  }
  return [
    channelDomainScale(curves[0], densityRange),
    channelDomainScale(curves[1], densityRange),
    channelDomainScale(curves[2], densityRange),
  ];
}

function channelDomainScale(points: readonly CurvePoint[], densityRange: number): number {
  const maximum = points[points.length - 1].x;
  if (!Number.isFinite(maximum) || maximum <= 0) return 1;
  return maximum / densityRange;
}
