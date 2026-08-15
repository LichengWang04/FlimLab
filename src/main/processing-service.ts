import { randomUUID } from "node:crypto";
import { constants as osConstants, setPriority } from "node:os";

import { utilityProcess, type UtilityProcess } from "electron";

import type { CalibrationProfileDocument } from "../core/calibration.ts";
import type { PreviewRequest, PreviewResult, ProcessingRecipe } from "../shared/contracts.ts";
import {
  isWorkerResponseMessage,
  type DecodedSourceSummary,
  type ColorCardFitSummary,
  type TiffExportSummary,
  type WorkerCommand,
  type WorkerResponseMessage,
  type WorkerSuccessResult,
  type WorkerTelemetry,
} from "../shared/processing-contracts.ts";
import imageWorkerModulePath from "./image-worker?modulePath";

const workerStartTimeoutMs = 15_000;

/**
 * Owns the long-lived Electron utility process.  It keeps decoded, linear
 * rasters in the utility process, so main only forwards small preview pixels
 * and renderer-visible summaries.
 */
export class ProcessingService {
  private readonly serviceName: string;
  private readonly lowPriority: boolean;
  private readonly minimumPreviewDecodeEdge: number;
  private readonly previewCacheDirectory: string | undefined;
  private worker: UtilityProcess | null = null;
  private workerPromise: Promise<UtilityProcess> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly loadedPaths = new Map<string, LoadedPath>();
  private readonly loadTasks = new Map<string, Promise<DecodedSourceSummary>>();
  private renderInFlight = false;
  private queuedRender: QueuedRender | undefined;
  private latestTelemetry: WorkerTelemetry | undefined;

  public constructor(
    serviceName = "FilmLab Image Worker",
    lowPriority = false,
    minimumPreviewDecodeEdge = 0,
    previewCacheDirectory?: string,
  ) {
    this.serviceName = serviceName;
    this.lowPriority = lowPriority;
    this.minimumPreviewDecodeEdge = minimumPreviewDecodeEdge;
    this.previewCacheDirectory = previewCacheDirectory;
  }

  public async render(
    assetId: string,
    sourcePath: string,
    request: PreviewRequest,
    calibrationProfile?: CalibrationProfileDocument,
  ): Promise<PreviewResult> {
    // A master request omits the sidecar decode ceiling entirely. Passing the
    // UI's sentinel 32,768 edge would exceed the preview-only protocol limit
    // and, more importantly, would not explicitly mean "full sensor".
    const decodeEdge = request.gpuSourceOnly
      ? undefined
      : Math.max(request.maxEdge, this.minimumPreviewDecodeEdge);
    await this.ensureLoaded(
      assetId,
      sourcePath,
      decodeEdge,
      request.gpuInteractive === true || request.gpuSourceOnly === true,
    );
    const response = await this.enqueueRender({
      kind: "render",
      assetId,
      request: {
        revision: request.revision,
        maxEdge: request.maxEdge,
        mode: request.mode,
        view: request.view,
        tone: request.tone,
        processing: request.processing,
        dmaxOverride: request.dmaxOverride,
        dmaxChannelRange: request.dmaxChannelRange,
        dmaxSampleRoi: request.dmaxSampleRoi,
        gpuInteractive: request.gpuInteractive,
        gpuReuseSourceKey: request.gpuReuseSourceKey,
        gpuSourceOnly: request.gpuSourceOnly,
        gpuBaseRgb: request.gpuBaseRgb,
      },
      calibrationProfile,
    });
    if (response.kind !== "render") {
      throw new Error("图像处理进程返回了意外的预览响应。");
    }
    return response.result;
  }

  /** Decode through the exact utility-process/native path without rendering. */
  public inspectSource(
    assetId: string,
    sourcePath: string,
    previewMaxEdge?: number,
    preferGpuBayer = false,
  ): Promise<DecodedSourceSummary> {
    return this.ensureLoaded(assetId, sourcePath, previewMaxEdge, preferGpuBayer);
  }

  public telemetry(): WorkerTelemetry | undefined {
    return this.latestTelemetry;
  }

  /** Release a decoded raster after batch work so long runs remain bounded. */
  public async release(assetId: string): Promise<void> {
    this.loadedPaths.delete(assetId);
    for (const key of this.loadTasks.keys()) {
      if (key.startsWith(assetId + "\u0000")) this.loadTasks.delete(key);
    }
    if (this.worker === null) return;
    const response = await this.send({ kind: "release", assetId });
    if (response.kind !== "release") throw new Error("图像处理进程返回了意外的释放响应。");
  }

  public async simulateCrashForAcceptance(): Promise<void> {
    if (process.env.FILMLAB_A7RV_ACCEPTANCE_SPEC === undefined) {
      throw new Error("Utility crash injection is available only to the A7R V acceptance runner.");
    }
    let rejected = false;
    try {
      await this.send({ kind: "crash-for-acceptance", assetId: "acceptance-crash" });
    } catch {
      rejected = true;
      // The expected utility-process exit rejects every in-flight request and
      // clears loadedPaths; the next command must fork a clean worker.
    }
    if (!rejected) throw new Error("Acceptance worker did not crash when requested.");
  }

  public async exportTiff(
    assetId: string,
    sourcePath: string,
    request: {
      readonly outputPath: string;
      readonly suggestedFileName: string;
      readonly format?: import("../shared/contracts.ts").MasterExportFormat;
      readonly mode: PreviewRequest["mode"];
      readonly tone: PreviewRequest["tone"];
      readonly calibrationProfile?: CalibrationProfileDocument;
      readonly processing?: ProcessingRecipe;
      readonly dmaxOverride?: number;
      readonly dmaxChannelRange?: import("../core/types.ts").Rgb;
    },
  ): Promise<TiffExportSummary> {
    await this.ensureLoaded(assetId, sourcePath);
    const response = await this.send({
      kind: "export-tiff",
      assetId,
      outputPath: request.outputPath,
      suggestedFileName: request.suggestedFileName,
      format: request.format,
      mode: request.mode,
      tone: request.tone,
      processing: request.processing,
      dmaxOverride: request.dmaxOverride,
      dmaxChannelRange: request.dmaxChannelRange,
      calibrationProfile: request.calibrationProfile,
    });
    if (response.kind !== "export-tiff") {
      throw new Error("图像处理进程返回了意外的 TIFF 导出响应。");
    }
    return response.result;
  }

  public async fitColorCard(
    assetId: string,
    sourcePath: string,
    processing?: ProcessingRecipe,
  ): Promise<ColorCardFitSummary> {
    await this.ensureLoaded(assetId, sourcePath);
    const response = await this.send({ kind: "calibrate-card", assetId, processing });
    if (response.kind !== "calibrate-card") {
      throw new Error("图像处理进程返回了意外的色卡标定响应。");
    }
    return response.result;
  }

  public shutdown(): void {
    this.queuedRender?.reject(new Error("预览请求已取消。"));
    this.queuedRender = undefined;
    this.worker?.kill();
    this.worker = null;
    this.workerPromise = null;
    this.loadedPaths.clear();
    this.loadTasks.clear();
    this.rejectPending(new Error("图像处理进程已停止。"));
  }

  private async ensureLoaded(
    assetId: string,
    sourcePath: string,
    previewMaxEdge?: number,
    preferGpuBayer = false,
  ): Promise<DecodedSourceSummary> {
    const loaded = this.loadedPaths.get(assetId);
    if (
      loaded?.sourcePath === sourcePath
      && (loaded.previewMaxEdge === undefined || (previewMaxEdge !== undefined && loaded.previewMaxEdge >= previewMaxEdge))
      && (
        preferGpuBayer
          ? (loaded.gpuBayer || loaded.gpuBayerAttempted)
          : !loaded.gpuBayer
      )
    ) {
      // No new decode is needed, but callers (GPU master export, XMP
      // metadata, colour-trust evaluation) still expect the real source
      // summary. A synthetic placeholder would silently misreport the
      // decoder/domain/fingerprint and could wrongly reject DNG exports.
      return { ...loaded.summary };
    }

    // A load request must never be deduplicated across different decode
    // parameters: reusing a 1280-edge in-flight decode for a full-resolution
    // master export would silently downgrade the exported pixels. Key the
    // in-flight task by asset + decode ceiling + Bayer preference.
    const taskKey = loadTaskKey(assetId, previewMaxEdge, preferGpuBayer);
    const existingTask = this.loadTasks.get(taskKey);
    if (existingTask !== undefined) {
      return existingTask;
    }

    const task = this.send({
      kind: "load",
      assetId,
      sourcePath,
      previewMaxEdge,
      preferGpuBayer,
      previewCacheDirectory: previewMaxEdge === undefined
        ? undefined
        : this.previewCacheDirectory,
    })
      .then((response) => {
        if (response.kind !== "load") {
          throw new Error("图像处理进程返回了意外的解码响应。");
        }
        this.loadedPaths.set(assetId, {
          sourcePath,
          previewMaxEdge,
          gpuBayer: response.result.sourceDomain === "camera-linear-bayer",
          gpuBayerAttempted: preferGpuBayer,
          summary: response.result,
        });
        return response.result;
      })
      .finally(() => this.loadTasks.delete(taskKey));
    this.loadTasks.set(taskKey, task);
    return task;
  }

  private async send(message: WorkerCommand): Promise<WorkerSuccessResult> {
    const worker = await this.startWorker();
    const requestId = randomUUID();
    const payload = { ...message, requestId };
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        worker.postMessage(payload);
      } catch (error: unknown) {
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  /**
   * The utility process is intentionally single-threaded. Keep at most one
   * pending render behind the active one so rapid slider input cannot build a
   * seconds-long queue of previews that the renderer will immediately discard.
   */
  private enqueueRender(command: Extract<WorkerCommand, { readonly kind: "render" }>): Promise<WorkerSuccessResult> {
    return new Promise((resolve, reject) => {
      const next = { command, resolve, reject };
      if (!this.renderInFlight) {
        this.dispatchRender(next);
        return;
      }
      this.queuedRender?.reject(new PreviewSupersededError());
      this.queuedRender = next;
    });
  }

  private dispatchRender(task: QueuedRender): void {
    this.renderInFlight = true;
    void this.send(task.command)
      .then(task.resolve, task.reject)
      .finally(() => {
        this.renderInFlight = false;
        const next = this.queuedRender;
        this.queuedRender = undefined;
        if (next !== undefined) this.dispatchRender(next);
      });
  }

  private startWorker(): Promise<UtilityProcess> {
    if (this.workerPromise !== null) {
      return this.workerPromise;
    }

    const worker = utilityProcess.fork(imageWorkerModulePath, [], {
      serviceName: this.serviceName,
      stdio: "pipe",
      // Full-frame 16-bit work can legitimately require more heap than a
      // renderer preview. It remains isolated from UI responsiveness.
      execArgv: ["--max-old-space-size=4096"],
    });
    this.worker = worker;
    worker.on("message", (message: unknown) => {
      // Ignore messages from a stale worker that was superseded by a new
      // fork after a start timeout; its responses must not resolve pending
      // requests that belong to the current worker.
      if (this.worker !== worker) return;
      this.handleMessage(message);
    });
    worker.on("exit", (_code: number) => {
      // A worker that timed out while spawning may still emit exit later.
      // Only the current worker may clear shared state or reject pendings.
      if (this.worker !== worker) return;
      this.handleWorkerExit();
    });

    this.workerPromise = new Promise<UtilityProcess>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // The fork may still spawn afterwards (slow machines, antivirus
        // scans). Kill it so its late spawn/exit cannot disturb a newer
        // worker, and so it does not keep running as an orphan.
        try {
          worker.kill();
        } catch {
          // Best effort; the process may already be gone.
        }
        reject(new Error("图像处理进程启动超时。"));
      }, workerStartTimeoutMs);
      worker.once("spawn", () => {
        if (this.lowPriority && worker.pid !== undefined) {
          try {
            setPriority(worker.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
          } catch {
            // Priority adjustment is best-effort; process isolation still
            // prevents background decoding from blocking renderer events.
          }
        }
        clearTimeout(timeout);
        resolve(worker);
      });
      worker.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("图像处理进程未能启动。"));
      });
    }).catch((error: unknown) => {
      this.worker = null;
      this.workerPromise = null;
      throw error;
    });
    return this.workerPromise;
  }

  private handleMessage(message: unknown): void {
    if (!isWorkerResponseMessage(message)) {
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(message.requestId);
    if (message.ok) {
      this.latestTelemetry = message.telemetry;
      pending.resolve(message.response);
      return;
    }
    pending.reject(createWorkerError(message));
  }

  private handleWorkerExit(): void {
    this.worker = null;
    this.workerPromise = null;
    this.loadedPaths.clear();
    this.loadTasks.clear();
    this.queuedRender?.reject(new Error("图像处理进程已重启，预览请求已取消。"));
    this.queuedRender = undefined;
    this.rejectPending(new Error("图像处理进程意外退出；请重新尝试。"));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

interface LoadedPath {
  readonly sourcePath: string;
  /** Undefined means the full sensor raster is cached. */
  readonly previewMaxEdge?: number;
  readonly gpuBayer: boolean;
  /** Prevents an older sidecar from being probed again on every frame. */
  readonly gpuBayerAttempted: boolean;
  /** The real decode summary returned by the first load of this path. */
  readonly summary: DecodedSourceSummary;
}

interface PendingRequest {
  readonly resolve: (value: WorkerSuccessResult) => void;
  readonly reject: (reason?: unknown) => void;
}

interface QueuedRender extends PendingRequest {
  readonly command: Extract<WorkerCommand, { readonly kind: "render" }>;
}

class PreviewSupersededError extends Error {
  public constructor() {
    super("预览请求已被更新的参数替代。");
    this.name = "PreviewSupersededError";
  }
}

function createWorkerError(response: Extract<WorkerResponseMessage, { readonly ok: false }>): Error {
  const error = new Error(response.error.message);
  error.name = "ImageWorkerError";
  return error;
}

/**
 * Identifies an in-flight decode by every parameter that changes the decoded
 * pixels: the asset, the preview edge ceiling (undefined = full sensor) and
 * whether the Bayer source was requested. Two requests with the same key are
 * guaranteed to produce the same cached raster.
 */
function loadTaskKey(assetId: string, previewMaxEdge?: number, preferGpuBayer = false): string {
  return `${assetId}\u0000${previewMaxEdge ?? "full"}\u0000${preferGpuBayer ? "bayer" : "rgb"}`;
}
