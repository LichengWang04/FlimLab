import type { Worker } from "node:worker_threads";
import type { Recipe } from "../core/index.ts";
import type { SingleExportResult } from "../shared/ipc.ts";

interface PendingJob {
  request: {
    jobId: number;
    sourcePath: string;
    recipe: Recipe;
    format: "tiff" | "jpeg";
    outPath: string;
  };
  resolve: (result: SingleExportResult) => void;
  retries: number;
}

export type ProcessingWorker = Pick<Worker, "on" | "postMessage" | "terminate">;

/** Testable Worker lifecycle coordinator; packaging-specific paths live outside this module. */
export class ProcessingServiceCore {
  private worker?: ProcessingWorker;
  private active?: PendingJob;
  private sequence = 0;
  private closing = false;
  private readonly workerFactory: () => ProcessingWorker;

  constructor(workerFactory: () => ProcessingWorker) {
    this.workerFactory = workerFactory;
  }

  renderPositive(
    sourcePath: string,
    recipe: Recipe,
    format: "tiff" | "jpeg",
    outPath: string,
  ): Promise<SingleExportResult> {
    if (this.active !== undefined) {
      return Promise.resolve({ ok: false, message: "另一个导出任务仍在处理中。" });
    }
    return new Promise((resolve) => {
      this.active = {
        request: { jobId: ++this.sequence, sourcePath, recipe, format, outPath },
        resolve,
        retries: 0,
      };
      this.postActive();
    });
  }

  close(): void {
    this.closing = true;
    void this.worker?.terminate();
    this.worker = undefined;
    this.active?.resolve({ ok: false, message: "应用正在退出，导出已停止。" });
    this.active = undefined;
  }

  private ensureWorker(): ProcessingWorker {
    if (this.worker !== undefined) return this.worker;
    const worker = this.workerFactory();
    worker.on("message", (message: { jobId: number; result: SingleExportResult }) => {
      const active = this.active;
      if (active === undefined || message.jobId !== active.request.jobId) return;
      this.active = undefined;
      active.resolve(message.result);
    });
    worker.on("error", (error) => this.handleFailure(worker, error));
    worker.on("exit", (code) => {
      if (!this.closing) {
        this.handleFailure(worker, new Error(`导出 Worker 已退出（${code}）。`));
      }
    });
    this.worker = worker;
    return worker;
  }

  private postActive(): void {
    const active = this.active;
    if (active === undefined) return;
    try {
      this.ensureWorker().postMessage(active.request);
    } catch (error) {
      const failed = this.worker;
      if (failed !== undefined) this.handleFailure(failed, error instanceof Error ? error : new Error(String(error)));
      else this.finishCreationFailure(error);
    }
  }

  private finishCreationFailure(error: unknown): void {
    const active = this.active;
    if (active === undefined) return;
    if (active.retries < 1 && !this.closing) {
      active.retries += 1;
      this.postActive();
      return;
    }
    this.active = undefined;
    active.resolve({ ok: false, message: `后台导出失败：${error instanceof Error ? error.message : String(error)}` });
  }

  private handleFailure(failedWorker: ProcessingWorker, error: Error): void {
    // worker_threads may emit both error and exit for one crash. Only the
    // first event is allowed to consume the single automatic restart.
    if (this.worker !== failedWorker) return;
    const active = this.active;
    this.worker = undefined;
    if (active === undefined) return;
    if (active.retries < 1 && !this.closing) {
      active.retries += 1;
      this.postActive();
      return;
    }
    this.active = undefined;
    active.resolve({ ok: false, message: `后台导出失败：${error.message}` });
  }
}
