import type { FilmMode } from "../core/types.ts";

/** WebGL2 fragment shaders use fixed-size uniform arrays for film curves. */
export const maximumGpuCurvePoints = 32;

/**
 * Returns whether the GPU path can represent every film-curve point exactly.
 * Complex imported calibrations stay on the CPU instead of being resampled
 * into a visually similar but mathematically different curve.
 */
export function supportsExactGpuFilmCurves(film: FilmMode): boolean {
  if (film.kind === "generic") return true;
  const curves = film.kind === "preset" ? film.preset.curves : film.profile.curves;
  return curves.every((curve) => curve.length <= maximumGpuCurvePoints);
}
