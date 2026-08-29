/**
 * Core domain types shared by every processing stage.
 *
 * The pipeline keeps pixel data in one of four explicit domains so that a
 * display-encoded buffer can never be mistaken for linear light:
 *
 *   transmission-linear   linear light transmitted through the film, after
 *                         scan/photo linearisation (camera RGB or scanner
 *                         transmission); values are positive ratios.
 *   relative-density      D = -log10(T / Tbase), per channel, >= 0.
 *   scene-linear-rgb      the restored positive in linear light.
 *   display-linear        after exposure/contrast/highlight/saturation
 *                         controls, still linear, ready for the OETF.
 */

export type RasterDomain =
  | "transmission-linear"
  | "relative-density"
  | "scene-linear-rgb"
  | "display-linear";

export type Rgb = [number, number, number];

/** Normalized rectangle; every component is a fraction of the image size. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type QuarterTurn = 0 | 90 | 180 | 270;

export interface BaseSample {
  /** Linear transmission of the unexposed film base, per channel. */
  rgb: Rgb;
  /** 0..1 confidence that `rgb` really is unexposed base. */
  confidence: number;
  method: "roi" | "automatic" | "manual";
  /** Number of pixels the sample was computed from. */
  sampleCount: number;
}

/**
 * Per-channel affine response model fitted from near-neutral pixels:
 * density_c ≈ offset_c + slope_c × neutral-density. Normalizing by this fit
 * instead of a single high-density anchor keeps neutrals neutral across the
 * whole tonal range even when the film base sample carries a residual
 * per-channel offset or the channel contrasts differ.
 */
export interface ChannelFit {
  offset: Rgb;
  slope: Rgb;
}

/** Monotone density mapping applied after the affine channel fit. */
export interface DensityCurve {
  input: number[];
  output: number[];
}

export type NeutralizationMethod = "curve" | "neutral-axis" | "pca" | "anchor" | "none";

export interface NeutralizationDiagnostics {
  method: NeutralizationMethod;
  /** Relative held-out residual reduction, 0..1. */
  improvement: number;
  sampleCount: number;
  densitySpan: number;
}

export interface DensityAnchors {
  /** Mean optical density of the sampled film base relative to scan white. */
  dmin: number;
  /** dmin + range. */
  dmax: number;
  /** Usable density range of the negative (Dmax - Dmin). */
  range: number;
  /** Optional per-channel affine fit from a neutral area / neutral tail. */
  channelFit?: ChannelFit;
  /** Optional tone-dependent correction, evaluated after `channelFit`. */
  channelCurves?: [DensityCurve, DensityCurve, DensityCurve];
  /** Read-only diagnostics for the automatic neutralisation decision. */
  neutralization?: NeutralizationDiagnostics;
}

export interface CommonRecipe {
  /** Selects the processing contract. Missing values in persisted projects
   * are migrated to classic by the IPC boundary. */
  engine: "classic" | "negadoctor-5.6";
  /** Clockwise rotation in degrees, applied before anything else. */
  rotate: number;
  /** Optional crop applied after rotation, in normalized coordinates. */
  crop?: Rect;
  /** How the film base is determined: automatic envelope estimate by
   * default, or a user-drawn unexposed border region. */
  baseMode: "roi" | "auto" | "manual";
  /** User-drawn unexposed base region; relative to the delivered frame.
   * Only used when baseMode is "roi". */
  baseRoi?: Rect;
}

export interface ClassicRecipe extends CommonRecipe {
  engine: "classic";
  baseMode: "roi" | "auto";
  /** How the density range (Dmax) is determined. */
  dmaxMode: "auto" | "manual";
  /** Absolute density used when dmaxMode is manual. */
  manualDmax: number;
  /**
   * When enabled, a per-channel density range is measured from a user-drawn
   * neutral ROI, or inferred from a convincingly neutral high-density tail.
   * This neutralizes the orange mask without a calibration profile.
   */
  autoNeutralize: boolean;
  /** Optional neutral high-density area; overrides the heuristic. */
  neutralRoi?: Rect;
  /** Manual colour temperature in Kelvin; 5500 K is the neutral point. */
  temperatureKelvin: number;
  /**
   * When enabled, robust gray-world gains (per-channel medians equalized)
   * are estimated from the scene-linear positive and multiplied with the
   * manual white balance. Defaults on.
   */
  autoWhiteBalance: boolean;
  /** Density-domain saturation boost around the channel mean, 0.5..2. */
  preSaturation: number;
  /** Exposure offset in stops. */
  exposure: number;
  /** Log-domain contrast multiplier around 0.18 mid grey, 0.5..1.5. */
  contrast: number;
  /** 0..1; slope of the soft knee above 1.0 scene-linear. */
  highlightCompression: number;
  /** Display saturation multiplier, 0..2. */
  saturation: number;
}

export type FilmStock = "color" | "black-and-white";
export type LinearPrimaries = "srgb" | "rec2020";
export type WorkingSpace = "linear-srgb" | "linear-rec2020";

export interface NegadoctorRecipe extends CommonRecipe {
  engine: "negadoctor-5.6";
  filmStock: FilmStock;
  /** Primaries assigned to untagged linear TIFF input. JPEG/PNG and supported
   * camera RAW are always decoded as sRGB regardless of this declaration. */
  inputPrimaries: LinearPrimaries;
  workingSpace: WorkingSpace;
  /** Transmission of unexposed film in the selected working space. */
  dminRgb: Rgb;
  /** Positive optical-density range of the negative. */
  dmax: number;
  scanExposureBias: number;
  /** darktable negadoctor `wb_low`, applied to the density offset. */
  shadowCastRgb: Rgb;
  /** darktable negadoctor `wb_high`, applied to density slope and offset. */
  highlightBalanceRgb: Rgb;
  paperBlack: number;
  paperGrade: number;
  paperGloss: number;
  printExposure: number;
  /** Optional exposed-content and neutral sampling areas used by the
   * one-shot robust automatic analyser. */
  contentRoi?: Rect;
  shadowRoi?: Rect;
  highlightRoi?: Rect;
}

export type Recipe = ClassicRecipe | NegadoctorRecipe;

/** Patch accepted by the renderer editor before it is re-narrowed by engine. */
export type RecipePatch = Partial<
  Omit<CommonRecipe, "engine">
  & Omit<ClassicRecipe, keyof CommonRecipe>
  & Omit<NegadoctorRecipe, keyof CommonRecipe>
> & { engine?: Recipe["engine"] };

export const DEFAULT_RECIPE: ClassicRecipe = {
  engine: "classic",
  rotate: 0,
  baseMode: "auto",
  dmaxMode: "auto",
  manualDmax: 1.2,
  autoNeutralize: true,
  temperatureKelvin: 5500,
  autoWhiteBalance: true,
  preSaturation: 1.08,
  exposure: 0,
  contrast: 1,
  highlightCompression: 0,
  saturation: 1,
};

/** Frozen compatibility defaults from darktable 5.6.0 negadoctor v2. */
export const DEFAULT_NEGADOCTOR_56: NegadoctorRecipe = {
  engine: "negadoctor-5.6",
  rotate: 0,
  baseMode: "manual",
  filmStock: "color",
  inputPrimaries: "srgb",
  workingSpace: "linear-rec2020",
  dminRgb: [1, 0.45, 0.25],
  dmax: 2.046,
  scanExposureBias: -0.05,
  shadowCastRgb: [1, 1, 1],
  highlightBalanceRgb: [1, 1, 1],
  paperBlack: 0.0755,
  paperGrade: 4,
  paperGloss: 0.75,
  printExposure: 0.9245,
};

export const NEGADOCTOR_56_COLOR_PRESET: NegadoctorRecipe = {
  ...DEFAULT_NEGADOCTOR_56,
  dminRgb: [1.13, 0.49, 0.27],
  dmax: 1.6,
};

export const NEGADOCTOR_56_BW_PRESET: NegadoctorRecipe = {
  ...DEFAULT_NEGADOCTOR_56,
  filmStock: "black-and-white",
  dminRgb: [1, 1, 1],
  dmax: 2.2,
  paperGrade: 5,
  printExposure: 1,
};
