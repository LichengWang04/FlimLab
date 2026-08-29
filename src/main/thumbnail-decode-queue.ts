export class StaleThumbnailError extends Error {
  constructor() {
    super("缩略图请求已过期。");
    this.name = "StaleThumbnailError";
  }
}

interface QueuedJob {
  key: string;
  cancelled: boolean;
  operation: () => Promise<unknown>;
  isCurrent: () => boolean;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/** Main-process resource boundary for display-only thumbnail decodes. */
export class ThumbnailDecodeQueue {
  private readonly concurrency: number;
  private readonly pending: QueuedJob[] = [];
  private readonly active = new Set<QueuedJob>();

  constructor(concurrency = 2) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Thumbnail concurrency must be positive.");
    this.concurrency = concurrency;
  }

  submit<T>(key: string, isCurrent: () => boolean, operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        key,
        cancelled: false,
        operation,
        isCurrent,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.pump();
    });
  }

  cancelKey(key: string): void {
    this.cancelWhere((job) => job.key === key);
  }

  cancelAll(): void {
    this.cancelWhere(() => true);
  }

  get activeCount(): number {
    return this.active.size;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  private cancelWhere(predicate: (job: QueuedJob) => boolean): void {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const job = this.pending[index]!;
      if (!predicate(job)) continue;
      this.pending.splice(index, 1);
      job.cancelled = true;
      job.reject(new StaleThumbnailError());
    }
    for (const job of this.active) {
      if (predicate(job)) job.cancelled = true;
    }
  }

  private pump(): void {
    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      if (job.cancelled || !job.isCurrent()) {
        job.reject(new StaleThumbnailError());
        continue;
      }
      this.active.add(job);
      void job.operation().then(
        (value) => {
          if (job.cancelled || !job.isCurrent()) job.reject(new StaleThumbnailError());
          else job.resolve(value);
        },
        (error) => job.reject(error),
      ).finally(() => {
        this.active.delete(job);
        this.pump();
      });
    }
  }
}
