import { availableParallelism } from "node:os";
import { Worker, parentPort, workerData } from "node:worker_threads";
import sharp from "sharp";
import {
  estimateFilmBase,
  estimateWhiteBalance,
  estimateWhitePoint,
  createGeometryPlan,
  measureDensityAnchors,
  sampleFilmBase,
  Raster,
  temperatureToGains,
  validateInvertParameters,
  validateToneParameters,
} from "../core/index.ts";
import type { Recipe, Rgb } from "../core/index.ts";
import type { SingleExportResult } from "../shared/ipc.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { decodeSource } from "./decode.ts";
import { renderPositive } from "./export.ts";
import { executeKernelTask } from "./parallel-kernel.ts";
import type { KernelAction, KernelTask } from "./parallel-kernel.ts";
import { writeTiff16 } from "./tiff-write.ts";
import { assertExportCapacity } from "./resource-limits.ts";

interface ExportWorkerRequest {
  jobId: number;
  sourcePath: string;
  recipe: Recipe;
  format: "tiff" | "jpeg";
  outPath: string;
}

interface ExportWorkerResponse {
  jobId: number;
  result: SingleExportResult;
  parallel: boolean;
}

const workerCount = Math.min(4, Math.max(1, availableParallelism() - 2));
const { pixelWorkerPath } = workerData as { pixelWorkerPath: string };
let workers = workerCount > 1
  ? Array.from({ length: workerCount }, () => new Worker(pixelWorkerPath))
  : [];
let workerFailure: Error | undefined;
for (const worker of workers) {
  worker.on("error", (error) => {
    if (workers.includes(worker)) workerFailure ??= error;
  });
  worker.on("exit", (code) => {
    if (code !== 0 && workers.includes(worker)) {
      workerFailure ??= new Error(`Pixel worker exited with code ${code}.`);
    }
  });
}
let taskSequence = 0;

if (parentPort === null) throw new Error("Export worker requires a parent port.");

parentPort.on("message", async (request: ExportWorkerRequest) => {
  let parallel = false;
  let result: SingleExportResult;
  try {
    result = await renderParallel(request);
    parallel = workers.length > 0;
  } catch {
    disablePixelWorkers();
    // Re-decode and run the canonical pipeline in this background thread.
    // A partially transformed shared buffer is never reused after a failure.
    result = await renderPositive(request.sourcePath, request.recipe, request.format, request.outPath);
  }
  const response: ExportWorkerResponse = { jobId: request.jobId, result, parallel };
  parentPort!.postMessage(response);
});

async function renderParallel(request: ExportWorkerRequest): Promise<SingleExportResult> {
  const { raster } = await decodeSource(request.sourcePath);
  const geometryPlan = createGeometryPlan(raster.width, raster.height, request.recipe.rotate, request.recipe.crop);
  const sourcePixels = new SharedArrayBuffer(raster.data.byteLength);
  new Float32Array(sourcePixels).set(raster.data);
  const sharedPixels = new SharedArrayBuffer(geometryPlan.width * geometryPlan.height * 3 * Float32Array.BYTES_PER_ELEMENT);
  const pixelCount = geometryPlan.width * geometryPlan.height;
  await assertExportCapacity(request.outPath, geometryPlan.width, geometryPlan.height, request.format);
  await runKernel("geometry", geometryPlan.width, pixelCount, sharedPixels, {
    source: sourcePixels,
    geometryPlan,
  });
  const pixels = new Float32Array(sharedPixels);
  const framed = new Raster(geometryPlan.width, geometryPlan.height, "transmission-linear", pixels);
  const base = request.recipe.baseMode === "roi" && request.recipe.baseRoi !== undefined
    ? sampleFilmBase(framed, request.recipe.baseRoi)
    : estimateFilmBase(framed);

  await runKernel("density", framed.width, pixelCount, sharedPixels, { base: base.rgb });
  const density = new Raster(framed.width, framed.height, "relative-density", pixels);
  const anchors = measureDensityAnchors(base.rgb, density, 0.995, {
    dmaxOverride: request.recipe.dmaxMode === "manual" ? request.recipe.manualDmax : undefined,
    neutralRoi: request.recipe.autoNeutralize ? request.recipe.neutralRoi : undefined,
    autoNeutralize: request.recipe.autoNeutralize,
  });
  validateInvertParameters(anchors, request.recipe.preSaturation);
  await runKernel("invert", framed.width, pixelCount, sharedPixels, {
    anchors,
    preSaturation: request.recipe.preSaturation,
  });

  const inverted = new Raster(framed.width, framed.height, "scene-linear-rgb", pixels);
  const gains: Rgb = request.recipe.autoWhiteBalance
    ? estimateWhiteBalance(inverted)
    : temperatureToGains(request.recipe.temperatureKelvin);
  await runKernel("gains", framed.width, pixelCount, sharedPixels, { gains });
  const scene = new Raster(framed.width, framed.height, "scene-linear-rgb", pixels);
  const whitePoint = estimateWhitePoint(scene);
  validateToneParameters(request.recipe);

  if (request.format === "tiff") {
    const output = new SharedArrayBuffer(pixelCount * 3 * Uint16Array.BYTES_PER_ELEMENT);
    await runKernel("toneEncode16", framed.width, pixelCount, sharedPixels, {
      output,
      recipe: request.recipe,
      whitePoint,
    });
    const encoded = new Uint16Array(pixelCount * 3);
    encoded.set(new Uint16Array(output));
    await writeTiff16(request.outPath, framed.width, framed.height, encoded);
  } else {
    const output = new SharedArrayBuffer(pixelCount * 3);
    await runKernel("toneEncode8", framed.width, pixelCount, sharedPixels, {
      output,
      recipe: request.recipe,
      whitePoint,
    });
    const encoded = await sharp(Buffer.from(new Uint8Array(output)), {
      raw: { width: framed.width, height: framed.height, channels: 3 },
    }).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
    await writeFileAtomic(request.outPath, encoded);
  }
  return { ok: true, path: request.outPath };
}

type KernelParameters = Omit<KernelTask, "taskId" | "action" | "startPixel" | "endPixel" | "pixels">;

async function runKernel(
  action: KernelAction,
  width: number,
  pixelCount: number,
  pixels: SharedArrayBuffer,
  parameters: KernelParameters,
): Promise<void> {
  if (workerFailure !== undefined) throw workerFailure;
  if (pixelCount < 1_000_000 || workers.length === 0) {
    executeKernelTask({
      taskId: ++taskSequence,
      action,
      startPixel: 0,
      endPixel: pixelCount,
      pixels,
      ...parameters,
    });
    return;
  }

  const tilePixels = Math.max(1, width) * 128;
  const ranges: { start: number; end: number }[] = [];
  for (let start = 0; start < pixelCount; start += tilePixels) {
    ranges.push({ start, end: Math.min(pixelCount, start + tilePixels) });
  }
  let next = 0;
  await Promise.all(workers.map(async (worker) => {
    while (next < ranges.length) {
      const range = ranges[next++]!;
      const task: KernelTask = {
        taskId: ++taskSequence,
        action,
        startPixel: range.start,
        endPixel: range.end,
        pixels,
        ...parameters,
      };
      await dispatch(worker, task);
    }
  }));
}

function disablePixelWorkers(): void {
  for (const worker of workers) void worker.terminate();
  workers = [];
  workerFailure = undefined;
}

process.once("exit", disablePixelWorkers);

function dispatch(worker: Worker, task: KernelTask): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: { taskId: number; ok: boolean; message?: string }) => {
      if (message.taskId !== task.taskId) return;
      cleanup();
      if (message.ok) resolve();
      else reject(new Error(message.message ?? "Pixel worker failed."));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`Pixel worker exited with code ${code}.`));
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    worker.postMessage(task);
  });
}
