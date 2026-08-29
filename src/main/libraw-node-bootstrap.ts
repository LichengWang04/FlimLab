import { readFileSync } from "node:fs";
import { Worker as NodeWorker, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";

interface BootstrapData {
  moduleUrl: string;
  name?: string;
}

interface BrowserMessageEvent<T = unknown> {
  data: T;
}

interface BrowserErrorEvent {
  message: string;
  filename: string;
  lineno: number;
}

const data = workerData as BootstrapData;
if (parentPort === null || typeof data.moduleUrl !== "string") {
  throw new Error("LibRaw Node worker bootstrap is missing its parent port or module URL.");
}
const port = parentPort;

const queuedMessages: BrowserMessageEvent[] = [];
const scope: {
  name: string;
  onmessage: ((event: BrowserMessageEvent) => void) | null;
  onunhandledrejection: ((event: { reason: unknown }) => void) | null;
  postMessage(value: unknown, transfer?: readonly Transferable[]): void;
} = {
  name: data.name ?? "",
  onmessage: null,
  onunhandledrejection: null,
  postMessage(value, transfer = []) {
    port.postMessage(value, transfer as readonly ArrayBuffer[]);
  },
};

port.on("message", (message: unknown) => {
  const event = { data: message };
  if (scope.onmessage === null) queuedMessages.push(event);
  else scope.onmessage(event);
});

class BrowserWorkerAdapter {
  onmessage: ((event: BrowserMessageEvent) => void) | null = null;
  onerror: ((event: BrowserErrorEvent) => void) | null = null;
  private readonly worker: NodeWorker;

  constructor(url: URL | string, options?: { name?: string }) {
    const target = url instanceof URL ? url.href : String(url);
    this.worker = new NodeWorker(fileURLToPath(import.meta.url), {
      workerData: { moduleUrl: normalizeModuleUrl(target), name: options?.name ?? "" } satisfies BootstrapData,
      execArgv: [],
    });
    this.worker.on("message", (message: unknown) => this.onmessage?.({ data: message }));
    this.worker.on("error", (error) => this.onerror?.({ message: error.message, filename: "", lineno: 0 }));
  }

  postMessage(value: unknown, transfer?: readonly Transferable[]): void {
    this.worker.postMessage(value, transfer as readonly ArrayBuffer[] | undefined);
  }

  terminate(): void {
    void this.worker.terminate();
  }
}

class FileXmlHttpRequest {
  responseType = "";
  response: ArrayBuffer | null = null;
  private url = "";

  open(method: string, url: string | URL, async = true): void {
    if (method.toUpperCase() !== "GET" || async) {
      throw new Error("LibRaw only permits synchronous GET for local WASM assets.");
    }
    this.url = normalizeModuleUrl(String(url));
  }

  send(): void {
    const bytes = readFileSync(fileURLToPath(this.url));
    this.response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
}

function normalizeModuleUrl(value: string): string {
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) return value;
  return pathToFileURL(value).href;
}

const nativeFetch = globalThis.fetch;
const localAssetFetch: typeof fetch = async (input, init) => {
  const url = input instanceof URL
    ? input.href
    : typeof input === "string"
      ? input
      : input.url;
  if (url.startsWith("file:")) {
    const bytes = readFileSync(fileURLToPath(url));
    return new Response(bytes, {
      status: 200,
      headers: { "Content-Type": url.endsWith(".wasm") ? "application/wasm" : "application/javascript" },
    });
  }
  return nativeFetch(input, init);
};

Object.assign(globalThis, {
  self: scope,
  name: scope.name,
  Worker: BrowserWorkerAdapter,
  WorkerGlobalScope: class WorkerGlobalScope {},
  XMLHttpRequest: FileXmlHttpRequest,
  fetch: localAssetFetch,
});

await import(data.moduleUrl);
for (const event of queuedMessages.splice(0)) scope.onmessage?.(event);
