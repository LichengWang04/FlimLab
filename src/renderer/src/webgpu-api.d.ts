/* Minimal WebGPU declarations for the Chromium runtime bundled by Electron.
 * TypeScript's DOM library does not yet ship the WebGPU IDL. Keep this list
 * intentionally limited to the APIs used by FilmLab. */

type GPUTextureFormat = string;

interface GPUSupportedLimits {
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxTextureDimension2D: number;
}

interface GPUAdapterInfo {
  readonly vendor: string;
  readonly architecture: string;
  readonly description: string;
}

interface GPUDeviceLostInfo { readonly message: string }
interface GPUError { readonly message: string }

interface GPU {
  requestAdapter(options?: { powerPreference?: "low-power" | "high-performance" }): Promise<GPUAdapter | null>;
  getPreferredCanvasFormat(): GPUTextureFormat;
}

interface GPUAdapter {
  readonly info: GPUAdapterInfo;
  requestDevice(descriptor?: { label?: string }): Promise<GPUDevice>;
}

interface GPUBuffer { destroy(): void }
interface GPUTexture { createView(): GPUTextureView }
interface GPUTextureView {}
interface GPUBindGroup {}
interface GPUBindGroupLayout {}
interface GPUCommandBuffer {}
interface GPUCompilationMessage {
  readonly type: "error" | "warning" | "info";
  readonly message: string;
  readonly lineNum: number;
  readonly linePos: number;
}
interface GPUShaderModule {
  getCompilationInfo(): Promise<{ readonly messages: readonly GPUCompilationMessage[] }>;
}

interface GPUQueue {
  writeBuffer(buffer: GPUBuffer, bufferOffset: number, data: ArrayBufferView): void;
  submit(commands: GPUCommandBuffer[]): void;
  onSubmittedWorkDone(): Promise<void>;
}

interface GPURenderPassEncoder {
  setPipeline(pipeline: GPURenderPipeline): void;
  setBindGroup(index: number, bindGroup: GPUBindGroup): void;
  draw(vertexCount: number): void;
  end(): void;
}

interface GPUCommandEncoder {
  beginRenderPass(descriptor: {
    colorAttachments: Array<{
      view: GPUTextureView;
      clearValue: { r: number; g: number; b: number; a: number };
      loadOp: "clear";
      storeOp: "store";
    }>;
  }): GPURenderPassEncoder;
  finish(): GPUCommandBuffer;
}

interface GPURenderPipeline { getBindGroupLayout(index: number): GPUBindGroupLayout }

interface GPUDevice {
  readonly limits: GPUSupportedLimits;
  readonly queue: GPUQueue;
  readonly lost: Promise<GPUDeviceLostInfo>;
  createBuffer(descriptor: { label?: string; size: number; usage: number }): GPUBuffer;
  createShaderModule(descriptor: { label?: string; code: string }): GPUShaderModule;
  createRenderPipelineAsync(descriptor: {
    label?: string;
    layout: "auto";
    vertex: { module: GPUShaderModule; entryPoint: string };
    fragment: { module: GPUShaderModule; entryPoint: string; targets: Array<{ format: GPUTextureFormat }> };
    primitive: { topology: "triangle-list" };
  }): Promise<GPURenderPipeline>;
  createBindGroup(descriptor: {
    layout: GPUBindGroupLayout;
    entries: Array<{ binding: number; resource: { buffer: GPUBuffer } }>;
  }): GPUBindGroup;
  createCommandEncoder(descriptor?: { label?: string }): GPUCommandEncoder;
  pushErrorScope(filter: "validation"): void;
  popErrorScope(): Promise<GPUError | null>;
}

interface GPUCanvasContext {
  configure(configuration: { device: GPUDevice; format: GPUTextureFormat; alphaMode: "opaque" }): void;
  getCurrentTexture(): GPUTexture;
}

interface Navigator { readonly gpu?: GPU }

interface OffscreenCanvas {
  getContext(contextId: "webgpu"): GPUCanvasContext | null;
}

declare const GPUBufferUsage: {
  readonly COPY_DST: number;
  readonly STORAGE: number;
};
