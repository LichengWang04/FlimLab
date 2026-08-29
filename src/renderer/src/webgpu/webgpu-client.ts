import type { Recipe } from "../../../core/index.ts";
import type {
  GpuCapabilities,
  GpuDiagnostics,
  GpuPreparation,
  GpuWorkerRequest,
  GpuWorkerResponse,
} from "./protocol.ts";

interface WorkerPort {
  onmessage: ((event: MessageEvent<GpuWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

type SuccessfulResponse = Exclude<GpuWorkerResponse, { kind: "error" } | { kind: "device-lost" }>;

export class WebGpuPreviewClient {
  private readonly worker: WorkerPort;
  private sequence = 0;
  private readonly pending = new Map<number, {
    resolve: (message: SuccessfulResponse) => void;
    reject: (error: Error) => void;
  }>();
  private lossHandler?: (message: string) => void;

  constructor(workerFactory: () => WorkerPort = () => (
    new Worker(new URL("./webgpu-worker.ts", import.meta.url), { type: "module" })
  )) {
    this.worker = workerFactory();
    this.worker.onmessage = (event) => this.handle(event.data);
    this.worker.onerror = (event) => {
      const location = event.filename === "" ? "" : ` (${event.filename}:${event.lineno}:${event.colno})`;
      this.failAll(new Error(`${event.message || "WebGPU Worker 意外停止。"}${location}`));
    };
  }

  onDeviceLost(handler: (message: string) => void): void {
    this.lossHandler = handler;
  }

  async probe(): Promise<GpuCapabilities> {
    const response = await this.request({ kind: "probe", requestId: this.next() });
    if (response.kind !== "capabilities") throw new Error("WebGPU 能力探测响应无效。");
    return response.capabilities;
  }

  async attach(canvas: OffscreenCanvas): Promise<void> {
    const requestId = this.next();
    await this.request({ kind: "attach", requestId, canvas }, [canvas]);
  }

  async registerSource(id: string, width: number, height: number, raster: Float32Array): Promise<GpuDiagnostics> {
    const requestId = this.next();
    const SharedBuffer = globalThis.SharedArrayBuffer;
    const shared = SharedBuffer !== undefined && raster.buffer instanceof SharedBuffer;
    // A shared source is posted by reference. Without cross-origin isolation,
    // make one owned copy and transfer it so the caller's cache stays intact.
    const owned = shared ? raster : new Float32Array(raster);
    const response = await this.request(
      { kind: "register", requestId, id, width, height, raster: owned },
      shared ? undefined : [owned.buffer],
    );
    if (response.kind !== "registered") throw new Error("WebGPU 源注册响应无效。");
    return response.diagnostics;
  }

  async render(
    id: string,
    revision: number,
    recipe: Recipe,
    preparation: GpuPreparation,
  ): Promise<{ width: number; height: number; diagnostics: GpuDiagnostics }> {
    const requestId = this.next();
    const response = await this.request({ kind: "render", requestId, revision, id, recipe, preparation });
    if (response.kind !== "rendered") throw new Error("WebGPU 渲染响应无效。");
    return { width: response.width, height: response.height, diagnostics: response.diagnostics };
  }

  async release(id: string): Promise<void> {
    const requestId = this.next();
    await this.request({ kind: "release", requestId, id });
  }

  terminate(): void {
    this.failAll(new Error("WebGPU Worker 已停止。"));
    this.worker.terminate();
  }

  private next(): number {
    return ++this.sequence;
  }

  private request(message: GpuWorkerRequest, transfer?: Transferable[]): Promise<SuccessfulResponse> {
    return new Promise((resolve, reject) => {
      this.pending.set(message.requestId, { resolve, reject });
      this.worker.postMessage(message, transfer);
    });
  }

  private handle(message: GpuWorkerResponse): void {
    if (message.kind === "device-lost") {
      this.lossHandler?.(message.message);
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (pending === undefined) return;
    this.pending.delete(message.requestId);
    if (message.kind === "error") pending.reject(new Error(message.message));
    else pending.resolve(message);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
