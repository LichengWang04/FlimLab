/// <reference lib="webworker" />

import { encode8, processNegative, Raster, srgbOetf } from "../../core/index.ts";
import type { PreviewWorkerRequest, PreviewWorkerResponse } from "./preview-worker-protocol.ts";
import { PreviewSourceCache } from "./preview-source-cache.ts";

const sources = new PreviewSourceCache();

self.onmessage = (event: MessageEvent<PreviewWorkerRequest>) => {
  const message = event.data;
  if (message.kind === "register") {
    sources.register(message.id, new Raster(message.width, message.height, "transmission-linear", message.raster));
    return;
  }
  if (message.kind === "release") {
    sources.release(message.id);
    return;
  }
  if (message.kind === "clear") {
    sources.clear();
    return;
  }

  const started = performance.now();
  try {
    if (message.kind === "thumbnail") {
      const source = new Raster(message.width, message.height, "transmission-linear", message.raster);
      let rgba: Uint8ClampedArray<ArrayBuffer>;
      let width = source.width;
      let height = source.height;
      try {
        const { display } = processNegative(source, message.recipe);
        width = display.width;
        height = display.height;
        rgba = toRgba(encode8(display));
      } catch {
        const bytes = new Uint8Array(source.data.length);
        for (let index = 0; index < source.data.length; index += 1) {
          bytes[index] = Math.round(srgbOetf(source.data[index]!) * 255);
        }
        rgba = toRgba(bytes);
      }
      const response: PreviewWorkerResponse = {
        kind: "thumbnail",
        requestId: message.requestId,
        id: message.id,
        result: { rgba, width, height },
      };
      self.postMessage(response, { transfer: [rgba.buffer] });
      return;
    }

    const entry = sources.activate(message.id);
    if (entry === undefined) {
      const response: PreviewWorkerResponse = {
        kind: "error",
        requestId: message.requestId,
        revision: message.revision,
        id: message.id,
        message: "预览源已被缓存释放，请重新载入。",
        missingSource: true,
      };
      self.postMessage(response);
      return;
    }
    if (message.kind === "prepare-gpu") {
      const prepared = entry.session.prepareGpu(message.recipe);
      const response: PreviewWorkerResponse = {
        kind: "gpu-prepared",
        requestId: message.requestId,
        revision: message.revision,
        id: message.id,
        result: {
          width: prepared.width,
          height: prepared.height,
          base: prepared.base,
          anchors: prepared.anchors,
          whitePoint: prepared.whitePoint,
          gains: prepared.gains,
          ...(prepared.autoGains === undefined ? {} : { autoGains: prepared.autoGains }),
          ms: performance.now() - started,
          cacheStats: { ...entry.session.stats },
        },
      };
      self.postMessage(response);
      return;
    }
    const processed = entry.session.processPreview(message.recipe);
    const rgba = processed.rgba;
    const response: PreviewWorkerResponse = {
      kind: "preview",
      requestId: message.requestId,
      revision: message.revision,
      id: message.id,
      result: {
        rgba,
        width: processed.width,
        height: processed.height,
        base: processed.base,
        anchors: processed.anchors,
        whitePoint: processed.whitePoint,
        ...(processed.autoGains === undefined ? {} : { autoGains: processed.autoGains }),
        ms: performance.now() - started,
        cacheStats: { ...entry.session.stats },
      },
    };
    self.postMessage(response, { transfer: [rgba.buffer] });
  } catch (error) {
    const response: PreviewWorkerResponse = {
      kind: "error",
      requestId: message.requestId,
      ...(message.kind === "process" || message.kind === "prepare-gpu" ? { revision: message.revision } : {}),
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

function toRgba(bytes: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(bytes.length / 3 * 4);
  for (let source = 0, target = 0; source < bytes.length; source += 3, target += 4) {
    rgba[target] = bytes[source]!;
    rgba[target + 1] = bytes[source + 1]!;
    rgba[target + 2] = bytes[source + 2]!;
    rgba[target + 3] = 255;
  }
  return rgba;
}
