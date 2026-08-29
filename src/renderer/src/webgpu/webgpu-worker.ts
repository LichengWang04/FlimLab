/// <reference lib="webworker" />

import type {
  GpuCapabilities,
  GpuDiagnostics,
  GpuWorkerRequest,
  GpuWorkerResponse,
} from "./protocol.ts";
import { evaluateWebGpuPrerequisites } from "./protocol.ts";
import { createWebGpuRenderParameters } from "./params.ts";
import { PARAM_FLOATS, WEBGPU_PREVIEW_SHADER } from "./shader.ts";

interface SourceEntry {
  width: number;
  height: number;
  raster: Float32Array;
  buffer: GPUBuffer;
}

let adapter: GPUAdapter | undefined;
let device: GPUDevice | undefined;
let canvas: OffscreenCanvas | undefined;
let context: GPUCanvasContext | undefined;
let format: GPUTextureFormat | undefined;
let pipeline: GPURenderPipeline | undefined;
let parameterBuffer: GPUBuffer | undefined;
let recovering = false;
let recoveryCount = 0;
let disabledReason: string | undefined;
const sources = new Map<string, SourceEntry>();
const diagnostics: GpuDiagnostics = {
  h2dBytes: 0,
  d2hBytes: 0,
  sourceUploads: 0,
  dispatches: 0,
  gpuMs: 0,
  tileCount: 0,
};

self.onmessage = (event: MessageEvent<GpuWorkerRequest>) => {
  void handle(event.data).catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    respond({ kind: "error", requestId: event.data.requestId, message });
  });
};

async function handle(message: GpuWorkerRequest): Promise<void> {
  if (message.kind === "probe") {
    respond({ kind: "capabilities", requestId: message.requestId, capabilities: await probe() });
    return;
  }
  if (message.kind === "attach") {
    await ensureDevice();
    canvas = message.canvas;
    const attachedContext = canvas.getContext("webgpu");
    if (attachedContext === null) throw new Error("OffscreenCanvas 无法创建 WebGPU 上下文。");
    context = attachedContext;
    configureContext();
    respond({ kind: "attached", requestId: message.requestId });
    return;
  }
  if (message.kind === "register") {
    const gpu = await ensureDevice();
    const expected = message.width * message.height * 3;
    if (message.raster.length !== expected) throw new Error("WebGPU 源栅格尺寸不匹配。");
    if (message.raster.byteLength > gpu.limits.maxStorageBufferBindingSize) {
      throw new Error("预览源超过 GPU 单个存储缓冲区上限。");
    }
    destroySource(message.id);
    const buffer = createSourceBuffer(gpu, message.raster);
    sources.set(message.id, { width: message.width, height: message.height, raster: message.raster, buffer });
    diagnostics.h2dBytes += message.raster.byteLength;
    diagnostics.sourceUploads += 1;
    respond({ kind: "registered", requestId: message.requestId, id: message.id, diagnostics: snapshot() });
    return;
  }
  if (message.kind === "render") {
    const gpu = await ensureDevice();
    if (canvas === undefined || context === undefined) throw new Error("WebGPU 显示画布尚未连接。");
    const source = sources.get(message.id);
    if (source === undefined) throw new Error("WebGPU 预览源已被释放。");
    const parameters = createWebGpuRenderParameters(
      source.width,
      source.height,
      message.recipe,
      message.preparation,
    );
    if (parameters.width > gpu.limits.maxTextureDimension2D || parameters.height > gpu.limits.maxTextureDimension2D) {
      throw new Error("预览输出超过 GPU 最大纹理边长。");
    }
    canvas.width = parameters.width;
    canvas.height = parameters.height;
    configureContext();
    const renderPipeline = await ensurePipeline(gpu);
    const params = ensureParameterBuffer(gpu);
    gpu.queue.writeBuffer(params, 0, parameters.values);
    const bindGroup = gpu.createBindGroup({
      layout: renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: source.buffer } },
        { binding: 1, resource: { buffer: params } },
      ],
    });
    const encoder = gpu.createCommandEncoder({ label: "FilmLab preview render" });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(renderPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    const started = performance.now();
    gpu.queue.submit([encoder.finish()]);
    await gpu.queue.onSubmittedWorkDone();
    diagnostics.gpuMs += performance.now() - started;
    diagnostics.dispatches += 1;
    respond({
      kind: "rendered",
      requestId: message.requestId,
      revision: message.revision,
      id: message.id,
      width: parameters.width,
      height: parameters.height,
      diagnostics: snapshot(),
    });
    return;
  }
  if (message.kind === "release") {
    destroySource(message.id);
    respond({ kind: "released", requestId: message.requestId, id: message.id });
    return;
  }
  for (const id of sources.keys()) destroySource(id);
  respond({ kind: "released", requestId: message.requestId });
}

async function probe(): Promise<GpuCapabilities> {
  const sharedArrayBuffer = typeof SharedArrayBuffer !== "undefined";
  const offscreenCanvas = typeof OffscreenCanvas !== "undefined";
  try {
    const gpu = await ensureDevice();
    const info = adapter?.info;
    const prerequisites = evaluateWebGpuPrerequisites(sharedArrayBuffer, offscreenCanvas);
    return {
      ...prerequisites,
      adapter: info?.description || [info?.vendor, info?.architecture].filter(Boolean).join(" ") || "WebGPU adapter",
      maxBufferSize: gpu.limits.maxBufferSize,
      maxStorageBufferBindingSize: gpu.limits.maxStorageBufferBindingSize,
      maxTextureDimension2D: gpu.limits.maxTextureDimension2D,
    };
  } catch (caught) {
    return {
      available: false,
      adapter: "",
      maxBufferSize: 0,
      maxStorageBufferBindingSize: 0,
      maxTextureDimension2D: 0,
      sharedArrayBuffer,
      offscreenCanvas,
      reason: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

async function ensureDevice(): Promise<GPUDevice> {
  if (disabledReason !== undefined) throw new Error(disabledReason);
  if (device !== undefined) return device;
  if (navigator.gpu === undefined) throw new Error("navigator.gpu 不可用。");
  adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }) ?? undefined;
  if (adapter === undefined) throw new Error("未找到可用的 WebGPU adapter。");
  device = await adapter.requestDevice({ label: "FilmLab WebGPU" });
  installLossHandler(device);
  format = navigator.gpu.getPreferredCanvasFormat();
  return device;
}

function installLossHandler(current: GPUDevice): void {
  void current.lost.then(async (info) => {
    if (device !== current) return;
    device = undefined;
    pipeline = undefined;
    parameterBuffer?.destroy();
    parameterBuffer = undefined;
    for (const source of sources.values()) source.buffer.destroy();
    if (recoveryCount >= 1) {
      disabledReason = `WebGPU device 再次丢失：${info.message}`;
      respond({ kind: "device-lost", message: disabledReason });
      return;
    }
    recoveryCount += 1;
    recovering = true;
    try {
      const replacement = await ensureDevice();
      for (const source of sources.values()) {
        source.buffer = createSourceBuffer(replacement, source.raster);
        diagnostics.h2dBytes += source.raster.byteLength;
        diagnostics.sourceUploads += 1;
      }
      configureContext();
    } catch (caught) {
      disabledReason = caught instanceof Error ? caught.message : String(caught);
      respond({ kind: "device-lost", message: disabledReason });
    } finally {
      recovering = false;
    }
  });
}

async function ensurePipeline(gpu: GPUDevice): Promise<GPURenderPipeline> {
  if (pipeline !== undefined) return pipeline;
  gpu.pushErrorScope("validation");
  const module = gpu.createShaderModule({ label: "FilmLab preview shader", code: WEBGPU_PREVIEW_SHADER });
  const compilation = await module.getCompilationInfo();
  const shaderErrors = compilation.messages.filter((message) => message.type === "error");
  if (shaderErrors.length > 0) {
    await gpu.popErrorScope();
    throw new Error(shaderErrors.map((message) => (
      `WGSL ${message.lineNum}:${message.linePos} ${message.message}`
    )).join("\n"));
  }
  const created = await gpu.createRenderPipelineAsync({
    label: "FilmLab preview pipeline",
    layout: "auto",
    vertex: { module, entryPoint: "vertex_main" },
    fragment: { module, entryPoint: "fragment_main", targets: [{ format: format! }] },
    primitive: { topology: "triangle-list" },
  });
  const validation = await gpu.popErrorScope();
  if (validation !== null) throw new Error(`WebGPU shader validation error: ${validation.message}`);
  pipeline = created;
  return pipeline;
}

function createSourceBuffer(gpu: GPUDevice, raster: Float32Array): GPUBuffer {
  const buffer = gpu.createBuffer({
    label: "FilmLab preview source",
    size: raster.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  gpu.queue.writeBuffer(buffer, 0, raster);
  return buffer;
}

function ensureParameterBuffer(gpu: GPUDevice): GPUBuffer {
  parameterBuffer ??= gpu.createBuffer({
    label: "FilmLab preview parameters",
    size: PARAM_FLOATS * Float32Array.BYTES_PER_ELEMENT,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  return parameterBuffer;
}

function configureContext(): void {
  if (context === undefined || device === undefined || format === undefined) return;
  if (recovering && canvas === undefined) return;
  context.configure({ device, format, alphaMode: "opaque" });
}

function destroySource(id: string): void {
  const existing = sources.get(id);
  existing?.buffer.destroy();
  sources.delete(id);
}

function snapshot(): GpuDiagnostics {
  return { ...diagnostics };
}

function respond(message: GpuWorkerResponse): void {
  self.postMessage(message);
}
