import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import sharp from "sharp";

import {
  processFilm,
  processFilmToScene,
  Raster,
  fitColorCardRaster,
  matchPhotonTransferModel,
  rasterToSrgbRgba,
  toneMapToSrgbRgba,
  toRuntimeCalibrationProfile,
  type CalibrationProfileDocument,
  type CurveSet,
  type FilmMode,
  type Matrix3,
  type PhotonTransferModel,
  type PipelineSceneResult,
  type RestorationSettings,
} from "../core/index.ts";
import type { ColorTrust, PreviewResult, ProcessingRecipe } from "../shared/contracts.ts";
import { colorTrustAllowsFormat, colorTrustMetadata, evaluateColorTrust } from "../shared/color-trust.ts";
import { supportsExactGpuFilmCurves } from "../shared/gpu-film-compatibility.ts";
import type {
  DecodedSourceSummary,
  TiffExportSummary,
  WorkerMessage,
  WorkerResponseMessage,
  SourceCameraIdentity,
} from "../shared/processing-contracts.ts";
import { writeDisplayLinearMaster } from "./master-export-codec.ts";
import { recommendedImageThreadCount } from "./image-worker-performance.ts";
import {
  createDecodedPreviewCacheEntry,
  readDecodedBayerCache,
  readDecodedPreviewCache,
  writeDecodedBayerCacheMetadata,
  writeDecodedPreviewCache,
  writeDecodedPreviewCacheMetadata,
  type CachedBayerPreview,
  type DecodedPreviewCacheEntry,
} from "./decoded-preview-cache.ts";
import { scrgbFloatBufferToRaster } from "./input-color.ts";

// libvips performs decode/resize/encode work on its native thread pool. Leave
// compositor capacity available so a full-resolution job cannot starve the UI.
sharp.concurrency(recommendedImageThreadCount(availableParallelism()));
sharp.simd(true);

const rawExtensions = new Set([
  ".dng", ".nef", ".cr2", ".cr3", ".arw", ".raf", ".rw2", ".orf", ".iiq", ".pef", ".srw",
]);
const tiffExtensions = new Set([".tif", ".tiff"]);
const maximumInputPixels = 80_000_000;
const FILM_BASE_ROI = { x: 0, y: 0, width: 0.08, height: 1 } as const;
const gpuInteractiveAnalysisEdge = 320;

const C41_MATRIX: Matrix3 = [
  [1.06, -0.04, -0.02],
  [-0.025, 1.05, -0.025],
  [-0.035, -0.04, 1.075],
];
// The three C-41 channels share one neutral characteristic curve: equal
// relative densities map to equal scene values, so a neutral grey stays
// neutral through the inversion. Per-channel curve asymmetry used to bend
// each dye layer independently and produced a systematic cast on every
// camera (shadows toward green, mid-tones/highlights toward blue). Dye
// cross-talk is expressed by C41_MATRIX, and sensor/channel balance by the
// preset's whiteBalance.
const C41_CURVES: CurveSet = [
  [
    { x: 0, y: 0 },
    { x: 0.24, y: 0.155 },
    { x: 0.62, y: 0.93 },
    { x: 1.08, y: 2.09 },
  ],
  [
    { x: 0, y: 0 },
    { x: 0.24, y: 0.155 },
    { x: 0.62, y: 0.93 },
    { x: 1.08, y: 2.09 },
  ],
  [
    { x: 0, y: 0 },
    { x: 0.24, y: 0.155 },
    { x: 0.62, y: 0.93 },
    { x: 1.08, y: 2.09 },
  ],
];

interface CachedAsset {
  readonly source: Raster;
  readonly gpuBayer?: GpuBayerSource;
  readonly summary: DecodedSourceSummary;
  readonly previewRasters: Map<number, Raster>;
  readonly generation: number;
}

interface GpuBayerSource {
  readonly width: number;
  readonly height: number;
  readonly data: Uint16Array;
  /** Row-major 2x2 CFA channels: 0 = red, 1 = green, 2 = blue. */
  readonly pattern: readonly [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2];
}

const assets = new Map<string, CachedAsset>();
let assetGeneration = 0;
const previewStageCache = new Map<string, PipelineSceneResult>();
const maximumPreviewStageCacheEntries = 2;
let rawSidecarSession: RawSidecarSession | undefined;
let observedPeakRssBytes = 0;
const parentPort = process.parentPort;

if (parentPort === undefined) {
  throw new Error("FilmLab image worker must run as an Electron utility process.");
}

parentPort.on("message", (event: unknown) => {
  // Electron utility-process ports use a DOM-style MessageEvent, whereas a
  // Node MessagePort delivers the payload directly. Normalise both forms so
  // the worker never silently ignores its load/render command.
  const value = typeof event === "object" && event !== null && "data" in event
    ? (event as { readonly data: unknown }).data
    : event;
  void handleMessage(value);
});

async function handleMessage(value: unknown): Promise<void> {
  if (!isWorkerMessage(value)) {
    return;
  }
  try {
    if (value.kind === "crash-for-acceptance") {
      process.exit(86);
    }
    if (value.kind === "load") {
      const summary = await loadAsset(
        value.assetId,
        value.sourcePath,
        value.previewMaxEdge,
        value.previewCacheDirectory,
        value.preferGpuBayer === true,
      );
      postSuccess(value.requestId, { kind: "load", result: summary });
      return;
    }
    if (value.kind === "render") {
      const result = renderAsset(value.assetId, value.request, value.calibrationProfile);
      postSuccess(value.requestId, { kind: "render", result });
      return;
    }
    if (value.kind === "calibrate-card") {
      const result = calibrateColorCard(value.assetId, value.processing);
      postSuccess(value.requestId, { kind: "calibrate-card", result });
      return;
    }
    if (value.kind === "release") {
      assets.delete(value.assetId);
      previewStageCache.clear();
      postSuccess(value.requestId, { kind: "release" });
      return;
    }
    const result = await exportAsset(value.assetId, value);
    postSuccess(value.requestId, { kind: "export-tiff", result });
  } catch (error: unknown) {
    postFailure(value.requestId, error);
  }
}

function calibrateColorCard(
  assetId: string,
  processing: ProcessingRecipe | undefined,
) {
  const cached = getCachedAsset(assetId);
  // The card detector intentionally works on the same geometry/base recipe
  // that the user will apply to negatives. It requires an upright,
  // perspective-rectified 6×4 ColorChecker Classic card.
  const normalized = processFilm(
    cached.source,
    createPipelineSettings("generic", {
      exposureStops: 0,
      contrast: 1,
      highlightCompression: 0,
      saturation: 1,
    }, undefined, processing, undefined, undefined, cached.summary.photonTransfer),
  ).sceneLinear;
  const fit = fitColorCardRaster(normalized, colorCheckerClassicReferences(), {
    detection: { layout: { columns: 6, rows: 4 }, minimumSwatchSize: 8 },
    matrix: { minimumPatchCount: 18 },
  });
  return {
    matrix: fit.matrixFit.matrix,
    detectedPatchCount: fit.samples.length,
    usedPatchCount: fit.matrixFit.usedPatchCount,
    rejectedPatchIds: fit.matrixFit.rejectedPatchIds,
    edgeScore: fit.grid.edgeScore,
    decoderFingerprint: cached.summary.decoderFingerprint,
    decoder: cached.summary.decoder,
    camera: cached.summary.camera,
  };
}

function colorCheckerClassicReferences() {
  // BabelColor/Macbeth ColorChecker Classic approximate sRGB D65 patch values,
  // arranged left-to-right, top-to-bottom. They are converted to linear sRGB
  // before the core ridge fit; users can still import a lab-specific profile.
  const srgb = [
    [115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170],
    [214, 126, 44], [80, 91, 166], [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
    [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31], [187, 86, 149], [8, 133, 161],
    [243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52],
  ] as const;
  return srgb.map((value, index) => ({
    id: "cc24-" + String(index + 1).padStart(2, "0"),
    target: [toLinearSrgb(value[0]), toLinearSrgb(value[1]), toLinearSrgb(value[2])] as const,
  }));
}

function toLinearSrgb(value: number): number {
  const encoded = value / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : Math.pow((encoded + 0.055) / 1.055, 2.4);
}

async function loadAsset(
  assetId: string,
  sourcePath: string,
  previewMaxEdge?: number,
  previewCacheDirectory?: string,
  preferGpuBayer = false,
): Promise<DecodedSourceSummary> {
  assertIdentifier(assetId, "源文件 ID");
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    throw new ImageWorkerError("INVALID_SOURCE", "源文件路径无效。");
  }
  const extension = extname(sourcePath).toLowerCase();
  let rawExecutable: string | undefined;
  let cacheEntry: DecodedPreviewCacheEntry | undefined;
  if (previewMaxEdge !== undefined && previewCacheDirectory !== undefined) {
    const decoder = await previewDecoderIdentity(extension, preferGpuBayer);
    rawExecutable = decoder.rawExecutable;
    cacheEntry = await createDecodedPreviewCacheEntry(
      previewCacheDirectory,
      sourcePath,
      previewMaxEdge,
      decoder.identity,
    );
    if (preferGpuBayer && rawExtensions.has(extension)) {
      const cachedBayer = await readDecodedBayerCache(cacheEntry);
      if (cachedBayer !== undefined) {
        return storeDecodedAsset(assetId, decodedAssetFromBayer(cachedBayer));
      }
      // An older installed sidecar may have fallen back to its RGB decoder
      // under the same executable fingerprint.
      const cachedRgbFallback = await readDecodedPreviewCache(cacheEntry);
      if (cachedRgbFallback !== undefined) {
        return storeDecodedAsset(assetId, cachedRgbFallback);
      }
    } else {
      const cached = await readDecodedPreviewCache(cacheEntry);
      if (cached !== undefined) {
        return storeDecodedAsset(assetId, cached);
      }
    }
  }
  let decoded: DecodedAsset;
  if (rawExtensions.has(extension)) {
    decoded = await decodeRawSource(
      sourcePath,
      previewMaxEdge,
      rawExecutable,
      cacheEntry?.pixelsPath,
      preferGpuBayer,
    );
  } else if (tiffExtensions.has(extension)) {
    decoded = await decodeTiffSource(sourcePath, previewMaxEdge);
  } else {
    throw new ImageWorkerError(
      "UNSUPPORTED_SOURCE",
      "真实处理仅接受相机 RAW 或 16-bit TIFF；不接受 gamma 编码 PNG/JPEG。",
    );
  }
  if (cacheEntry !== undefined && previewCacheDirectory !== undefined) {
    try {
      if (decoded.gpuBayer !== undefined && decoded.persistedCachePixels) {
        await writeDecodedBayerCacheMetadata(
          previewCacheDirectory,
          cacheEntry,
          {
            ...decoded.gpuBayer,
            summary: decoded.summary,
          },
        );
      } else if (decoded.persistedCachePixels) {
        await writeDecodedPreviewCacheMetadata(
          previewCacheDirectory,
          cacheEntry,
          decoded,
        );
      } else {
        await writeDecodedPreviewCache(
          previewCacheDirectory,
          cacheEntry,
          decoded,
          decoded.encodedCachePixels,
        );
      }
    } catch {
      // Preview caching is an acceleration only; a cache permission or quota
      // failure must never prevent the decoded frame from being displayed.
    }
  }
  return storeDecodedAsset(assetId, decoded);
}

function storeDecodedAsset(assetId: string, decoded: DecodedAsset): DecodedSourceSummary {
  const summary: DecodedSourceSummary = { assetId, ...decoded.summary };
  assetGeneration += 1;
  assets.set(assetId, {
    source: decoded.source,
    gpuBayer: decoded.gpuBayer,
    summary,
    previewRasters: new Map(),
    generation: assetGeneration,
  });
  previewStageCache.clear();
  return summary;
}

async function previewDecoderIdentity(
  extension: string,
  preferGpuBayer: boolean,
): Promise<{ readonly identity: string; readonly rawExecutable?: string }> {
  if (!rawExtensions.has(extension)) {
    return {
      identity: "sharp:" + sharp.versions.sharp + ":vips:" + sharp.versions.vips,
    };
  }
  const executable = await findRawSidecar();
  if (executable === undefined) {
    return { identity: "libraw-sidecar:unavailable" };
  }
  const details = await stat(executable);
  return {
    identity: [
      "libraw-sidecar",
      executable,
      details.size,
      details.mtimeMs,
      preferGpuBayer ? "gpu-bayer-v1" : "bilinear-bayer-v1",
    ].join(":"),
    rawExecutable: executable,
  };
}

function renderAsset(
  assetId: string,
  request: {
    readonly revision: number;
    readonly maxEdge: number;
    readonly mode: "generic" | "preset" | "calibrated";
    readonly view: "positive" | "transmission" | "density";
    readonly tone: { readonly exposureStops: number; readonly contrast: number; readonly highlightCompression: number; readonly saturation: number };
    readonly processing?: ProcessingRecipe;
    readonly dmaxOverride?: number;
    readonly dmaxSampleRoi?: import("../shared/contracts.ts").NormalizedRoi;
    readonly gpuInteractive?: boolean;
    readonly gpuReuseSourceKey?: string;
    readonly gpuSourceOnly?: boolean;
    readonly gpuBaseRgb?: readonly [number, number, number];
  },
  calibrationProfile: CalibrationProfileDocument | undefined,
): PreviewResult {
  const cached = getCachedAsset(assetId);
  assertPreviewRequest(request);
  const startedAt = Date.now();
  const source = getPreviewRaster(cached, request.maxEdge);
  const pipelineSettings = createPipelineSettings(
    request.mode,
    request.tone,
    calibrationProfile,
    request.processing,
    request.dmaxOverride,
    request.dmaxSampleRoi,
    cached.summary.photonTransfer,
  );
  const colorTrust = evaluateColorTrust(request.mode, cached.summary, calibrationProfile);
  const gpuFilmCurvesAreExact = supportsExactGpuFilmCurves(pipelineSettings.film);
  if (request.gpuSourceOnly) {
    if (!gpuFilmCurvesAreExact) {
      throw new ImageWorkerError(
        "GPU_CURVE_UNSUPPORTED",
        "标定曲线超过 GPU 精确处理上限，请使用 CPU 母版导出。",
      );
    }
    // Compute the display white point from the same 320-edge analysis the
    // interactive preview uses, so the GPU master export matches what the
    // screen shows even when the renderer's cached preview is stale
    // (e.g. a Dmax or film-base change that has not re-rendered yet).
    const analysisSource = getPreviewRaster(
      cached,
      Math.min(gpuInteractiveAnalysisEdge, request.maxEdge),
    );
    const analysis = processFilmToScene(analysisSource, pipelineSettings);
    const gpuSource = cached.gpuBayer;
    const sourceWidth = gpuSource?.width ?? source.width;
    const sourceHeight = gpuSource?.height ?? source.height;
    const baseRgb = request.gpuBaseRgb
      ?? (request.processing?.filmBase?.kind === "reference"
        ? request.processing.filmBase.rgb
        : [1, 1, 1] as const);
    return {
      revision: request.revision,
      width: sourceWidth,
      height: sourceHeight,
      rgba: new Uint8Array(0),
      displayWhitePoint: analysis.displayWhitePoint,
      photonTransfer: pipelineSettings.photonTransfer,
      gpuPipeline: {
        sourceKey: createGpuSourceKey(
          assetId,
          cached.generation,
          sourceWidth,
          sourceHeight,
          gpuSource === undefined ? "rgb" : "bayer",
        ),
        sourceLinear: gpuSource === undefined ? source.data : undefined,
        sourceBayer: gpuSource?.data,
        bayerPattern: gpuSource?.pattern,
        sourceWidth,
        sourceHeight,
        baseRgb,
        film: pipelineSettings.film,
        photonTransfer: pipelineSettings.photonTransfer,
      },
      base: {
        rgb: baseRgb,
        sampleCount: 0,
        rejectedCount: 0,
        method: "reference",
        confidence: 1,
      },
      density: { dmin: 0, dmax: 0, range: 0 },
      colorTrust,
      elapsedMs: Date.now() - startedAt,
      warnings: [],
    };
  }
  if (request.gpuInteractive && gpuFilmCurvesAreExact) {
    return renderGpuInteractivePreview(
      assetId,
      cached,
      source,
      request,
      pipelineSettings,
      colorTrust,
      startedAt,
    );
  }
  const stageKey = createPreviewStageKey(assetId, assetGeneration, request, calibrationProfile);
  let processed: PipelineSceneResult;
  const cachedStage = previewStageCache.get(stageKey);
  if (cachedStage !== undefined) {
    processed = cachedStage;
    previewStageCache.delete(stageKey);
    previewStageCache.set(stageKey, cachedStage);
  } else {
    processed = processFilmToScene(
      source,
      pipelineSettings,
    );
    previewStageCache.set(stageKey, processed);
    while (previewStageCache.size > maximumPreviewStageCacheEntries) {
      const oldest = previewStageCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      previewStageCache.delete(oldest);
    }
  }
  const output = request.view === "transmission"
    ? processed.transmission
    : request.view === "density"
      ? densityVisualization(processed.density)
      : undefined;
  const width = output?.width ?? processed.sceneLinear.width;
  const height = output?.height ?? processed.sceneLinear.height;
  const rgba = output === undefined
    ? toneMapToSrgbRgba(processed.sceneLinear, { ...request.tone, whitePoint: processed.displayWhitePoint })
    : rasterToSrgbRgba(output);

  return {
    revision: request.revision,
    width,
    height,
    rgba,
    sceneLinear: output === undefined ? processed.sceneLinear.data : undefined,
    displayWhitePoint: output === undefined ? processed.displayWhitePoint : undefined,
    photonTransfer: pipelineSettings.photonTransfer,
    ...(gpuFilmCurvesAreExact ? {
      gpuPipeline: {
        sourceKey: createGpuSourceKey(
          assetId,
          cached.generation,
          source.width,
          source.height,
          "rgb",
        ),
        sourceLinear: source.data,
        sourceWidth: source.width,
        sourceHeight: source.height,
        baseRgb: processed.base.rgb,
        film: pipelineSettings.film,
        photonTransfer: pipelineSettings.photonTransfer,
      },
    } : {}),
    base: {
      rgb: processed.base.rgb,
      sampleCount: processed.base.sampleCount,
      rejectedCount: processed.base.rejectedCount,
      method: processed.base.method,
      confidence: processed.base.confidence,
    },
    density: processed.densityAnchors,
    colorTrust,
    elapsedMs: Date.now() - startedAt,
    warnings: [
      ...cached.summary.warnings,
      ...buildWarnings(request.mode, colorTrust),
      ...buildBaseSampleWarnings(processed.base),
      ...(gpuFilmCurvesAreExact
        ? []
        : ["标定曲线超过 GPU 精确处理上限；当前预览已自动使用 CPU 精确路径。"]),
    ],
  };
}

/**
 * The full decoder-linear raster is consumed by WebGL2. Only the statistics
 * needed to initialise the shader (film base, density range and display white)
 * are evaluated on a small proxy. This removes the former full-frame CPU
 * geometry/restoration/density/film/tone pass from every interactive preview.
 */
function renderGpuInteractivePreview(
  assetId: string,
  cached: CachedAsset,
  source: Raster,
  request: {
    readonly revision: number;
    readonly maxEdge: number;
    readonly mode: "generic" | "preset" | "calibrated";
    readonly view: "positive" | "transmission" | "density";
    readonly tone: { readonly exposureStops: number; readonly contrast: number; readonly highlightCompression: number; readonly saturation: number };
    readonly processing?: ProcessingRecipe;
    readonly dmaxOverride?: number;
    readonly gpuReuseSourceKey?: string;
  },
  pipelineSettings: ReturnType<typeof createPipelineSettings>,
  colorTrust: ColorTrust,
  startedAt: number,
): PreviewResult {
  const analysisSource = getPreviewRaster(
    cached,
    Math.min(gpuInteractiveAnalysisEdge, request.maxEdge),
  );
  const analysis = processFilmToScene(analysisSource, pipelineSettings);
  const analysisOutput = request.view === "transmission"
    ? analysis.transmission
    : request.view === "density"
      ? densityVisualization(analysis.density)
      : analysis.sceneLinear;
  const analysisRgba = request.view === "positive"
    ? toneMapToSrgbRgba(
        analysis.sceneLinear,
        { ...request.tone, whitePoint: analysis.displayWhitePoint },
      )
    : rasterToSrgbRgba(analysisOutput);

  const gpuSource = cached.gpuBayer;
  const sourceWidth = gpuSource?.width ?? source.width;
  const sourceHeight = gpuSource?.height ?? source.height;
  const scale = Math.max(
    sourceWidth / analysisSource.width,
    sourceHeight / analysisSource.height,
  );
  const width = Math.max(1, Math.round(analysisOutput.width * scale));
  const height = Math.max(1, Math.round(analysisOutput.height * scale));
  const rgba = resizeRgbaNearest(
    analysisRgba,
    analysisOutput.width,
    analysisOutput.height,
    width,
    height,
  );
  const sourceKey = createGpuSourceKey(
    assetId,
    cached.generation,
    sourceWidth,
    sourceHeight,
    gpuSource === undefined ? "rgb" : "bayer",
  );
  const supplySource = request.gpuReuseSourceKey !== sourceKey;

  return {
    revision: request.revision,
    width,
    height,
    rgba,
    displayWhitePoint: request.view === "positive"
      ? analysis.displayWhitePoint
      : undefined,
    photonTransfer: pipelineSettings.photonTransfer,
    gpuPipeline: {
      sourceKey,
      sourceLinear: supplySource && gpuSource === undefined ? source.data : undefined,
      sourceBayer: supplySource ? gpuSource?.data : undefined,
      bayerPattern: gpuSource?.pattern,
      sourceWidth,
      sourceHeight,
      baseRgb: analysis.base.rgb,
      film: pipelineSettings.film,
      photonTransfer: pipelineSettings.photonTransfer,
    },
    base: {
      rgb: analysis.base.rgb,
      sampleCount: analysis.base.sampleCount,
      rejectedCount: analysis.base.rejectedCount,
      method: analysis.base.method,
      confidence: analysis.base.confidence,
    },
    density: analysis.densityAnchors,
    colorTrust,
    elapsedMs: Date.now() - startedAt,
    warnings: [
      ...cached.summary.warnings,
      ...buildWarnings(request.mode, colorTrust),
      ...buildBaseSampleWarnings(analysis.base),
    ],
  };
}

function resizeRgbaNearest(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): Uint8Array {
  if (sourceWidth === width && sourceHeight === height) return source;
  const output = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor((y + 0.5) * sourceHeight / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x + 0.5) * sourceWidth / width));
      const from = (sourceY * sourceWidth + sourceX) * 4;
      const to = (y * width + x) * 4;
      output[to] = source[from];
      output[to + 1] = source[from + 1];
      output[to + 2] = source[from + 2];
      output[to + 3] = source[from + 3];
    }
  }
  return output;
}

async function exportAsset(
  assetId: string,
  request: Extract<WorkerMessage, { readonly kind: "export-tiff" }>,
): Promise<TiffExportSummary> {
  const cached = getCachedAsset(assetId);
  assertIdentifier(request.suggestedFileName, "导出文件名");
  if (typeof request.outputPath !== "string" || request.outputPath.length === 0) {
    throw new ImageWorkerError("INVALID_OUTPUT", "图像输出路径无效。");
  }
  const format = request.format ?? "tiff";
  const colorTrust = evaluateColorTrust(request.mode, cached.summary, request.calibrationProfile);
  if (!colorTrustAllowsFormat(format, colorTrust)) {
    throw new ImageWorkerError(
      "DNG_REQUIRES_DEVICE_MATCH",
      "DNG 色彩母版仅支持相机与解码链均匹配的校准配置；当前设置可改为 TIFF、JPG 或 HEIF 渲染输出。",
    );
  }
  const processed = processFilm(
    cached.source,
    createPipelineSettings(
      request.mode,
      request.tone,
      request.calibrationProfile,
      request.processing,
      request.dmaxOverride,
      undefined,
      cached.summary.photonTransfer,
    ),
  );
  const written = await writeDisplayLinearMaster({
    format,
    width: processed.displayLinear.width,
    height: processed.displayLinear.height,
    rowsPerStrip: 256,
    data: processed.displayLinear.data,
    outputPath: request.outputPath,
    processingMetadata: {
      application: "FilmLab",
      source: basename(cached.summary.assetId),
      decoder: cached.summary.decoder,
      mode: request.mode,
      calibrationProfileId: request.calibrationProfile?.id ?? "",
      calibrationCaptureFingerprint: request.calibrationProfile?.captureFingerprint ?? "",
      sourceDomain: cached.summary.sourceDomain,
      deliveryEncoding: format === "dng" ? "linear-srgb" : "srgb",
      ...colorTrustMetadata(colorTrust),
      photonTransferProfileId: cached.summary.photonTransfer?.profileId ?? "",
    },
  });
  return {
    fileName: basename(request.outputPath),
    width: processed.displayLinear.width,
    height: processed.displayLinear.height,
    bitDepth: written.bitDepth,
    colorSpace: written.colorSpace,
    colorTrust,
  };
}

function createPipelineSettings(
  mode: "generic" | "preset" | "calibrated",
  tone: { readonly exposureStops: number; readonly contrast: number; readonly highlightCompression: number; readonly saturation: number },
  calibrationProfile: CalibrationProfileDocument | undefined,
  processing: ProcessingRecipe | undefined,
  dmaxOverride?: number,
  dmaxSampleRoi?: import("../shared/contracts.ts").NormalizedRoi,
  photonTransfer?: PhotonTransferModel,
) {
  return {
    baseRoi: processing?.baseRoi ?? FILM_BASE_ROI,
    baseStrategy: processing?.filmBase?.kind === "reference"
      ? { kind: "reference" as const, rgb: processing.filmBase.rgb, confidence: processing.filmBase.confidence }
      : processing?.filmBase?.kind === "automatic"
        ? { kind: "automatic" as const }
        : undefined,
    geometry: processing?.geometry,
    dmaxOverride,
    dmaxSampleRoi,
    restoration: toRestorationSettings(processing),
    photonTransfer,
    film: getFilmMode(mode, calibrationProfile, processing?.channelGains),
    tone,
  };
}

function toRestorationSettings(processing: ProcessingRecipe | undefined): RestorationSettings | undefined {
  const controls = processing?.restoration;
  if (controls === undefined) return undefined;
  if (!controls.dust && !controls.scratches && controls.denoise === 0 && controls.sharpen === 0) {
    return undefined;
  }
  return {
    dust: controls.dust ? {
      detection: { threshold: 3.5, minDifference: 0.01 },
      removal: { repairRadius: 2 },
    } : false,
    scratches: controls.scratches ? {
      detection: { threshold: 2.7, minDifference: 0.018, minLength: 12 },
    } : false,
    denoise: controls.denoise > 0
      ? { radius: 2, rangeSigma: 0.012 + controls.denoise * 0.07, iterations: 1 }
      : false,
    sharpen: controls.sharpen > 0
      ? { radius: 1, amount: controls.sharpen, threshold: 0.004 }
      : false,
  };
}

function getFilmMode(
  mode: "generic" | "preset" | "calibrated",
  calibrationProfile: CalibrationProfileDocument | undefined,
  channelGains?: readonly [number, number, number],
): FilmMode {
  const trim = channelGains === undefined
    ? [1, 1, 1] as const
    : channelGains;
  if (mode === "generic") {
    return {
      kind: "generic",
      densityGain: [1, 1, 1],
      whiteBalance: multiplyWhiteBalance([1.04, 1, 0.96], trim),
    };
  }
  if (mode === "preset") {
    return {
      kind: "preset",
      preset: { id: "c41-default", version: "1.0", curves: C41_CURVES, matrix: C41_MATRIX },
      // The neutral curve cannot correct a sensor whose blue channel
      // responds weaker than green (typical for Sony Bayer sensors), which
      // would otherwise bias the inversion towards blue. Same conservative
      // default as the generic mode; a colour-card calibration remains the
      // exact per-camera/per-film answer.
      whiteBalance: multiplyWhiteBalance([1.04, 1, 0.96], trim),
    };
  }
  if (calibrationProfile === undefined) {
    throw new ImageWorkerError("CALIBRATION_REQUIRED", "校准配置模式需要先导入并选择色卡标定配置。");
  }
  return {
    kind: "calibrated",
    profile: toRuntimeCalibrationProfile(calibrationProfile),
    whiteBalance: multiplyWhiteBalance([1, 1, 1], trim),
  };
}

/** Multiplies the mode's default white balance by the user's channel trims. */
function multiplyWhiteBalance(
  base: readonly [number, number, number],
  trim: readonly [number, number, number],
): [number, number, number] {
  return [base[0] * trim[0], base[1] * trim[1], base[2] * trim[2]];
}

async function decodeTiffSource(
  sourcePath: string,
  previewMaxEdge?: number,
): Promise<DecodedAsset> {
  let image: ReturnType<typeof sharp>;
  try {
    image = sharp(sourcePath, {
      failOn: "error",
      limitInputPixels: maximumInputPixels,
      sequentialRead: true,
    });
  } catch (error: unknown) {
    throw new ImageWorkerError("TIFF_OPEN_FAILED", errorMessage(error, "无法打开 TIFF 文件。"));
  }
  const metadata = await image.metadata();
  if (metadata.width === undefined || metadata.height === undefined || metadata.width * metadata.height > maximumInputPixels) {
    throw new ImageWorkerError("TIFF_TOO_LARGE", "TIFF 尺寸无效或超过当前 80 MP 的安全限制。");
  }
  if (metadata.depth !== "ushort") {
    throw new ImageWorkerError("TIFF_DEPTH_UNSUPPORTED", "真实处理要求 16-bit TIFF；8-bit 或浮点 TIFF 不能作为线性负片母版输入。");
  }

  const previewImage = previewMaxEdge === undefined
    ? image
    : image.resize({
        width: previewMaxEdge,
        height: previewMaxEdge,
        fit: "inside",
        withoutEnlargement: true,
        kernel: "lanczos3",
      });
  // ICC-tagged TIFF pixels are display encoded. Sharp/libvips converts them
  // directly to float scRGB (linear-light sRGB, with extended range) so the
  // transfer curve is removed before density math without an intermediate
  // 16-bit gamut clip. Treating display-encoded values as linear attenuates
  // log density, and therefore colour separation, by roughly the source TRC.
  const decoded = metadata.hasProfile
    ? await previewImage
      .removeAlpha()
      .toColourspace("scrgb")
      .raw({ depth: "float" })
      .toBuffer({ resolveWithObject: true })
    : await previewImage
      .removeAlpha()
      .toColourspace("rgb16")
      .raw({ depth: "ushort" })
      .toBuffer({ resolveWithObject: true });
  if (decoded.info.channels !== 3 || decoded.info.width === undefined || decoded.info.height === undefined) {
    throw new ImageWorkerError("TIFF_CHANNELS_UNSUPPORTED", "TIFF 必须能转换为三个 RGB 通道。");
  }
  const source = metadata.hasProfile
    ? scrgbFloatBufferToRaster(decoded.data, decoded.info.width, decoded.info.height)
    : ushortBufferToRaster(decoded.data, decoded.info.width, decoded.info.height, "transmission-linear-rgb");
  return {
    source,
    // Float scRGB is quantised only when populating the RGB16LE preview cache;
    // full-resolution processing keeps the float decode. Untagged TIFF input
    // is already RGB16LE and can use the zero-copy cache path.
    encodedCachePixels: metadata.hasProfile ? undefined : decoded.data,
    summary: {
      width: source.width,
      height: source.height,
      bitDepth: 16,
      sourceDomain: "transmission-linear-rgb",
      decoder: "sharp-raster",
      warnings: [
        metadata.hasProfile
          ? "已按嵌入式 ICC 转换到 sRGB 原色并还原为线性光透射率。"
          : "TIFF 未嵌入 ICC；按已线性化、已完成光学校正的透射率数据读取。",
        "片基默认采样左侧 8%；请在后续的 ROI 工具中确认未曝光片基位置。",
      ],
    },
  };
}

async function decodeRawSource(
  sourcePath: string,
  previewMaxEdge?: number,
  cachedExecutable?: string,
  persistentCachePath?: string,
  preferGpuBayer = false,
): Promise<DecodedAsset> {
  const executable = cachedExecutable ?? await findRawSidecar();
  if (executable === undefined) {
    throw new ImageWorkerError(
      "RAW_SIDECAR_UNAVAILABLE",
      "RAW 解码器未安装。请构建或安装与当前平台匹配的 FilmLab LibRaw sidecar；软件不会退回到内嵌 JPEG。",
    );
  }
  const temporaryDirectory = persistentCachePath === undefined
    ? await mkdtemp(join(tmpdir(), "filmlab-raw-"))
    : undefined;
  const cachePath = persistentCachePath
    ?? join(temporaryDirectory as string, "decoded.rgb16le");
  if (persistentCachePath !== undefined) {
    // Remove only an orphaned, unpublished cache file for this exact
    // fingerprint. A valid entry would already have returned above.
    await rm(cachePath, { force: true });
    // A killed decode (cancel, crash, power loss) leaves `<cachePath>.partial-N`
    // behind. The sidecar's in-process sequence number restarts at 1 on its
    // next launch, so the first leftover would collide with the new
    // `.partial-1` and permanently fail every decode into this cache path.
    // Sweep the whole pattern before starting a new decode.
    await removeStaleRawCacheArtifacts(cachePath);
  }
  try {
    let gpuBayer = preferGpuBayer;
    let response = await runRawSidecar(executable, {
      id: "decode-" + randomUUID(),
      type: "decode",
      sourcePath,
      cachePath,
      options: {
        demosaic: gpuBayer ? "gpu-bayer-v1" : "bilinear-bayer-v1",
        maxEdge: previewMaxEdge,
      },
    });
    if (!response.ok && gpuBayer && response.error.code === "UNSUPPORTED_OPTION") {
      // Packaged sidecars from an earlier release remain usable. Once the new
      // executable is installed its mtime changes the cache fingerprint and
      // the GPU Bayer path activates automatically.
      await rm(cachePath, { force: true });
      gpuBayer = false;
      response = await runRawSidecar(executable, {
        id: "decode-" + randomUUID(),
        type: "decode",
        sourcePath,
        cachePath,
        options: { demosaic: "bilinear-bayer-v1", maxEdge: previewMaxEdge },
      });
    }
    if (!response.ok) {
      throw new ImageWorkerError(response.error.code, response.error.message);
    }
    const result = response.result;
    if (
      result.cacheFormat !== (gpuBayer ? "filmlab-bayer16le-v1" : "filmlab-rgb16le-v1")
      || result.channels !== (gpuBayer ? 1 : 3)
      || result.bitDepth !== 16
      || result.byteOrder !== "little-endian"
      || result.sourceDomain !== (gpuBayer ? "camera-linear-bayer" : "camera-linear-rgb")
      || !Number.isSafeInteger(result.width)
      || !Number.isSafeInteger(result.height)
      || result.width <= 0
      || result.height <= 0
      || result.width * result.height > maximumInputPixels
    ) {
      throw new ImageWorkerError("RAW_SIDECAR_PROTOCOL", "RAW 解码器返回了不支持的线性缓存描述。");
    }
    if (result.cachePath !== cachePath) {
      throw new ImageWorkerError("RAW_SIDECAR_PROTOCOL", "RAW 解码器返回了未请求的缓存路径。");
    }
    const bytes = await readFile(result.cachePath);
    const expectedLength = result.width * result.height * (gpuBayer ? 1 : 3) * 2;
    if (bytes.byteLength !== expectedLength) {
      throw new ImageWorkerError("RAW_CACHE_INVALID", "RAW 解码缓存长度与返回尺寸不一致。");
    }
    if (gpuBayer) {
      const pattern = parseBayerPattern(result.bayerPattern);
      const data = ushortBufferToArray(bytes, result.width * result.height);
      const gpuSource: GpuBayerSource = {
        width: result.width,
        height: result.height,
        data,
        pattern,
      };
      return {
        source: demosaicBayerProxy(gpuSource, gpuInteractiveAnalysisEdge),
        gpuBayer: gpuSource,
        persistedCachePixels: persistentCachePath !== undefined,
        summary: {
          width: gpuSource.width,
          height: gpuSource.height,
          bitDepth: 16,
          sourceDomain: "camera-linear-bayer",
          decoder: "libraw-sidecar",
          decoderFingerprint: result.decoderFingerprint,
          camera: result.camera,
          photonTransfer: result.photonTransfer,
          warnings: [
            "RAW 已解包为线性 Bayer；预览去马赛克由 GPU 执行，未应用自动白平衡、相机色彩矩阵或 JPEG 风格化。",
            "片基默认采样左侧 8%；请确认未曝光片基位置。",
            ...photonTransferWarnings(result.photonTransfer),
          ],
        },
      };
    }
    const source = ushortBufferToRaster(bytes, result.width, result.height, "camera-linear-rgb");
    return {
      source,
      persistedCachePixels: persistentCachePath !== undefined,
      summary: {
        width: source.width,
        height: source.height,
        bitDepth: 16,
        sourceDomain: "camera-linear-rgb",
        decoder: "libraw-sidecar",
        decoderFingerprint: result.decoderFingerprint,
        camera: result.camera,
        photonTransfer: result.photonTransfer,
        warnings: [
          "RAW 已使用固定的线性 LibRaw sidecar 解码；未应用自动白平衡、相机色彩矩阵、降噪或 JPEG 风格化。",
          "片基默认采样左侧 8%；请在后续的 ROI 工具中确认未曝光片基位置。",
          ...photonTransferWarnings(result.photonTransfer),
        ],
      },
    };
  } finally {
    if (temporaryDirectory !== undefined) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

function ushortBufferToRaster(
  buffer: Uint8Array,
  width: number,
  height: number,
  domain: "camera-linear-rgb" | "transmission-linear-rgb",
): Raster {
  const expectedLength = width * height * 3 * 2;
  if (buffer.byteLength !== expectedLength) {
    throw new ImageWorkerError("PIXEL_BUFFER_INVALID", "16-bit RGB 像素缓冲区长度无效。");
  }
  const values = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pixels = new Float32Array(width * height * 3);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = values.getUint16(index * 2, true) / 65_535;
  }
  return new Raster(width, height, domain, pixels);
}

function ushortBufferToArray(buffer: Uint8Array, length: number): Uint16Array {
  if (buffer.byteLength !== length * 2) {
    throw new ImageWorkerError("PIXEL_BUFFER_INVALID", "16-bit Bayer 缓冲区长度无效。");
  }
  const values = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const output = new Uint16Array(length);
  for (let index = 0; index < length; index += 1) {
    output[index] = values.getUint16(index * 2, true);
  }
  return output;
}

function decodedAssetFromBayer(cached: CachedBayerPreview): DecodedAsset {
  const gpuBayer: GpuBayerSource = {
    width: cached.width,
    height: cached.height,
    data: cached.data,
    pattern: cached.pattern,
  };
  return {
    source: demosaicBayerProxy(gpuBayer, gpuInteractiveAnalysisEdge),
    gpuBayer,
    summary: cached.summary,
  };
}

function demosaicBayerProxy(source: GpuBayerSource, maximumEdge: number): Raster {
  const scale = Math.min(1, maximumEdge / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const output = new Raster(width, height, "camera-linear-rgb");
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(
      source.height - 1,
      Math.max(0, Math.round((y + 0.5) * source.height / height - 0.5)),
    );
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(
        source.width - 1,
        Math.max(0, Math.round((x + 0.5) * source.width / width - 0.5)),
      );
      const offset = (y * width + x) * 3;
      output.data[offset] = sampleBayerChannel(source, sourceX, sourceY, 0);
      output.data[offset + 1] = sampleBayerChannel(source, sourceX, sourceY, 1);
      output.data[offset + 2] = sampleBayerChannel(source, sourceX, sourceY, 2);
    }
  }
  return output;
}

function sampleBayerChannel(
  source: GpuBayerSource,
  x: number,
  y: number,
  targetChannel: 0 | 1 | 2,
): number {
  const centerChannel = source.pattern[(y & 1) * 2 + (x & 1)];
  if (centerChannel === targetChannel) {
    return source.data[y * source.width + x] / 65_535;
  }
  let weighted = 0;
  let weights = 0;
  for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
    for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
      if (deltaX === 0 && deltaY === 0) continue;
      const sampleX = mirrorBayerIndex(x + deltaX, source.width);
      const sampleY = mirrorBayerIndex(y + deltaY, source.height);
      const channel = source.pattern[(sampleY & 1) * 2 + (sampleX & 1)];
      if (channel !== targetChannel) continue;
      const weight = 1 / (deltaX * deltaX + deltaY * deltaY);
      weighted += source.data[sampleY * source.width + sampleX] / 65_535 * weight;
      weights += weight;
    }
  }
  return weights > 0
    ? weighted / weights
    : source.data[y * source.width + x] / 65_535;
}

function mirrorBayerIndex(value: number, size: number): number {
  if (size <= 1) return 0;
  let result = value;
  while (result < 0 || result >= size) {
    result = result < 0 ? -result : 2 * size - 2 - result;
  }
  return result;
}

function parseBayerPattern(
  value: unknown,
): readonly [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2] {
  if (
    !Array.isArray(value)
    || value.length !== 4
    || !value.every((channel) => channel === 0 || channel === 1 || channel === 2)
    || value.filter((channel) => channel === 0).length !== 1
    || value.filter((channel) => channel === 1).length !== 2
    || value.filter((channel) => channel === 2).length !== 1
  ) {
    throw new ImageWorkerError("RAW_SIDECAR_PROTOCOL", "RAW 解码器返回了无效的 Bayer CFA 排列。");
  }
  return value as unknown as readonly [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2];
}

function resizeForPreview(source: Raster, maximumEdge: number): Raster {
  const scale = Math.min(1, maximumEdge / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  if (width === source.width && height === source.height) {
    return source;
  }
  const output = new Raster(width, height, source.domain);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor((y + 0.5) * source.height / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor((x + 0.5) * source.width / width));
      const from = (sourceY * source.width + sourceX) * 3;
      const to = (y * width + x) * 3;
      output.data[to] = source.data[from];
      output.data[to + 1] = source.data[from + 1];
      output.data[to + 2] = source.data[from + 2];
    }
  }
  return output;
}

function getPreviewRaster(cached: CachedAsset, maximumEdge: number): Raster {
  const existing = cached.previewRasters.get(maximumEdge);
  if (existing !== undefined) return existing;
  const resized = resizeForPreview(cached.source, maximumEdge);
  if (resized !== cached.source) {
    // Interactive rendering uses a single preview size today. Keep this map
    // bounded in case future UI surfaces request a second size.
    if (cached.previewRasters.size >= 2) {
      const oldest = cached.previewRasters.keys().next().value as number | undefined;
      if (oldest !== undefined) cached.previewRasters.delete(oldest);
    }
    cached.previewRasters.set(maximumEdge, resized);
  }
  return resized;
}

function createGpuSourceKey(
  assetId: string,
  generation: number,
  width: number,
  height: number,
  kind: "rgb" | "bayer",
): string {
  return assetId + ":" + generation + ":" + kind + ":" + width + "x" + height;
}

function createPreviewStageKey(
  assetId: string,
  generation: number,
  request: {
    readonly maxEdge: number;
    readonly mode: "generic" | "preset" | "calibrated";
    readonly processing?: ProcessingRecipe;
    readonly dmaxOverride?: number;
    readonly dmaxSampleRoi?: import("../shared/contracts.ts").NormalizedRoi;
  },
  calibrationProfile: CalibrationProfileDocument | undefined,
): string {
  return JSON.stringify([
    assetId,
    generation,
    request.maxEdge,
    request.mode,
    request.processing ?? null,
    request.dmaxOverride ?? null,
    request.dmaxSampleRoi ?? null,
    calibrationProfile === undefined
      ? null
      : [calibrationProfile.id, calibrationProfile.version, calibrationProfile.calibrationId, calibrationProfile.captureFingerprint],
  ]);
}

function densityVisualization(density: Raster): Raster {
  const output = new Raster(density.width, density.height, "display-linear-rgb");
  for (let offset = 0; offset < density.data.length; offset += 3) {
    const value = Math.max(0, Math.min(1, (density.data[offset] + density.data[offset + 1] + density.data[offset + 2]) / 1.7));
    output.data[offset] = value;
    output.data[offset + 1] = value;
    output.data[offset + 2] = value;
  }
  return output;
}

function buildWarnings(
  mode: "generic" | "preset" | "calibrated",
  colorTrust: ColorTrust,
): readonly string[] {
  const modeWarning = mode === "generic"
    ? "通用模式输出仅采用 sRGB 显示编码，不包含设备相机色彩表征，不声明颜色准确性。"
    : mode === "preset"
      ? "默认 C-41 预设包含通用胶片矩阵，但不包含设备相机色彩表征；sRGB ICC 仅描述显示编码。"
      : colorTrust.level === "device-matched"
        ? "校准配置的相机型号与 RAW 解码链均已匹配，可作为设备匹配色彩输出。"
        : colorTrustReasonWarning(colorTrust);
  return [modeWarning];
}

function colorTrustReasonWarning(colorTrust: ColorTrust): string {
  switch (colorTrust.reason) {
    case "source-camera-unavailable":
      return "已应用校准配置，但源文件没有可验证的相机型号；输出不声明设备匹配。";
    case "profile-camera-unavailable":
      return "校准配置没有可验证的相机型号；输出不声明设备匹配。";
    case "camera-mismatch":
      return "源文件相机型号与校准配置不一致；输出不应视为设备匹配的颜色还原。";
    case "decoder-unavailable":
      return "源文件没有可验证的 RAW 解码器指纹；输出不声明设备匹配。";
    case "decoder-mismatch":
      return "RAW 解码器或去马赛克链与校准配置不一致；输出不应视为设备匹配的颜色还原。";
    default:
      return "校准配置的设备匹配状态无法验证；输出不声明颜色准确性。";
  }
}

function buildBaseSampleWarnings(base: {
  readonly sampleCount: number;
  readonly rejectedCount: number;
  readonly method: "roi" | "reference" | "automatic";
  readonly confidence: number;
}): readonly string[] {
  if (base.method === "automatic") {
    return [
      "片基来自无边框画面的统计估算，无法等同于实测 Dmin；请优先改用同卷未曝光片基参考。",
      ...(base.confidence < 0.45 ? ["自动片基估算置信度偏低，导出前必须人工复核颜色与密度范围。"] : []),
    ];
  }
  if (base.method === "reference") return [];
  const total = base.sampleCount + base.rejectedCount;
  if (total === 0 || base.rejectedCount / total < 0.25) return [];
  return ["片基采样区不够均匀，超过 25% 的像素被判为异常；请重新选择纯净、未曝光的片基区域。"];
}

function getCachedAsset(assetId: string): CachedAsset {
  const cached = assets.get(assetId);
  if (cached === undefined) {
    throw new ImageWorkerError("SOURCE_NOT_LOADED", "源文件尚未由图像处理进程解码。请重新导入后再试。");
  }
  return cached;
}

/**
 * Deletes every `<cachePath>.partial-N` artifact in the same directory.
 * The sidecar writes these while decoding and renames the final file on
 * success; leftovers only appear after an interrupted decode.
 */
async function removeStaleRawCacheArtifacts(cachePath: string): Promise<void> {
  const directory = dirname(cachePath);
  const stem = basename(cachePath) + ".partial-";
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    // The cache directory does not exist yet; nothing to sweep.
    return;
  }
  await Promise.allSettled(
    entries
      .filter((name) => name.startsWith(stem))
      .map((name) => rm(join(directory, name), { force: true })),
  );
}

async function findRawSidecar(): Promise<string | undefined> {  const executableName = process.platform === "win32" ? "filmlab-raw-worker.exe" : "filmlab-raw-worker";
  const resourceRoot = process.resourcesPath;
  const platformArch = process.platform + "-" + process.arch;
  const candidates = [
    process.env.FILMLAB_RAW_SIDECAR,
    resourceRoot === undefined ? undefined : join(resourceRoot, "raw-worker", platformArch, executableName),
    join(process.cwd(), "native", "raw-worker", "out", platformArch, executableName),
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.length === 0) {
      continue;
    }
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next deliberate location. No PATH lookup is used.
    }
  }
  return undefined;
}

async function runRawSidecar(executable: string, request: RawSidecarRequest): Promise<RawSidecarResponse> {
  if (rawSidecarSession === undefined || !rawSidecarSession.matches(executable)) {
    rawSidecarSession?.close();
    rawSidecarSession = new RawSidecarSession(executable);
  }
  return rawSidecarSession.send(request);
}

class RawSidecarSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, {
    readonly resolve: (response: RawSidecarResponse) => void;
    readonly reject: (error: Error) => void;
  }>();
  private stdout = "";
  private stderr = "";
  private closed = false;

  public constructor(private readonly executable: string) {
    this.child = spawn(executable, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8_192);
    });
    this.child.once("error", (error) => this.fail(
      new ImageWorkerError(
        "RAW_SIDECAR_START_FAILED",
        errorMessage(error, "RAW 解码器无法启动。"),
      ),
    ));
    this.child.once("exit", (code) => this.fail(new ImageWorkerError(
      "RAW_SIDECAR_EXITED",
      "RAW 解码器意外退出"
        + (code === null ? "。" : "（代码 " + code + "）。")
        + (this.stderr.length > 0 ? " " + this.stderr.trim() : ""),
    )));
    process.once("exit", () => this.close());
  }

  public matches(executable: string): boolean {
    return !this.closed && executable === this.executable;
  }

  public send(request: RawSidecarRequest): Promise<RawSidecarResponse> {
    if (this.closed) {
      return Promise.reject(new ImageWorkerError("RAW_SIDECAR_EXITED", "RAW 解码器会话已关闭。"));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      this.child.stdin.write(JSON.stringify(request) + "\n", "utf8", (error) => {
        if (error === null || error === undefined) return;
        const pending = this.pending.get(request.id);
        if (pending === undefined) return;
        this.pending.delete(request.id);
        pending.reject(new ImageWorkerError(
          "RAW_SIDECAR_WRITE_FAILED",
          errorMessage(error, "无法向 RAW 解码器发送请求。"),
        ));
      });
    });
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.kill();
    this.rejectPending(new ImageWorkerError("RAW_SIDECAR_EXITED", "RAW 解码器会话已关闭。"));
  }

  private handleStdout(chunk: string): void {
    this.stdout += chunk;
    const lines = this.stdout.split(/\r?\n/);
    this.stdout = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isRawSidecarProgress(parsed)) continue;
        const response = parseRawSidecarResponse(parsed);
        const pending = this.pending.get(response.id);
        if (pending === undefined) continue;
        this.pending.delete(response.id);
        pending.resolve(response);
      } catch (error: unknown) {
        this.fail(new ImageWorkerError(
          "RAW_SIDECAR_PROTOCOL",
          errorMessage(error, "RAW 解码器返回了无效 JSON。"),
        ));
        return;
      }
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(error);
    this.child.kill();
    if (rawSidecarSession === this) rawSidecarSession = undefined;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function parseRawSidecarResponse(value: unknown): RawSidecarResponse {
  if (typeof value !== "object" || value === null) {
    throw new Error("RAW response is not an object.");
  }
  const response = value as Record<string, unknown>;
  if (typeof response.id !== "string" || typeof response.ok !== "boolean") {
    throw new Error("RAW response misses id or ok.");
  }
  if (!response.ok) {
    const error = response.error as Record<string, unknown> | undefined;
    if (error === undefined || typeof error.code !== "string" || typeof error.message !== "string") {
      throw new Error("RAW error response is malformed.");
    }
    return { id: response.id, ok: false, error: { code: error.code, message: error.message } };
  }
  const result = response.result as Record<string, unknown> | undefined;
  if (result === undefined) {
    throw new Error("RAW success response misses result.");
  }
  const camera = parseRawCamera(result.metadata);
  return {
    id: response.id,
    ok: true,
    result: {
      cachePath: requireString(result.cachePath, "cachePath"),
      cacheFormat: requireString(result.cacheFormat, "cacheFormat"),
      width: requireNumber(result.width, "width"),
      height: requireNumber(result.height, "height"),
      channels: requireNumber(result.channels, "channels"),
      bitDepth: requireNumber(result.bitDepth, "bitDepth"),
      byteOrder: requireString(result.byteOrder, "byteOrder"),
      sourceDomain: requireString(result.sourceDomain, "sourceDomain"),
      decoderFingerprint: requireString(result.decoderFingerprint, "decoderFingerprint"),
      bayerPattern: result.bayerPattern,
      camera,
      photonTransfer: parseRawPhotonTransfer(result.metadata, camera),
    },
  };
}

function isRawSidecarProgress(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && record.event === "progress"
    && typeof record.stage === "string"
    && typeof record.fraction === "number";
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.requestId === "string"
    && typeof record.kind === "string"
    && typeof record.assetId === "string";
}

function assertPreviewRequest(value: {
  readonly revision: number;
  readonly maxEdge: number;
  readonly tone: { readonly exposureStops: number; readonly contrast: number; readonly highlightCompression: number; readonly saturation: number };
  readonly dmaxOverride?: number;
  readonly dmaxSampleRoi?: import("../shared/contracts.ts").NormalizedRoi;
  readonly gpuInteractive?: boolean;
  readonly gpuReuseSourceKey?: string;
  readonly gpuSourceOnly?: boolean;
  readonly gpuBaseRgb?: readonly [number, number, number];
}): void {
  const maximumEdge = value.gpuSourceOnly ? 32_768 : 2_048;
  if (!Number.isInteger(value.revision) || !Number.isInteger(value.maxEdge) || value.maxEdge < 256 || value.maxEdge > maximumEdge) {
    throw new ImageWorkerError("INVALID_PREVIEW", "预览尺寸或修订号无效。");
  }
  if (!Object.values(value.tone).every((item) => Number.isFinite(item))) {
    throw new ImageWorkerError("INVALID_PREVIEW", "预览色调参数无效。");
  }
  if (value.dmaxOverride !== undefined && (
    !Number.isFinite(value.dmaxOverride) || value.dmaxOverride < 0 || value.dmaxOverride > 16
  )) {
    throw new ImageWorkerError("INVALID_PREVIEW", "Manual Dmax is invalid.");
  }
  if (value.dmaxSampleRoi !== undefined) {
    const roi = value.dmaxSampleRoi;
    if (
      ![roi.x, roi.y, roi.width, roi.height].every((item) => Number.isFinite(item))
      || roi.x < 0 || roi.y < 0 || roi.width <= 0 || roi.height <= 0
      || roi.x + roi.width > 1 || roi.y + roi.height > 1
    ) {
      throw new ImageWorkerError("INVALID_PREVIEW", "Manual Dmax sample ROI is invalid.");
    }
  }
  if (value.gpuInteractive !== undefined && typeof value.gpuInteractive !== "boolean") {
    throw new ImageWorkerError("INVALID_PREVIEW", "GPU 交互预览标记无效。");
  }
  if (
    value.gpuReuseSourceKey !== undefined
    && (
      typeof value.gpuReuseSourceKey !== "string"
      || value.gpuReuseSourceKey.length === 0
      || value.gpuReuseSourceKey.length > 512
    )
  ) {
    throw new ImageWorkerError("INVALID_PREVIEW", "GPU 源纹理复用标记无效。");
  }
  if (
    value.gpuSourceOnly
    && (
      value.gpuBaseRgb === undefined
      || value.gpuBaseRgb.length !== 3
      || !value.gpuBaseRgb.every((item) => Number.isFinite(item) && item > 0)
    )
  ) {
    throw new ImageWorkerError("INVALID_PREVIEW", "GPU 母版片基参数无效。");
  }
}

function assertIdentifier(value: string, label: string): void {
  if (value.length === 0 || value.length > 255 || /[\u0000-\u001F]/.test(value)) {
    throw new ImageWorkerError("INVALID_IDENTIFIER", label + "无效。");
  }
}

function postSuccess(
  requestId: string,
  response: WorkerSuccessResponse,
): void {
  const memory = process.memoryUsage();
  observedPeakRssBytes = Math.max(observedPeakRssBytes, memory.rss);
  parentPort?.postMessage({
    requestId,
    ok: true,
    response,
    telemetry: {
      observedPeakRssBytes,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
    },
  });
}

function postFailure(requestId: string, error: unknown): void {
  const workerError = error instanceof ImageWorkerError
    ? error
    : new ImageWorkerError("PROCESSING_FAILED", errorMessage(error, "图像处理失败。"));
  parentPort?.postMessage({
    requestId,
    ok: false,
    error: { code: workerError.code, message: workerError.message },
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function requireString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("RAW result " + key + " is invalid.");
  return value;
}

function requireNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("RAW result " + key + " is invalid.");
  return value;
}

class ImageWorkerError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ImageWorkerError";
    this.code = code;
  }
}

interface RawSidecarRequest {
  readonly id: string;
  readonly type: "decode";
  readonly sourcePath: string;
  readonly cachePath: string;
  readonly options: {
    readonly demosaic: "bilinear-bayer-v1" | "gpu-bayer-v1";
    readonly maxEdge?: number;
  };
}

interface DecodedAsset {
  readonly source: Raster;
  readonly gpuBayer?: GpuBayerSource;
  readonly summary: Omit<DecodedSourceSummary, "assetId">;
  /** Existing RGB16LE bytes can be written without a Float32 round-trip. */
  readonly encodedCachePixels?: Uint8Array;
  /** RAW sidecar already wrote directly to the final cache pixel path. */
  readonly persistedCachePixels?: boolean;
}

type WorkerSuccessResponse =
  | { readonly kind: "load"; readonly result: DecodedSourceSummary }
  | { readonly kind: "render"; readonly result: PreviewResult }
  | {
      readonly kind: "calibrate-card";
      readonly result: {
        readonly matrix: Matrix3;
        readonly detectedPatchCount: number;
        readonly usedPatchCount: number;
        readonly rejectedPatchIds: readonly string[];
        readonly edgeScore: number;
        readonly decoderFingerprint?: string;
        readonly decoder: "sharp-raster" | "libraw-sidecar";
        readonly camera?: SourceCameraIdentity;
      };
    }
  | { readonly kind: "export-tiff"; readonly result: TiffExportSummary }
  | { readonly kind: "release" };

type RawSidecarResponse =
  | {
      readonly id: string;
      readonly ok: true;
      readonly result: {
        readonly cachePath: string;
        readonly cacheFormat: string;
        readonly width: number;
        readonly height: number;
        readonly channels: number;
        readonly bitDepth: number;
        readonly byteOrder: string;
        readonly sourceDomain: string;
        readonly decoderFingerprint: string;
        readonly bayerPattern?: unknown;
        readonly camera?: SourceCameraIdentity;
        readonly photonTransfer?: PhotonTransferModel;
      };
    }
  | { readonly id: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

function parseRawCamera(metadata: unknown): SourceCameraIdentity | undefined {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined;
  const camera = (metadata as Record<string, unknown>).camera;
  if (typeof camera !== "object" || camera === null || Array.isArray(camera)) return undefined;
  const record = camera as Record<string, unknown>;
  const make = parseBoundedCameraField(record.make);
  const model = parseBoundedCameraField(record.model);
  return make === undefined && model === undefined ? undefined : { make, model };
}

function parseRawPhotonTransfer(
  metadata: unknown,
  camera: SourceCameraIdentity | undefined,
): PhotonTransferModel | undefined {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, unknown>;
  const capture = record.capture;
  const sensor = record.sensor;
  if (
    typeof capture !== "object" || capture === null || Array.isArray(capture)
    || typeof sensor !== "object" || sensor === null || Array.isArray(sensor)
  ) return undefined;
  const iso = (capture as Record<string, unknown>).iso;
  const ranges = (sensor as Record<string, unknown>).normalizationRangeDnRgb;
  if (
    typeof iso !== "number" || !Number.isFinite(iso) || iso <= 0
    || !Array.isArray(ranges) || ranges.length !== 3
    || !ranges.every((item) => typeof item === "number" && Number.isFinite(item) && item > 0)
  ) return undefined;
  const cameraModel = [camera?.make, camera?.model].filter((item) => item !== undefined).join(" ");
  return matchPhotonTransferModel({
    cameraModel,
    iso,
    normalizationRangeDn: ranges as unknown as readonly [number, number, number],
  });
}

function photonTransferWarnings(model: PhotonTransferModel | undefined): readonly string[] {
  return model === undefined
    ? []
    : [
        "已匹配 Sony A7R V ISO 100 Photon Transfer Curve；低信噪比密度已做一西格玛正则化。此优化抑制阴影伪色，但不替代相机色彩矩阵或色卡校准。",
      ];
}

function parseBoundedCameraField(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > 128 || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new Error("RAW response contains invalid camera metadata.");
  }
  const cleaned = value.trim();
  return cleaned.length === 0 ? undefined : cleaned;
}
