export const previewModes = ["generic", "preset", "calibrated"] as const;
export type PreviewMode = (typeof previewModes)[number];

export const previewViews = ["positive", "transmission", "density"] as const;
export type PreviewView = (typeof previewViews)[number];

export type ColorTrustLevel = "uncalibrated" | "profile-unverified" | "device-matched";

export type ColorTrustReason =
  | "generic-mode"
  | "default-preset"
  | "calibration-profile-missing"
  | "source-camera-unavailable"
  | "profile-camera-unavailable"
  | "camera-mismatch"
  | "decoder-unavailable"
  | "decoder-mismatch"
  | "device-match";

/**
 * Describes what may legitimately be claimed about upstream colour. An sRGB
 * ICC profile still describes delivery encoding; it does not by itself turn
 * uncharacterised camera RGB into device-accurate sRGB.
 */
export interface ColorTrust {
  readonly level: ColorTrustLevel;
  readonly reason: ColorTrustReason;
  readonly sourceCameraModel?: string;
  readonly profileCameraModel?: string;
}

/** Hard ceiling shared by renderer scheduling and the trusted IPC validator. */
export const maximumBackgroundPreviewEdge = 1_024;

export interface PreviewTone {
  readonly exposureStops: number;
  readonly contrast: number;
  readonly highlightCompression: number;
  readonly saturation: number;
}

/** Renderer-safe, serializable geometry controls. Values are normalized to the
 * decoded frame before rotation and crop are applied. */
export interface ProcessingGeometry {
  readonly rotation: 0 | 90 | 180 | 270;
  readonly straighten?: number;
  readonly crop?: NormalizedRoi;
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

/** Compact UI controls expanded into deterministic core filter settings only
 * inside the utility process. Zero-valued controls are no-ops. */
export interface RestorationControls {
  readonly dust: boolean;
  readonly scratches: boolean;
  readonly denoise: number;
  readonly sharpen: number;
}

/** A fixed reference is safe to persist and reuse. `automatic` is a transient
 * request used to calculate a candidate before the renderer freezes its RGB. */
export type FilmBaseOverride =
  | {
      readonly kind: "reference";
      readonly rgb: readonly [number, number, number];
      readonly origin: "sampled" | "estimated";
      readonly confidence: number;
      readonly sourceFrameId?: string;
    }
  | { readonly kind: "automatic" };

export interface ProcessingRecipe {
  /** Unexposed film-base sample area, normalized to the final cropped frame. */
  readonly baseRoi: NormalizedRoi;
  readonly filmBase?: FilmBaseOverride;
  readonly geometry: ProcessingGeometry;
  readonly restoration: RestorationControls;
  /**
   * Per-channel scene-linear gain sliders (white-balance trim), multiplied
   * on top of the mode's default whiteBalance. [1, 1, 1] means "no trim".
   */
  readonly channelGains?: readonly [number, number, number];
}

export const defaultProcessingRecipe: ProcessingRecipe = {
  baseRoi: { x: 0, y: 0, width: 0.08, height: 1 },
  geometry: { rotation: 0, straighten: 0 },
  restoration: { dust: false, scratches: false, denoise: 0, sharpen: 0 },
  channelGains: [1, 1, 1],
};

export interface PreviewRequest {
  readonly revision: number;
  /** Renderer-safe ID; its filesystem path is held only by SourceRegistry. */
  readonly assetId: string;
  readonly maxEdge: number;
  readonly mode: PreviewMode;
  readonly view: PreviewView;
  readonly tone: PreviewTone;
  readonly calibrationProfileId?: string;
  readonly processing?: ProcessingRecipe;
  /** Roll-wide absolute Dmax override; omitted means automatic measurement. */
  readonly dmaxOverride?: number;
  /** Temporary normalized ROI used when sampling a manual Dmax. */
  readonly dmaxSampleRoi?: NormalizedRoi;
  /**
   * Interactive WebGL2 path: the worker analyzes a small proxy for film-base
   * and exposure metadata, while the requested decoder-linear raster is sent
   * directly to the GPU. A lightweight RGBA fallback is still included.
   */
  readonly gpuInteractive?: boolean;
  /** Omit decoder pixels when this exact source texture is already resident. */
  readonly gpuReuseSourceKey?: string;
  /** Internal full-resolution source request used by tiled GPU master export. */
  readonly gpuSourceOnly?: boolean;
  readonly gpuBaseRgb?: readonly [number, number, number];
}

export interface PreviewBaseSummary {
  readonly rgb: readonly [number, number, number];
  readonly sampleCount: number;
  readonly rejectedCount: number;
  readonly method: "roi" | "reference" | "automatic";
  readonly confidence: number;
}

export interface PreviewDensitySummary {
  readonly dmin: number;
  readonly dmax: number;
  readonly range: number;
}

export interface PreviewResult {
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  /**
   * Positive-view scene-linear RGB for the interactive GPU tone stage.
   * Omitted for diagnostic views and retained alongside rgba as a safe CPU
   * fallback when WebGL2 is unavailable.
   */
  readonly sceneLinear?: Float32Array;
  readonly displayWhitePoint?: number;
  /**
   * Decoder-linear source and immutable transform data for the full WebGL2
   * preview pipeline. The source is uploaded once, then geometry, restoration,
   * density inversion and film colour are evaluated on the GPU.
   */
  readonly gpuPipeline?: GpuPipelinePayload;
  /** Applied only for an exact camera/ISO operating-point match. */
  readonly photonTransfer?: PhotonTransferModel;
  readonly base: PreviewBaseSummary;
  readonly density: PreviewDensitySummary;
  readonly colorTrust: ColorTrust;
  readonly elapsedMs: number;
  readonly warnings: readonly string[];
}

export interface GpuPipelinePayload {
  /** Stable for the lifetime and resolution of one decoded source raster. */
  readonly sourceKey: string;
  /** Omitted only when `sourceKey` is already resident in the renderer. */
  readonly sourceLinear?: Float32Array;
  /** Normalized single-channel Bayer samples for GPU demosaic. */
  readonly sourceBayer?: Uint16Array;
  /** Row-major 2×2 CFA tile; 0=red, 1=green, 2=blue. */
  readonly bayerPattern?: readonly [
    0 | 1 | 2,
    0 | 1 | 2,
    0 | 1 | 2,
    0 | 1 | 2,
  ];
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly baseRgb: readonly [number, number, number];
  readonly film: FilmMode;
  readonly photonTransfer?: PhotonTransferModel;
}

import type {
  SourceAsset,
  WorkspaceProject,
  WorkspaceProjectDraft,
} from "./project.ts";
import type { FilmMode, NormalizedRoi, PhotonTransferModel } from "../core/types.ts";

export type { NormalizedRoi } from "../core/types.ts";

export type { SourceAsset } from "./project.ts";

export interface PreviewPngExportRequest {
  readonly suggestedFileName: string;
  readonly png: Uint8Array;
}

export interface PreviewPngExportResult {
  readonly saved: boolean;
  readonly fileName?: string;
}

export type MasterExportFormat = "tiff" | "jpeg" | "heif" | "dng";

export interface MasterTiffExportRequest {
  readonly assetId: string;
  readonly suggestedFileName: string;
  readonly format?: MasterExportFormat;
  readonly mode: PreviewMode;
  readonly tone: PreviewTone;
  readonly calibrationProfileId?: string;
  readonly processing?: ProcessingRecipe;
  readonly dmaxOverride?: number;
}

export interface MasterTiffExportResult {
  readonly saved: boolean;
  readonly fileName?: string;
  readonly width?: number;
  readonly height?: number;
  readonly colorTrust?: ColorTrust;
}

export interface GpuMasterTiffExportRequest {
  readonly suggestedFileName: string;
  readonly width: number;
  readonly height: number;
  /** GPU-encoded, gamma-correct 16-bit sRGB samples in interleaved RGB order. */
  readonly srgb16: Uint16Array;
  readonly processingMetadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface GpuMasterTiffBeginRequest {
  readonly suggestedFileName: string;
  readonly format?: MasterExportFormat;
  readonly width: number;
  readonly height: number;
  readonly rowsPerStrip: number;
  readonly processingMetadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface GpuMasterTiffBeginResult {
  readonly saved: boolean;
  readonly sessionId?: string;
}

export interface GpuMasterTiffStripRequest {
  readonly sessionId: string;
  readonly outputY: number;
  readonly width: number;
  readonly height: number;
  /** sRGB for TIFF/JPEG/HEIF; display-linear RGB for DNG. */
  readonly rgb16: Uint16Array;
}

/** A renderer-safe description; calibration source files stay in userData. */
export interface CalibrationProfileSummary {
  readonly id: string;
  readonly calibrationId: string;
  readonly captureFingerprint: string;
  readonly label: string;
  readonly hasLut: boolean;
}

export interface ColorCardCalibrationResult {
  readonly profile: CalibrationProfileSummary;
  readonly detectedPatchCount: number;
  readonly usedPatchCount: number;
  readonly rejectedPatchIds: readonly string[];
  readonly edgeScore: number;
}

export interface ProjectRelinkResult {
  readonly relinkedAssetIds: readonly string[];
  /** Descriptors enriched with identities after relinking a legacy project. */
  readonly relinkedAssets: readonly SourceAsset[];
  readonly missingAssets: readonly SourceAsset[];
}

export interface ProjectLoadResult extends ProjectRelinkResult {
  readonly project: WorkspaceProject;
  readonly session: ProjectSessionSummary;
  readonly recentProjects: readonly RecentProjectSummary[];
  readonly restoredCalibrationProfileIds: readonly string[];
}

export type ProjectPendingAction = "migration" | "recovery";

/** Renderer-safe project session state. Absolute directories remain private. */
export interface ProjectSessionSummary {
  /** Unique for each open/create operation; delayed writes from older sessions are rejected. */
  readonly id: string;
  /** Stable opaque ID used to match this session with the machine-private recent list. */
  readonly projectId: string;
  readonly name: string;
  readonly readOnly: boolean;
  readonly pendingAction?: ProjectPendingAction;
  readonly migratedFromVersion?: number;
  readonly backupCount: number;
}

export interface RecentProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly lastOpenedAt: string;
  readonly available: boolean;
}

export interface OpenRecentProjectRequest {
  readonly id: string;
  readonly readOnly: boolean;
}

export interface ProjectBackupResult {
  readonly created: boolean;
  readonly createdAt?: string;
  readonly backupCount: number;
}

export interface ProjectSaveResult {
  readonly project: WorkspaceProject;
  readonly backupCount: number;
}

export type BatchJobState = "queued" | "running" | "completed" | "cancelled" | "failed";

export interface BatchTiffExportItem {
  readonly assetId: string;
  readonly mode: PreviewMode;
  readonly tone: PreviewTone;
  readonly calibrationProfileId?: string;
  readonly processing?: ProcessingRecipe;
  readonly dmaxOverride?: number;
}

export interface BatchTiffExportRequest {
  readonly items: readonly BatchTiffExportItem[];
}

export interface BatchJobSummary {
  readonly id: string;
  readonly state: BatchJobState;
  readonly total: number;
  readonly completed: number;
  readonly currentAssetId?: string;
  readonly failedAssetIds: readonly string[];
  readonly cancelRequested: boolean;
  readonly error?: string;
}

export interface FilmLabApi {
  readonly selectSourceFiles: () => Promise<readonly SourceAsset[]>;
  readonly renderPreview: (request: PreviewRequest) => Promise<PreviewResult>;
  /**
   * Low-priority preview rendered by a separate utility process. The renderer
   * uses it to warm frame switches without delaying the interactive worker.
   */
  readonly precomputePreview: (request: PreviewRequest) => Promise<PreviewResult>;
  readonly loadProject: () => Promise<ProjectLoadResult>;
  readonly createProject: () => Promise<ProjectLoadResult | undefined>;
  readonly openProject: (readOnly: boolean) => Promise<ProjectLoadResult | undefined>;
  readonly openRecentProject: (request: OpenRecentProjectRequest) => Promise<ProjectLoadResult>;
  readonly saveProject: (sessionId: string, project: WorkspaceProjectDraft) => Promise<ProjectSaveResult>;
  readonly saveProjectAs: (sessionId: string, project: WorkspaceProjectDraft) => Promise<ProjectLoadResult | undefined>;
  readonly confirmProjectPendingAction: (sessionId: string, project: WorkspaceProjectDraft) => Promise<ProjectLoadResult>;
  readonly createProjectBackup: (sessionId: string) => Promise<ProjectBackupResult>;
  readonly onRequestClose: (listener: () => void) => () => void;
  readonly confirmClose: () => void;
  readonly exportPreviewPng: (request: PreviewPngExportRequest) => Promise<PreviewPngExportResult>;
  readonly exportMasterTiff: (request: MasterTiffExportRequest) => Promise<MasterTiffExportResult>;
  readonly exportGpuMasterTiff: (request: GpuMasterTiffExportRequest) => Promise<MasterTiffExportResult>;
  readonly beginGpuMasterTiff: (request: GpuMasterTiffBeginRequest) => Promise<GpuMasterTiffBeginResult>;
  readonly appendGpuMasterTiffStrip: (request: GpuMasterTiffStripRequest) => Promise<void>;
  readonly finishGpuMasterTiff: (sessionId: string) => Promise<MasterTiffExportResult>;
  readonly cancelGpuMasterTiff: (sessionId: string) => Promise<void>;
  readonly importCalibrationProfile: () => Promise<CalibrationProfileSummary | undefined>;
  readonly listCalibrationProfiles: () => Promise<readonly CalibrationProfileSummary[]>;
  readonly generateCalibrationFromColorCard: (assetId: string, processing?: ProcessingRecipe) => Promise<ColorCardCalibrationResult>;
  readonly relinkProjectSources: (assets: readonly SourceAsset[]) => Promise<ProjectRelinkResult>;
  readonly startBatchTiffExport: (request: BatchTiffExportRequest) => Promise<BatchJobSummary | undefined>;
  readonly getBatchJob: (jobId: string) => Promise<BatchJobSummary | undefined>;
  readonly cancelBatchJob: (jobId: string) => Promise<BatchJobSummary | undefined>;
}
