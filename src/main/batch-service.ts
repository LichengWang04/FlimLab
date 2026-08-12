import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { CalibrationProfileDocument } from "../core/calibration.ts";
import type { BatchJobSummary, BatchTiffExportItem } from "../shared/contracts.ts";
import type { ProcessingService } from "./processing-service.ts";

export interface BatchSource {
  readonly item: BatchTiffExportItem;
  readonly sourcePath: string;
  readonly sourceName: string;
  readonly calibrationProfile?: CalibrationProfileDocument;
}

interface BatchJob extends BatchJobSummary {
  readonly sources: readonly BatchSource[];
  readonly outputDirectory: string;
}

/**
 * A deliberately single-file-at-a-time export queue. It keeps the utility
 * process memory bounded and makes cancellation deterministic: the current
 * TIFF is allowed to finish its atomic write, then no further item starts.
 */
export class BatchService {
  private readonly jobs = new Map<string, BatchJob>();
  private readonly processing: ProcessingService;

  public constructor(processing: ProcessingService) {
    this.processing = processing;
  }

  public start(
    sources: readonly BatchSource[],
    outputDirectory: string,
  ): BatchJobSummary {
    const id = randomUUID();
    const job: BatchJob = {
      id,
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
    if (current === undefined || current.state === "completed" || current.state === "cancelled" || current.state === "failed") {
      return current === undefined ? undefined : summarizeJob(current);
    }
    const next = { ...current, cancelRequested: true } satisfies BatchJob;
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
          this.jobs.set(id, { ...job, state: "cancelled", currentAssetId: undefined });
          return;
        }
        const source = job.sources[index];
        const outputPath = await findAvailableOutputPath(
          job.outputDirectory,
          makeOutputName(source.sourceName, index),
        );
        this.jobs.set(id, { ...job, currentAssetId: source.item.assetId });
        try {
          await this.processing.exportTiff(source.item.assetId, source.sourcePath, {
            outputPath,
            suggestedFileName: basename(outputPath),
            mode: source.item.mode,
            tone: source.item.tone,
            calibrationProfile: source.calibrationProfile,
            processing: source.item.processing,
            dmaxOverride: source.item.dmaxOverride,
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
        }
        job = this.requireJob(id);
        this.jobs.set(id, { ...job, completed: job.completed + 1, currentAssetId: undefined });
      }
      job = this.requireJob(id);
      this.jobs.set(id, {
        ...job,
        state: job.cancelRequested ? "cancelled" : "completed",
        currentAssetId: undefined,
      });
    } catch (error: unknown) {
      job = this.requireJob(id);
      this.jobs.set(id, {
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
}

/**
 * Batch jobs retain source paths and the selected output directory so the
 * main process can continue exporting. Never return that internal object
 * across IPC: TypeScript's structural return type does not remove properties
 * at runtime.
 */
function summarizeJob(job: BatchJob): BatchJobSummary {
  return {
    id: job.id,
    state: job.state,
    total: job.total,
    completed: job.completed,
    currentAssetId: job.currentAssetId,
    failedAssetIds: [...job.failedAssetIds],
    cancelRequested: job.cancelRequested,
    error: job.error,
  };
}

function makeOutputName(sourceName: string, index: number): string {
  const extension = extname(sourceName);
  const stem = (extension.length === 0 ? sourceName : sourceName.slice(0, -extension.length))
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .trim()
    .slice(0, 80) || "frame-" + String(index + 1).padStart(3, "0");
  return String(index + 1).padStart(3, "0") + "-" + stem + "-positive.tiff";
}

async function findAvailableOutputPath(directory: string, preferredName: string): Promise<string> {
  const extension = extname(preferredName);
  const stem = preferredName.slice(0, -extension.length);
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const candidateName = suffix === 1
      ? preferredName
      : stem + "-" + suffix + extension;
    const candidate = join(directory, candidateName);
    try {
      await access(candidate);
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) return candidate;
      throw error;
    }
  }
  throw new Error("Batch output directory contains too many conflicting file names.");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}
