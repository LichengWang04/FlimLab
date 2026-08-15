export const colorDomains = [
  "camera-linear-rgb",
  "transmission-linear-rgb",
  "relative-density",
  "scene-linear-rgb",
  "display-linear-rgb",
] as const;

export type ColorDomain = (typeof colorDomains)[number];

export type Rgb = readonly [number, number, number];

export const rgb = (red: number, green: number, blue: number): Rgb => [red, green, blue];

export type Matrix3 = readonly [Rgb, Rgb, Rgb];

/**
 * A sensor-noise model derived from a measured photon transfer curve. It is
 * deliberately separate from colour calibration: these values describe
 * uncertainty in camera-linear samples, not a camera-to-sRGB transform.
 */
export interface PhotonTransferModel {
  readonly profileId: string;
  readonly cameraModel: string;
  readonly iso: number;
  readonly bitDepth: number;
  readonly readNoiseDn: number;
  readonly electronsPerDn: number;
  readonly prnu: number;
  /** Decoder normalization divisor (white minus black) for R, G and B. */
  readonly normalizationRangeDn: Rgb;
}

export interface NormalizedRoi {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface GeometrySettings {
  readonly rotation?: 0 | 90 | 180 | 270;
  /** Fine clockwise alignment after perspective correction, in degrees. */
  readonly straighten?: number;
  readonly crop?: NormalizedRoi;
  /** Four corners of the film image after the optional right-angle rotation. */
  readonly perspective?: PerspectiveQuad;
}

export interface PerspectivePoint {
  readonly x: number;
  readonly y: number;
}

export interface PerspectiveQuad {
  readonly topLeft: PerspectivePoint;
  readonly topRight: PerspectivePoint;
  readonly bottomRight: PerspectivePoint;
  readonly bottomLeft: PerspectivePoint;
}

export interface BaseSample {
  readonly rgb: Rgb;
  readonly sampleCount: number;
  readonly rejectedCount: number;
  readonly method: "roi" | "reference" | "automatic";
  /** Confidence in [0, 1]. Automatic estimates are intentionally capped. */
  readonly confidence: number;
}

/** Density anchors derived from the scan. Dmin tracks the unexposed film-base
 * density, while Dmax is a robust high-density scene estimate. A channelRange
 * is present only when a neutral high-density reference was measured or
 * inferred conservatively. */
export interface DensityAnchors {
  readonly dmin: number;
  readonly dmax: number;
  readonly range: number;
  /** Optional per-channel density ranges measured from a neutral Dmax ROI. */
  readonly channelRange?: Rgb;
}

export interface DensityAnchorOptions {
  /** Absolute Dmax override measured from a user-selected sample. */
  readonly dmaxOverride?: number;
  /** ROI used only while measuring a manual Dmax sample. */
  readonly dmaxRoi?: NormalizedRoi;
  /** Opt-in inference from a neutral high-density tail. It is disabled by
   * default because a scene highlight is not a trustworthy neutral reference. */
  readonly inferChannelRange?: boolean;
}

export interface CurvePoint {
  readonly x: number;
  readonly y: number;
}

export type CurveSet = readonly [
  readonly CurvePoint[],
  readonly CurvePoint[],
  readonly CurvePoint[],
];

export interface Lut3d {
  readonly size: number;
  readonly data: Float32Array;
  readonly domainMin?: Rgb;
  readonly domainMax?: Rgb;
}

export interface FilmPreset {
  readonly id: string;
  readonly version: string;
  readonly curves: CurveSet;
  readonly matrix: Matrix3;
}

export interface CalibrationProfile extends FilmPreset {
  readonly calibrationId: string;
  readonly captureFingerprint: string;
  readonly lut?: Lut3d;
}

export type FilmMode =
  | {
      readonly kind: "generic";
      readonly densityGain?: Rgb;
      readonly whiteBalance?: Rgb;
      /** Optional density-domain cross-talk correction. */
      readonly densityMatrix?: Matrix3;
      /** Density-domain chroma expansion before the H&D inversion. */
      readonly preSaturation?: number;
    }
  | {
      readonly kind: "calibrated";
      readonly profile: CalibrationProfile;
      readonly whiteBalance?: Rgb;
    };

export interface ToneSettings {
  readonly exposureStops: number;
  readonly blackPoint: number;
  readonly whitePoint: number;
  readonly contrast: number;
  readonly highlightCompression: number;
  readonly saturation: number;
}

export interface PipelineSettings {
  readonly geometry?: GeometrySettings;
  /** Normalized to the final frame after geometry and crop are applied. */
  readonly baseRoi: NormalizedRoi;
  readonly baseStrategy?:
    | { readonly kind: "reference"; readonly rgb: Rgb; readonly confidence: number }
    | { readonly kind: "automatic" };
  readonly film: FilmMode;
  /** Optional absolute Dmax used for this frame. */
  readonly dmaxOverride?: number;
  /** Temporary ROI used to measure a manual Dmax sample. */
  readonly dmaxSampleRoi?: NormalizedRoi;
  /** Frozen per-channel Dmax ranges from a neutral reference frame. */
  readonly dmaxChannelRange?: Rgb;
  /** Opt in to guessing a neutral per-channel Dmax from scene content. */
  readonly inferChannelRange?: boolean;
  readonly tone?: Partial<ToneSettings>;
  readonly restoration?: import("./repair.ts").RestorationSettings;
  /** Optional sensor-noise regularization used only before log-density. */
  readonly photonTransfer?: PhotonTransferModel;
}
