import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { CalibrationProfileDocument } from "../core/calibration.ts";
import type {
  BatchExportItem,
  BatchJobState,
  BatchJobSummary,
  MasterExportFormat,
} from "../shared/contracts.ts";
import type { ProcessingService } from "./processing-service.ts";

const maximumActiveBatchJobs = 2;
const maximumRetainedBatchJobs = 32;

export interface BatchSource {
  readonly item: BatchExportItem;
  readonly sourcePath: string;
  readonly sourceName: string;
  readonly calibrationProfile?: CalibrationProfileDocument;
}

type BatchJobInternalState = BatchJobState | "completed-with-errors";

interface BatchJob {
  readonly id: string;
  readonly format: MasterExportFormat;
  readonly state: BatchJobInternalState;
  readonly total: number;
  readonly completed: number;
  readonly currentAssetId?: string;
  readonly failedAssetIds: readonly string[];
  readonly cancelRequested: boolean;
  readonly error?: string;
  readonly sources: readonly BatchSource[];
  readonly outputDirectory: string;
  readonly finishedAt?: number;
}

/**
 * Sequential master-export queue: every frame keeps its own recipe, the active
 * atomic write always finishes before a cancel takes effect, and each finished
 * frame releases its full-resolution utility raster before the next starts.
 */
export class BatchService {
  private readonly jobs = new Map<string, BatchJob>();
  private readonly processing: ProcessingService;
  /** Output names currently claimed by a running export, so two concurrent
   * jobs into the same directory cannot both pick the same free name. */
  private readonly reservedOutputPaths = new Set<string>();
  /** Serializes name selection: the disk check and the claim must be one
   * atomic step, or two jobs can both pass the check before either claims. */
  private selectionTail: Promise<void> = Promise.resolve();

  public constructor(processing: ProcessingService) {
    this.processing = processing;
  }

  private reserveOutputPath(directory: string, preferredName: string): Promise<string> {
    const run = this.selectionTail.then(async () => {
      const outputPath = await findAvailableOutputPath(directory, preferredName, this.reservedOutputPaths);
      this.reservedOutputPaths.add(outputPath);
      return outputPath;
    });
    this.selectionTail = run.then(() => undefined, () => undefined);
    return run;
  }

  public start(
    sources: readonly BatchSource[],
    outputDirectory: string,
    format: MasterExportFormat = "tiff",
  ): BatchJobSummary {
    if ([...this.jobs.values()].filter((job) => !isTerminalJob(job)).length >= maximumActiveBatchJobs) {
      throw new Error("同时运行的批处理任务过多，请等待当前任务完成。");
    }
    const id = randomUUID();
    const job: BatchJob = {
      id,
      format,
      state: "queued",
      total: sources.length,
      completed: 0,
      failedAssetIds: [],
      cancelRequested: false,
      sources,
      outputDirectory,
    };
    this.jobs.set(id, job);
    void this.run(id);
    return summarizeJob(job);
  }

  public get(id: string): BatchJobSummary | undefined {
    const job = this.jobs.get(id);
    return job === undefined ? undefined : summarizeJob(job);
  }

  public cancel(id: string): BatchJobSummary | undefined {
    const current = this.jobs.get(id);
    if (
      current === undefined
      || current.state === "completed"
      || current.state === "completed-with-errors"
      || current.state === "cancelled"
      || current.state === "failed"
    ) {
      return current === undefined ? undefined : summarizeJob(current);
    }
    const next: BatchJob = { ...current, cancelRequested: true };
    this.jobs.set(id, next);
    return summarizeJob(next);
  }

  private async run(id: string): Promise<void> {
    let job = this.jobs.get(id);
    if (job === undefined) return;
    job = { ...job, state: "running" };
    this.jobs.set(id, job);
    try {
      for (let index = 0; index < job.sources.length; index += 1) {
        job = this.requireJob(id);
        if (job.cancelRequested) {
          this.storeTerminalJob({ ...job, state: "cancelled", currentAssetId: undefined });
          return;
        }
        const source = job.sources[index];
        const outputPath = await this.reserveOutputPath(
          job.outputDirectory,
          makeOutputName(source.sourceName, index, job.format),
        );
        this.jobs.set(id, { ...job, currentAssetId: source.item.assetId });
        try {
          await this.processing.exportTiff(source.item.assetId, source.sourcePath, {
            outputPath,
            suggestedFileName: basename(outputPath),
            format: job.format,
            mode: source.item.mode,
            tone: source.item.tone,
            calibrationProfile: source.calibrationProfile,
            processing: source.item.processing,
            dmaxOverride: source.item.dmaxOverride,
            dmaxChannelRange: source.item.dmaxChannelRange,
          });
        } catch {
          job = this.requireJob(id);
          this.jobs.set(id, {
            ...job,
            completed: job.completed + 1,
            failedAssetIds: [...job.failedAssetIds, source.item.assetId],
            currentAssetId: undefined,
          });
          continue;
        } finally {
          // The claim was only needed while picking the name; after the
          // attempt the on-disk file (or its absence) decides availability.
          this.reservedOutputPaths.delete(outputPath);
          await this.processing.release(source.item.assetId).catch(() => undefined);
        }
        job = this.requireJob(id);
        this.jobs.set(id, { ...job, completed: job.completed + 1, currentAssetId: undefined });
      }
      job = this.requireJob(id);
      const terminalState: BatchJobInternalState = job.cancelRequested
        ? "cancelled"
        : job.failedAssetIds.length > 0
          ? "completed-with-errors"
          : "completed";
      this.storeTerminalJob({
        ...job,
        state: terminalState,
        currentAssetId: undefined,
      });
    } catch (error) {
      job = this.requireJob(id);
      this.storeTerminalJob({
        ...job,
        state: "failed",
        currentAssetId: undefined,
        error: error instanceof Error ? error.message : "Batch export failed.",
      });
    }
  }

  private requireJob(id: string): BatchJob {
    const job = this.jobs.get(id);
    if (job === undefined) throw new Error("Batch job no longer exists.");
    return job;
  }

  private storeTerminalJob(job: BatchJob): void {
    this.jobs.set(job.id, {
      ...job,
      sources: [],
      outputDirectory: "",
      finishedAt: Date.now(),
    });
    const terminalJobs = [...this.jobs.values()]
      .filter(isTerminalJob)
      .sort((left, right) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0));
    for (const expired of terminalJobs.slice(0, Math.max(0, terminalJobs.length - maximumRetainedBatchJobs))) {
      this.jobs.delete(expired.id);
    }
  }
}

function isTerminalJob(job: BatchJob): boolean {
  return job.state === "completed" || job.state === "completed-with-errors"
    || job.state === "cancelled" || job.state === "failed";
}

function summarizeJob(job: BatchJob): BatchJobSummary {
  return {
    id: job.id,
    format: job.format,
    state: job.state as BatchJobState,
    total: job.total,
    completed: job.completed,
    currentAssetId: job.currentAssetId,
    failedAssetIds: [...job.failedAssetIds],
    cancelRequested: job.cancelRequested,
    error: job.error,
  };
}

function makeOutputName(sourceName: string, index: number, format: MasterExportFormat): string {
  const extension = extname(sourceName);
  const stem = (extension.length === 0 ? sourceName : sourceName.slice(0, -extension.length))
    .replace(/[<>:"/\\|?* -]/g, "-")
    .trim()
    .slice(0, 80) || "frame-" + String(index + 1).padStart(3, "0");
  const outputExtension = format === "jpeg" ? ".jpg" : format === "heif" ? ".avif" : "." + format;
  return String(index + 1).padStart(3, "0") + "-" + stem + "-positive" + outputExtension;
}

async function findAvailableOutputPath(
  directory: string,
  preferredName: string,
  reserved: ReadonlySet<string>,
): Promise<string> {
  const extension = extname(preferredName);
  const stem = preferredName.slice(0, -extension.length);
  for (let suffix = 1; suffix <= 10000; suffix += 1) {
    const candidateName = suffix === 1 ? preferredName : stem + "-" + suffix + extension;
    const candidate = join(directory, candidateName);
    // The in-process reservation closes the two-concurrent-jobs race; the
    // access() check below remains best-effort against other processes.
    if (reserved.has(candidate)) continue;
    try {
      await access(candidate);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return candidate;
      throw error;
    }
  }
  throw new Error("Batch output directory contains too many conflicting file names.");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}
