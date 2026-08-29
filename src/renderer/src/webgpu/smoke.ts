import { DEFAULT_RECIPE } from "../../../core/index.ts";
import { WebGpuPreviewClient } from "./webgpu-client.ts";

/** Production-bundle smoke. Shader validation and queue completion are the
 * assertion; display readback is deliberately forbidden here. */
export async function runWebGpuPreviewSmoke(transport: "shared" | "array-buffer" = "shared"): Promise<string> {
  const client = new WebGpuPreviewClient();
  try {
    const capabilities = await client.probe();
    if (!capabilities.available) throw new Error(capabilities.reason ?? "WebGPU unavailable");
    await client.attach(new OffscreenCanvas(64, 48));
    const byteLength = 64 * 48 * 3 * Float32Array.BYTES_PER_ELEMENT;
    const SharedBuffer = globalThis.SharedArrayBuffer;
    let sourceBuffer: ArrayBuffer | SharedArrayBuffer;
    if (transport === "shared") {
      if (SharedBuffer === undefined) throw new Error("SharedArrayBuffer smoke transport unavailable");
      sourceBuffer = new SharedBuffer(byteLength);
    } else {
      sourceBuffer = new ArrayBuffer(byteLength);
    }
    const raster = new Float32Array(sourceBuffer);
    for (let offset = 0; offset < raster.length; offset += 3) {
      raster[offset] = 0.45;
      raster[offset + 1] = 0.28;
      raster[offset + 2] = 0.18;
    }
    const registered = await client.registerSource("smoke", 64, 48, raster);
    if (raster.byteLength !== byteLength) throw new Error("source raster was detached during registration");
    const rendered = await client.render("smoke", 1, DEFAULT_RECIPE, {
      base: { rgb: [1, 0.7, 0.5], confidence: 1, method: "manual", sampleCount: 64 },
      anchors: { dmin: 0, dmax: 2, range: 2 },
      whitePoint: 1,
      gains: [1, 1, 1],
    });
    if (registered.sourceUploads !== 1 || rendered.diagnostics.sourceUploads !== 1) {
      throw new Error("source upload counter was not exactly one");
    }
    if (rendered.diagnostics.d2hBytes !== 0 || rendered.diagnostics.dispatches !== 1) {
      throw new Error("display path violated its zero-readback contract");
    }
    return `webgpu transport=${transport} adapter=${capabilities.adapter} h2d=${rendered.diagnostics.h2dBytes} d2h=0`;
  } finally {
    client.terminate();
  }
}
