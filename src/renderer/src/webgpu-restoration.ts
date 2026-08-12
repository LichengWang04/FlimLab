import type { RestorationControls } from "../../shared/contracts.ts";

type WebGpuDevice = {
  createBuffer(descriptor: Record<string, unknown>): any;
  createCommandEncoder(): any;
  createBindGroup(descriptor: Record<string, unknown>): any;
  createShaderModule(descriptor: Record<string, unknown>): any;
  createComputePipeline(descriptor: Record<string, unknown>): any;
  queue: {
    writeBuffer(buffer: any, offset: number, data: ArrayBufferView): void;
    submit(commands: readonly any[]): void;
  };
  lost: Promise<unknown>;
};

const GPU_BUFFER_USAGE = {
  MAP_READ: 1,
  COPY_SRC: 4,
  COPY_DST: 8,
  STORAGE: 128,
  UNIFORM: 64,
} as const;
const GPU_MAP_MODE_READ = 1;

export interface WebGpuRestorationResult {
  readonly data: Float32Array;
  readonly elapsedMs: number;
  readonly gpuBackend: "webgpu-compute";
}

/**
 * Buffer-based WebGPU restoration engine. It is intentionally independent
 * from the WebGL2 renderer so availability can be benchmarked safely before
 * a caller chooses it; WebGL2 remains the zero-copy production fallback.
 */
export class WebGpuRestorationCompute {
  private readonly device: WebGpuDevice;
  private readonly pipeline: any;

  private constructor(device: WebGpuDevice) {
    this.device = device;
    const module = device.createShaderModule({ code: restorationComputeShader });
    this.pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
  }

  public static async create(): Promise<WebGpuRestorationCompute | undefined> {
    const gpu = (navigator as Navigator & {
      gpu?: { requestAdapter(options?: Record<string, unknown>): Promise<any> };
    }).gpu;
    if (gpu === undefined) return undefined;
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (adapter === null) return undefined;
    const device = await adapter.requestDevice() as WebGpuDevice;
    // Consume the loss promise so a device reset (driver update, GPU
    // switch) never surfaces as an unhandled rejection; the caller only
    // uses this probe to advertise availability.
    device.lost.catch(() => undefined);
    return new WebGpuRestorationCompute(device);
  }

  public async process(
    source: Float32Array,
    width: number,
    height: number,
    controls: RestorationControls,
  ): Promise<WebGpuRestorationResult> {
    if (
      !Number.isSafeInteger(width)
      || !Number.isSafeInteger(height)
      || width <= 0
      || height <= 0
      || source.length !== width * height * 3
    ) {
      throw new Error("WebGPU restoration source dimensions are invalid.");
    }
    const startedAt = performance.now();
    const byteLength = source.byteLength;
    const input = this.device.createBuffer({
      size: byteLength,
      usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST,
    });
    const ping = this.device.createBuffer({
      size: byteLength,
      usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_SRC,
    });
    const pong = this.device.createBuffer({
      size: byteLength,
      usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_SRC,
    });
    const parameterBuffers: any[] = [];
    const readback = this.device.createBuffer({
      size: byteLength,
      usage: GPU_BUFFER_USAGE.MAP_READ | GPU_BUFFER_USAGE.COPY_DST,
    });
    this.device.queue.writeBuffer(input, 0, source);
    const passes = [
      { pass: 0, enabled: controls.dust || controls.scratches, input, output: ping },
      { pass: 1, enabled: controls.denoise > 0, input: ping, output: pong },
      { pass: 2, enabled: controls.denoise > 0, input: pong, output: ping },
      { pass: 3, enabled: controls.sharpen > 0, input: ping, output: pong },
    ];
    let latest = input;
    const encoder = this.device.createCommandEncoder();
    for (const step of passes) {
      if (!step.enabled) continue;
      const passParameters = new ArrayBuffer(32);
      const u32 = new Uint32Array(passParameters);
      const f32 = new Float32Array(passParameters);
      u32[0] = width;
      u32[1] = height;
      u32[2] = step.pass;
      u32[3] = controls.dust ? 1 : 0;
      u32[4] = controls.scratches ? 1 : 0;
      f32[5] = controls.denoise;
      f32[6] = controls.sharpen;
      const parameters = this.device.createBuffer({
        size: 32,
        usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
      });
      parameterBuffers.push(parameters);
      this.device.queue.writeBuffer(parameters, 0, new Uint8Array(passParameters));
      const compute = encoder.beginComputePass();
      compute.setPipeline(this.pipeline);
      compute.setBindGroup(0, this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: latest } },
          { binding: 1, resource: { buffer: step.output } },
          { binding: 2, resource: { buffer: parameters } },
        ],
      }));
      compute.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      compute.end();
      latest = step.output;
    }
    if (latest === input) {
      input.destroy();
      ping.destroy();
      pong.destroy();
      for (const buffer of parameterBuffers) buffer.destroy();
      readback.destroy();
      return {
        data: source,
        elapsedMs: performance.now() - startedAt,
        gpuBackend: "webgpu-compute",
      };
    }
    encoder.copyBufferToBuffer(latest, 0, readback, 0, byteLength);
    this.device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPU_MAP_MODE_READ);
    const output = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    input.destroy();
    ping.destroy();
    pong.destroy();
    for (const buffer of parameterBuffers) buffer.destroy();
    readback.destroy();
    return {
      data: output,
      elapsedMs: performance.now() - startedAt,
      gpuBackend: "webgpu-compute",
    };
  }
}

export async function probeWebGpuRestoration(): Promise<boolean> {
  try {
    return await WebGpuRestorationCompute.create() !== undefined;
  } catch {
    return false;
  }
}

export const restorationComputeShader = /* wgsl */ `
struct Parameters {
  width: u32,
  height: u32,
  pass: u32,
  dust: u32,
  scratches: u32,
  denoise: f32,
  sharpen: f32,
  padding: f32,
}

@group(0) @binding(0) var<storage, read> inputPixels: array<f32>;
@group(0) @binding(1) var<storage, read_write> outputPixels: array<f32>;
@group(0) @binding(2) var<uniform> parameters: Parameters;

fn pixelIndex(x: u32, y: u32, channel: u32) -> u32 {
  return (y * parameters.width + x) * 3u + channel;
}

fn sampleRgb(xValue: i32, yValue: i32) -> vec3<f32> {
  let x = u32(clamp(xValue, 0, i32(parameters.width) - 1));
  let y = u32(clamp(yValue, 0, i32(parameters.height) - 1));
  return vec3<f32>(
    inputPixels[pixelIndex(x, y, 0u)],
    inputPixels[pixelIndex(x, y, 1u)],
    inputPixels[pixelIndex(x, y, 2u)]
  );
}

fn luminance(value: vec3<f32>) -> f32 {
  return dot(value, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn storeRgb(x: u32, y: u32, value: vec3<f32>) {
  outputPixels[pixelIndex(x, y, 0u)] = value.r;
  outputPixels[pixelIndex(x, y, 1u)] = value.g;
  outputPixels[pixelIndex(x, y, 2u)] = value.b;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= parameters.width || id.y >= parameters.height) { return; }
  let x = i32(id.x);
  let y = i32(id.y);
  let center = sampleRgb(x, y);
  var result = center;

  if (parameters.pass == 0u) {
    if (parameters.dust != 0u) {
      var sum = vec3<f32>(0.0);
      var deviation = 0.0;
      let centerLuma = luminance(center);
      for (var oy = -1; oy <= 1; oy++) {
        for (var ox = -1; ox <= 1; ox++) {
          if (ox == 0 && oy == 0) { continue; }
          let neighbour = sampleRgb(x + ox, y + oy);
          sum += neighbour;
          deviation += abs(luminance(neighbour) - centerLuma);
        }
      }
      let average = sum / 8.0;
      let required = max(0.01, 3.5 * deviation / 8.0);
      var affected = 0u;
      if (abs(center.r - average.r) >= required) { affected++; }
      if (abs(center.g - average.g) >= required) { affected++; }
      if (abs(center.b - average.b) >= required) { affected++; }
      if (abs(centerLuma - luminance(average)) >= required && affected >= 2u) {
        result = average;
      }
    }
    if (parameters.scratches != 0u) {
      let left = sampleRgb(x - 2, y);
      let right = sampleRgb(x + 2, y);
      let above = sampleRgb(x, y - 2);
      let below = sampleRgb(x, y + 2);
      let horizontal = abs(luminance(result) - (luminance(left) + luminance(right)) * 0.5);
      let vertical = abs(luminance(result) - (luminance(above) + luminance(below)) * 0.5);
      let horizontalRequired = max(0.018, 1.35 * abs(luminance(left) - luminance(right)));
      let verticalRequired = max(0.018, 1.35 * abs(luminance(above) - luminance(below)));
      if (horizontal >= horizontalRequired || vertical >= verticalRequired) {
        result = select((above + below) * 0.5, (left + right) * 0.5, horizontal >= vertical);
      }
    }
  } else if (parameters.pass == 1u || parameters.pass == 2u) {
    let sigma = 0.012 + parameters.denoise * 0.07;
    let denominator = max(2.0 * sigma * sigma, 1e-8);
    var accumulated = vec3<f32>(0.0);
    var weightSum = 0.0;
    for (var offset = -2; offset <= 2; offset++) {
      let sampleValue = select(
        sampleRgb(x, y + offset),
        sampleRgb(x + offset, y),
        parameters.pass == 1u
      );
      let distance = abs(offset);
      let spatial = select(select(0.3246525, 0.7548396, distance == 1), 1.0, distance == 0);
      let difference = luminance(sampleValue) - luminance(center);
      let weight = spatial * exp(-(difference * difference) / denominator);
      accumulated += sampleValue * weight;
      weightSum += weight;
    }
    result = accumulated / max(weightSum, 1e-8);
  } else if (parameters.pass == 3u) {
    let blurred = (
      sampleRgb(x - 1, y - 1) + 2.0 * sampleRgb(x, y - 1) + sampleRgb(x + 1, y - 1)
      + 2.0 * sampleRgb(x - 1, y) + 4.0 * center + 2.0 * sampleRgb(x + 1, y)
      + sampleRgb(x - 1, y + 1) + 2.0 * sampleRgb(x, y + 1) + sampleRgb(x + 1, y + 1)
    ) / 16.0;
    let detail = center - blurred;
    result = select(center, center + parameters.sharpen * detail, abs(detail) >= vec3<f32>(0.004));
  }
  storeRgb(id.x, id.y, result);
}
`;
