import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  LibRawImageData,
  LibRawMetadata,
  LibRawOptions,
  LibRawThumbnailData,
} from "libraw-wasm";

interface WorkerReply {
  id?: number;
  out?: unknown;
  error?: string;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** Runs libraw-wasm's browser worker bundle inside Node worker_threads. */
export class LibRawNodeClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingCall>();
  private sequence = 0;
  private tail = Promise.resolve();
  private disposed = false;

  constructor(workerModuleUrl = resolveLibRawWorkerUrl()) {
    const bootstrapPath = resolveBootstrapPath();
    this.worker = new Worker(bootstrapPath, {
      workerData: { moduleUrl: workerModuleUrl, name: "libraw-api" },
      execArgv: [],
    });
    this.worker.on("message", (reply: WorkerReply) => {
      if (typeof reply.id !== "number") return;
      const call = this.pending.get(reply.id);
      if (call === undefined) return;
      this.pending.delete(reply.id);
      if (typeof reply.error === "string") call.reject(new Error(reply.error));
      else call.resolve(reply.out);
    });
    this.worker.on("error", (error) => this.failAll(error));
    this.worker.on("exit", (code) => {
      if (!this.disposed && code !== 0) this.failAll(new Error(`LibRaw worker stopped unexpectedly (${code}).`));
    });
  }

  open(bytes: Uint8Array, options: LibRawOptions): Promise<void> {
    if (!(bytes.buffer instanceof ArrayBuffer)) throw new Error("LibRaw input must use a transferable ArrayBuffer.");
    return this.run<void>("open", [bytes, options], [bytes.buffer]);
  }

  metadata(full = false): Promise<LibRawMetadata | undefined> {
    return this.run<LibRawMetadata | undefined>("metadata", [full]);
  }

  imageData(): Promise<LibRawImageData | undefined> {
    return this.run<LibRawImageData | undefined>("imageData", []);
  }

  thumbnailData(): Promise<LibRawThumbnailData | undefined> {
    return this.run<LibRawThumbnailData | undefined>("thumbnailData", []);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.worker.terminate();
    this.failAll(new Error("LibRaw worker was disposed."));
  }

  private run<T>(fn: string, args: unknown[], transfer: ArrayBuffer[] = []): Promise<T> {
    const operation = (): Promise<T> => new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error("LibRaw worker was disposed."));
        return;
      }
      const id = this.sequence++;
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ id, fn, args }, transfer);
    });
    const queued = this.tail.then(operation, operation);
    this.tail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private failAll(error: Error): void {
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
  }
}

function resolveBootstrapPath(): string {
  const adjacent = join(import.meta.dirname, "libraw-node-bootstrap.js");
  if (existsSync(adjacent)) return adjacent;
  const built = join(process.cwd(), "out", "main", "libraw-node-bootstrap.js");
  if (existsSync(built)) return built;
  throw new Error("LibRaw Node worker bootstrap is missing; build FilmLab before RAW decoding.");
}

function resolveLibRawWorkerUrl(): string {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve("libraw-wasm/package.json"));
  const workerPath = unpackedPath(join(packageRoot, "dist", "worker.js"));
  return pathToFileURL(workerPath).href;
}

function unpackedPath(path: string): string {
  return path.includes("app.asar") ? path.replace("app.asar", "app.asar.unpacked") : path;
}
