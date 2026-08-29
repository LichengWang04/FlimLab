import assert from "node:assert/strict";
import { describe, it } from "node:test";
import electronViteConfig from "../electron.vite.config.ts";
import { DEFAULT_NEGADOCTOR_56, DEFAULT_RECIPE } from "../src/core/index.ts";
import { classicSceneKey } from "../src/renderer/src/gpu-preview.ts";
import { WebGpuPreviewClient } from "../src/renderer/src/webgpu/webgpu-client.ts";
import { createWebGpuRenderParameters } from "../src/renderer/src/webgpu/params.ts";
import { evaluateWebGpuPrerequisites } from "../src/renderer/src/webgpu/protocol.ts";
import { WEBGPU_PREVIEW_SHADER } from "../src/renderer/src/webgpu/shader.ts";
import { promotePreviewToSharedSurface } from "../src/renderer/src/shared-surface.ts";
import {
  applyRendererIsolationHeaders,
  RENDERER_ISOLATION_HEADERS,
} from "../src/shared/renderer-isolation.ts";

describe("GPU preview contract", () => {
  it("does not require shared memory for an otherwise usable WebGPU path", () => {
    assert.deepEqual(evaluateWebGpuPrerequisites(false, true), {
      available: true,
      sharedArrayBuffer: false,
      offscreenCanvas: true,
    });
    assert.deepEqual(evaluateWebGpuPrerequisites(true, false), {
      available: false,
      sharedArrayBuffer: true,
      offscreenCanvas: false,
      reason: "OffscreenCanvas 不可用。",
    });
  });

  it("transfers an owned ArrayBuffer copy without detaching the cached source", async () => {
    let received: unknown;
    const diagnostics = {
      h2dBytes: 3 * Float32Array.BYTES_PER_ELEMENT,
      d2hBytes: 0,
      sourceUploads: 1,
      dispatches: 0,
      gpuMs: 0,
      tileCount: 0,
    };
    const worker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage(message: unknown, transfer: Transferable[] = []) {
        received = structuredClone(message, { transfer });
        const request = received as { requestId: number };
        queueMicrotask(() => worker.onmessage?.({
          data: { kind: "registered", requestId: request.requestId, id: "frame", diagnostics },
        } as MessageEvent));
      },
      terminate() {},
    };
    const client = new WebGpuPreviewClient(() => worker);
    const raster = new Float32Array([0.1, 0.2, 0.3]);
    const originalBuffer = raster.buffer;
    try {
      assert.deepEqual(await client.registerSource("frame", 1, 1, raster), diagnostics);
      assert.equal(raster.buffer, originalBuffer);
      assert.equal(raster.byteLength, diagnostics.h2dBytes);
      const request = received as { raster: Float32Array };
      assert.deepEqual(request.raster, raster);
      assert.notEqual(request.raster.buffer, originalBuffer);
    } finally {
      client.terminate();
    }
  });

  it("promotes the cloneable Electron IPC payload to one shared renderer surface", () => {
    const original = new Float32Array([0.1, 0.2, 0.3]);
    const promoted = promotePreviewToSharedSurface({
      id: "frame",
      fileName: "frame.tiff",
      width: 1,
      height: 1,
      depth: 16,
      hasIcc: false,
      format: "tiff",
      raster: original,
    });
    assert.ok(promoted.raster.buffer instanceof SharedArrayBuffer);
    assert.deepEqual(promoted.raster, original);
    assert.notEqual(promoted.raster.buffer, original.buffer);
    assert.equal(promotePreviewToSharedSurface(promoted), promoted);
  });

  it("keeps an ordinary ArrayBuffer when SharedArrayBuffer is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "SharedArrayBuffer");
    assert.ok(descriptor !== undefined);
    try {
      Object.defineProperty(globalThis, "SharedArrayBuffer", {
        configurable: true,
        writable: true,
        value: undefined,
      });
      const original = new Float32Array([0.1, 0.2, 0.3]);
      const preview = {
        id: "frame",
        fileName: "frame.tiff",
        width: 1,
        height: 1,
        depth: 16 as const,
        hasIcc: false,
        format: "tiff",
        raster: original,
      };
      assert.equal(promotePreviewToSharedSurface(preview), preview);
      assert.deepEqual(preview.raster, original);
    } finally {
      Object.defineProperty(globalThis, "SharedArrayBuffer", descriptor);
    }
  });

  it("uses the same isolation headers for Vite development and packaged responses", () => {
    const config = electronViteConfig as {
      renderer?: { server?: { headers?: Readonly<Record<string, string>> } };
    };
    assert.equal(config.renderer?.server?.headers, RENDERER_ISOLATION_HEADERS);
    const headers = applyRendererIsolationHeaders(new Headers({ "Content-Type": "text/html" }));
    for (const [name, value] of Object.entries(RENDERER_ISOLATION_HEADERS)) {
      assert.equal(headers.get(name), value);
    }
    assert.equal(headers.get("Content-Type"), "text/html");
  });

  it("keeps tone-only adjustments on one resident scene texture", () => {
    const baseline = classicSceneKey(DEFAULT_RECIPE);
    for (const recipe of [
      { ...DEFAULT_RECIPE, exposure: 1 },
      { ...DEFAULT_RECIPE, contrast: 1.3 },
      { ...DEFAULT_RECIPE, highlightCompression: 0.8 },
      { ...DEFAULT_RECIPE, saturation: 1.6 },
    ]) assert.equal(classicSceneKey(recipe), baseline);
    assert.notEqual(classicSceneKey({ ...DEFAULT_RECIPE, preSaturation: 1.4 }), baseline);
  });

  it("keeps every accelerated stage in the single WebGPU shader", () => {
    assert.match(WEBGPU_PREVIEW_SHADER, /exp2\(p\(32u\)\)/);
    assert.match(WEBGPU_PREVIEW_SHADER, /fn classic/);
    assert.match(WEBGPU_PREVIEW_SHADER, /fn negadoctor/);
    assert.match(WEBGPU_PREVIEW_SHADER, /fn linear_to_srgb/);
    assert.doesNotMatch(WEBGPU_PREVIEW_SHADER, /#version 300 es/);
  });

  it("packs canonical classic analysis and geometry into the WebGPU contract", () => {
    const recipe = { ...DEFAULT_RECIPE, rotate: 90, crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 } };
    const packed = createWebGpuRenderParameters(80, 40, recipe, {
      base: { rgb: [1, 0.7, 0.5], confidence: 1, method: "manual", sampleCount: 1 },
      anchors: { dmin: 0, dmax: 2, range: 2, channelFit: { offset: [0.1, 0.2, 0.3], slope: [1, 2, 3] } },
      whitePoint: 4,
      gains: [1, 1.1, 0.9],
    });
    assert.equal(packed.values[4], 1);
    assert.equal(packed.values[12], 0);
    assert.equal(packed.values[19], 1);
    assert.equal(packed.values[31], 4);
    assert.deepEqual([packed.width, packed.height], [20, 40]);
  });

  it("packs all thirteen fitted curve points instead of dropping the origin anchor", () => {
    const input = Array.from({ length: 13 }, (_, index) => index * 0.25);
    const output = input.map((value) => value + 0.05);
    const packed = createWebGpuRenderParameters(16, 12, DEFAULT_RECIPE, {
      base: { rgb: [1, 0.8, 0.6], confidence: 1, method: "manual", sampleCount: 1 },
      anchors: {
        dmin: 0,
        dmax: 2,
        range: 2,
        channelFit: { offset: [0.01, 0.02, 0.03], slope: [1, 1, 1] },
        channelCurves: [
          { input, output },
          { input: input.slice(0, 5), output: output.slice(0, 5) },
          { input: input.slice(0, 9), output: output.slice(0, 9) },
        ],
      },
      whitePoint: 1,
      gains: [1, 1, 1],
    });
    const counts = [13, 5, 9];
    for (const channel of [0, 1, 2] as const) {
      const count = counts[channel]!;
      const start = 64 + channel * 27;
      assert.equal(packed.values[start], count);
      assert.equal(packed.values[start + count], Math.fround(input[count - 1]!));
      assert.equal(packed.values[start + 14 + count - 1], Math.fround(output[count - 1]!));
    }
    assert.ok(packed.values.length >= 64 + 27 * 3);
    assert.match(WEBGPU_PREVIEW_SHADER, /64u \+ channel \* 27u/);
    assert.doesNotMatch(WEBGPU_PREVIEW_SHADER, /channel \* 25u/);
  });

  it("packs Negadoctor working-space controls and keeps display readback out of WGSL", () => {
    const packed = createWebGpuRenderParameters(16, 12, DEFAULT_NEGADOCTOR_56, {
      base: { rgb: [1, 0.5, 0.25], confidence: 1, method: "manual", sampleCount: 0 },
      anchors: { dmin: 0, dmax: 2, range: 2 },
      whitePoint: 1,
      gains: [1, 1, 1],
    });
    assert.equal(packed.values[12], 1);
    assert.equal(packed.values[15], 1);
    assert.equal(packed.values[48], DEFAULT_NEGADOCTOR_56.paperGrade);
    assert.match(WEBGPU_PREVIEW_SHADER, /fn sample_geometry/);
    assert.match(WEBGPU_PREVIEW_SHADER, /ratio != ratio/);
    assert.doesNotMatch(WEBGPU_PREVIEW_SHADER, /copyTextureToBuffer|readPixels/);
  });
});
