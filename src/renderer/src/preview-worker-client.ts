import type { Recipe } from "../../core/index.ts";
import type {
  PreviewWorkerRequest,
  PreviewWorkerResponse,
  PreviewWorkerResult,
  ThumbnailWorkerResult,
} from "./preview-worker-protocol.ts";

interface PreviewJob {
  id: string;
  recipe: Recipe;
  revision: number;
  onResult: (result: PreviewWorkerResult, revision: number) => void;
  onError: (message: string, missingSource: boolean) => void;
}

interface ThumbnailJob {
  id: string;
  width: number;
  height: number;
  raster: Float32Array;
  recipe: Recipe;
  onResult: (result: ThumbnailWorkerResult) => void;
}

export interface PreviewWorkerPort {
  onmessage: ((event: MessageEvent<PreviewWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

/** One active CPU task plus a coalesced latest-preview/thumbnail queue. */
export class PreviewWorkerClient {
  private readonly worker: PreviewWorkerPort;
  private busy = false;
  private sequence = 0;
  private pendingPreview?: PreviewJob;
  private readonly pendingThumbnails = new Map<string, ThumbnailJob>();
  private activePreview?: PreviewJob;
  private activeThumbnail?: ThumbnailJob;
  private fatalHandler?: (message: string) => void;

  constructor(workerFactory: () => PreviewWorkerPort = () => (
    new Worker(new URL("./preview-worker.ts", import.meta.url), { type: "module" })
  )) {
    this.worker = workerFactory();
    this.worker.onmessage = (event: MessageEvent<PreviewWorkerResponse>) => this.handleMessage(event.data);
    this.worker.onerror = (event) => {
      this.busy = false;
      this.fatalHandler?.(event.message || "预览 Worker 意外停止。 ");
    };
  }

  onFatal(handler: (message: string) => void): void {
    this.fatalHandler = handler;
  }

  registerSource(id: string, width: number, height: number, raster: Float32Array): void {
    const owned = new Float32Array(raster.length);
    owned.set(raster);
    const message: PreviewWorkerRequest = {
      kind: "register",
      id,
      width,
      height,
      raster: owned,
    };
    this.worker.postMessage(message, [owned.buffer]);
  }

  requestPreview(job: PreviewJob): void {
    this.pendingPreview = job;
    this.pump();
  }

  requestThumbnail(job: ThumbnailJob): void {
    this.pendingThumbnails.set(job.id, job);
    this.pump();
  }

  release(id: string): void {
    this.pendingThumbnails.delete(id);
    if (this.pendingPreview?.id === id) this.pendingPreview = undefined;
    if (this.activePreview?.id === id) this.activePreview = undefined;
    if (this.activeThumbnail?.id === id) this.activeThumbnail = undefined;
    this.worker.postMessage({ kind: "release", id } satisfies PreviewWorkerRequest);
  }

  clear(): void {
    this.pendingPreview = undefined;
    this.pendingThumbnails.clear();
    this.worker.postMessage({ kind: "clear" } satisfies PreviewWorkerRequest);
  }

  terminate(): void {
    this.worker.terminate();
  }

  private pump(): void {
    if (this.busy) return;
    const preview = this.pendingPreview;
    if (preview !== undefined) {
      this.pendingPreview = undefined;
      this.activePreview = preview;
      this.busy = true;
      const message: PreviewWorkerRequest = {
        kind: "process",
        requestId: ++this.sequence,
        revision: preview.revision,
        id: preview.id,
        recipe: preview.recipe,
      };
      this.worker.postMessage(message);
      return;
    }
    const nextThumbnail = this.pendingThumbnails.entries().next().value as [string, ThumbnailJob] | undefined;
    if (nextThumbnail === undefined) return;
    this.pendingThumbnails.delete(nextThumbnail[0]);
    const thumbnail = nextThumbnail[1];
    this.activeThumbnail = thumbnail;
    this.busy = true;
    const owned = new Float32Array(thumbnail.raster.length);
    owned.set(thumbnail.raster);
    const message: PreviewWorkerRequest = {
      kind: "thumbnail",
      requestId: ++this.sequence,
      id: thumbnail.id,
      width: thumbnail.width,
      height: thumbnail.height,
      raster: owned,
      recipe: thumbnail.recipe,
    };
    this.worker.postMessage(message, [owned.buffer]);
  }

  private handleMessage(message: PreviewWorkerResponse): void {
    this.busy = false;
    if (message.kind === "preview") {
      const active = this.activePreview;
      this.activePreview = undefined;
      const superseded = this.pendingPreview !== undefined && this.pendingPreview.revision > message.revision;
      if (!superseded && active !== undefined && active.id === message.id && active.revision === message.revision) {
        active.onResult(message.result, message.revision);
      }
    } else if (message.kind === "thumbnail") {
      const active = this.activeThumbnail;
      this.activeThumbnail = undefined;
      if (active !== undefined && active.id === message.id) active.onResult(message.result);
    } else {
      const active = this.activePreview;
      this.activePreview = undefined;
      this.activeThumbnail = undefined;
      active?.onError(message.message, message.missingSource === true);
    }
    this.pump();
  }
}
