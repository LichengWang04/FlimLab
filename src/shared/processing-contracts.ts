import type { CalibrationProfileDocument } from "../core/calibration.ts";
import type { CurveSet, Matrix3, PhotonTransferModel } from "../core/types.ts";
import type {
  MasterExportFormat,
  PreviewMode,
  PreviewResult,
  PreviewTone,
  PreviewView,
  ProcessingRecipe,
  ColorTrust,
} from "./contracts.ts";

/**
 * Messages exchanged only between the main process and the image utility
 * process.  File paths and full-resolution rasters deliberately never cross
 * the renderer boundary.
 */
export interface WorkerMessageBase {
  readonly requestId: string;
}

export interface WorkerLoadMessage extends WorkerMessageBase {
  readonly kind: "load";
  readonly assetId: string;
  readonly sourcePath: string;
  /** Prefer a compact Bayer preview when the native decoder supports it. */
  readonly preferGpuBayer?: boolean;
  /** Main-process-owned cache directory; never exposed to the renderer. */
  readonly previewCacheDirectory?: string;
  /**
   * Optional RAW decode ceiling for interactive previews. TIFF export omits
   * this field and therefore requests the original sensor resolution.
   */
  readonly previewMaxEdge?: number;
}

export interface WorkerRenderMessage extends WorkerMessageBase {
  readonly kind: "render";
  readonly assetId: string;
  readonly request: {
    readonly revision: number;
    readonly maxEdge: number;
    readonly mode: PreviewMode;
    readonly view: PreviewView;
    readonly tone: PreviewTone;
    readonly processing?: ProcessingRecipe;
    readonly dmaxOverride?: number;
    readonly dmaxChannelRange?: import("../core/types.ts").Rgb;
    readonly dmaxSampleRoi?: import("./contracts.ts").NormalizedRoi;
    readonly gpuInteractive?: boolean;
    readonly gpuReuseSourceKey?: string;
    readonly gpuSourceOnly?: boolean;
    readonly gpuBaseRgb?: readonly [number, number, number];
  };
  readonly calibrationProfile?: CalibrationProfileDocument;
}

export interface WorkerExportTiffMessage extends WorkerMessageBase {
  readonly kind: "export-tiff";
  readonly assetId: string;
  readonly outputPath: string;
  readonly suggestedFileName: string;
  readonly format?: MasterExportFormat;
  readonly mode: PreviewMode;
  readonly tone: PreviewTone;
  readonly processing?: ProcessingRecipe;
  readonly dmaxOverride?: number;
  readonly dmaxChannelRange?: import("../core/types.ts").Rgb;
  readonly calibrationProfile?: CalibrationProfileDocument;
}

export interface WorkerCalibrateCardMessage extends WorkerMessageBase {
  readonly kind: "calibrate-card";
  readonly assetId: string;
  readonly processing?: ProcessingRecipe;
}

export interface WorkerReleaseMessage extends WorkerMessageBase {
  readonly kind: "release";
  readonly assetId: string;
}

export interface WorkerCrashMessage extends WorkerMessageBase {
  readonly kind: "crash-for-acceptance";
  readonly assetId: string;
}

export type WorkerMessage =
  | WorkerLoadMessage
  | WorkerRenderMessage
  | WorkerExportTiffMessage
  | WorkerCalibrateCardMessage
  | WorkerReleaseMessage
  | WorkerCrashMessage;

export type WorkerCommand =
  | Omit<WorkerLoadMessage, "requestId">
  | Omit<WorkerRenderMessage, "requestId">
  | Omit<WorkerExportTiffMessage, "requestId">
  | Omit<WorkerCalibrateCardMessage, "requestId">
  | Omit<WorkerReleaseMessage, "requestId">
  | Omit<WorkerCrashMessage, "requestId">;

export interface DecodedSourceSummary {
  readonly assetId: string;
  readonly width: number;
  readonly height: number;
  readonly bitDepth: 8 | 16;
  readonly sourceDomain:
    | "camera-linear-rgb"
    | "camera-linear-bayer"
    | "transmission-linear-rgb";
  readonly decoder: "sharp-raster" | "libraw-sidecar";
  /** Sidecar build+demosaic identity used to validate a calibration profile. */
  readonly decoderFingerprint?: string;
  readonly camera?: SourceCameraIdentity;
  /** Exact camera/ISO PTC match; absent when the operating point is unknown. */
  readonly photonTransfer?: PhotonTransferModel;
  readonly warnings: readonly string[];
}

export interface SourceCameraIdentity {
  readonly make?: string;
  readonly model?: string;
}

export interface TiffExportSummary {
  readonly fileName: string;
  readonly width: number;
  readonly height: number;
  readonly bitDepth: 8 | 10 | 16;
  readonly colorSpace: "sRGB" | "linear-sRGB";
  readonly colorTrust: ColorTrust;
}

export interface ColorCardFitSummary {
  readonly curves: CurveSet;
  readonly matrix: Matrix3;
  readonly detectedPatchCount: number;
  readonly usedPatchCount: number;
  readonly rejectedPatchIds: readonly string[];
  readonly edgeScore: number;
  readonly decoderFingerprint?: string;
  readonly decoder: "sharp-raster" | "libraw-sidecar";
  readonly camera?: SourceCameraIdentity;
}

export type WorkerSuccessResult =
  | { readonly kind: "load"; readonly result: DecodedSourceSummary }
  | { readonly kind: "render"; readonly result: PreviewResult }
  | { readonly kind: "export-tiff"; readonly result: TiffExportSummary }
  | { readonly kind: "calibrate-card"; readonly result: ColorCardFitSummary }
  | { readonly kind: "release" };

export interface WorkerTelemetry {
  /** Highest resident set observed at command boundaries in this worker. */
  readonly observedPeakRssBytes: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
}

export interface WorkerSuccessMessage extends WorkerMessageBase {
  readonly ok: true;
  readonly response: WorkerSuccessResult;
  readonly telemetry?: WorkerTelemetry;
}

export interface WorkerFailureMessage extends WorkerMessageBase {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export type WorkerResponseMessage = WorkerSuccessMessage | WorkerFailureMessage;

export function isWorkerResponseMessage(value: unknown): value is WorkerResponseMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.requestId !== "string" || typeof record.ok !== "boolean") {
    return false;
  }
  if (record.ok) {
    return typeof record.response === "object" && record.response !== null;
  }
  return typeof record.error === "object" && record.error !== null;
}
