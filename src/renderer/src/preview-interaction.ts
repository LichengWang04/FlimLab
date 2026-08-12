import {
  maximumBackgroundPreviewEdge,
  type ProcessingRecipe,
} from "../../shared/contracts.ts";

/** Keeps interactive uploads small while retaining enough detail for the
 * 1080px-wide canvas. Master TIFF export always uses the original raster. */
export const previewPerformanceProfile = {
  quickMaxEdge: 768,
  // Keep inactive frames below the IPC background ceiling and reduce the
  // decode/upload cost enough to finish before a typical frame switch.
  prewarmMaxEdge: maximumBackgroundPreviewEdge,
  settledMaxEdge: 1280,
  analysisMaxEdge: 1024,
  inputDebounceMs: 48,
  refineDelayMs: 180,
} as const;

/**
 * Crop handles are an interaction overlay. While they are being edited the
 * expensive preview pipeline should keep rendering the uncropped source.
 */
export function processingForInteractivePreview(
  processing: ProcessingRecipe,
  cropEditing: boolean,
): ProcessingRecipe {
  if (!cropEditing || processing.geometry.crop === undefined) return processing;
  const crop = processing.geometry.crop;
  const baseRoi = processing.baseRoi;
  return {
    ...processing,
    // baseRoi is defined in final, cropped-frame coordinates. When crop is
    // temporarily removed for the editor, map the same physical sample area
    // back into the uncropped geometry so film-base inversion stays stable.
    baseRoi: {
      x: crop.x + baseRoi.x * crop.width,
      y: crop.y + baseRoi.y * crop.height,
      width: baseRoi.width * crop.width,
      height: baseRoi.height * crop.height,
    },
    geometry: { ...processing.geometry, crop: undefined },
  };
}

export interface RulerPoint {
  readonly x: number;
  readonly y: number;
}

export interface StraightenReferenceResult {
  readonly axis: "horizontal" | "vertical";
  readonly lineAngleDegrees: number;
  readonly correctionDegrees: number;
  readonly straightenDegrees: number;
  readonly clamped: boolean;
}

/** Converts a ruler line drawn on the current preview into the fine rotation
 * required to make that line parallel with its nearest horizontal/vertical
 * axis. Coordinates are display pixels, so non-square images need no special
 * aspect correction. */
export function straightenFromReferenceLine(
  start: RulerPoint,
  end: RulerPoint,
  currentStraightenDegrees: number,
  maximumStraightenDegrees = 15,
): StraightenReferenceResult | undefined {
  const values = [start.x, start.y, end.x, end.y, currentStraightenDegrees, maximumStraightenDegrees];
  if (values.some((value) => !Number.isFinite(value)) || maximumStraightenDegrees <= 0) return undefined;
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  if (Math.hypot(deltaX, deltaY) < 12) return undefined;

  const rawAngle = Math.atan2(deltaY, deltaX) * 180 / Math.PI;
  const lineAngleDegrees = ((rawAngle + 90) % 180 + 180) % 180 - 90;
  const axis = Math.abs(lineAngleDegrees) <= 45 ? "horizontal" : "vertical";
  const targetAngle = axis === "horizontal" ? 0 : lineAngleDegrees < 0 ? -90 : 90;
  const requested = currentStraightenDegrees + targetAngle - lineAngleDegrees;
  const straightenDegrees = Math.max(-maximumStraightenDegrees, Math.min(maximumStraightenDegrees, requested));
  return {
    axis,
    lineAngleDegrees,
    correctionDegrees: straightenDegrees - currentStraightenDegrees,
    straightenDegrees,
    clamped: Math.abs(straightenDegrees - requested) > 1e-9,
  };
}
