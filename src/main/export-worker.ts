import { availableParallelism } from "node:os";
import { Worker, parentPort, workerData } from "node:worker_threads";
import sharp from "sharp";
import {
  estimateFilmBase,
  estimateWhiteBalance,
  estimateWhitePoint,
  createGeometryPlan,
  measureDensityAnchors,
  negadoctorInputPrimaries,
  sampleFilmBase,
  Raster,
  temperatureToGains,
  validateInvertParameters,
  validateToneParameters,
  validateNegadoctor56,
  workingPrimaries,
} from "../core/index.ts";
import type { Recipe, Rgb } from "../core/index.ts";
import type { SingleExportResult } from "../shared/ipc.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { decodeSource, probeSource } from "./decode.ts";
import { renderPositive } from "./export.ts";
import { executeKernelTask } from "./parallel-kernel.ts";
import type { KernelAction, KernelTask } from "./parallel-kernel.ts";
import { writeTiff16 } from "./tiff-write.ts";
import { assertExportCapacity, friendlyProcessingError } from "./resource-limits.ts";
import { assertProcessingMemory } from "./processing-memory.ts";
import { PixelWorkerCircuitBreaker, PixelWorkerFailure } from "./pixel-worker-health.ts";

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

const { pixelWorkerPath, workerCountOverride } = workerData as { pixelWorkerPath: string; workerCountOverride?: number };
const workerCount = workerCountOverride === undefined
  ? Math.min(10, Math.max(1, availableParallelism() - 2))
  : Math.max(1, Math.min(12, Math.trunc(workerCountOverride)));
let workers: Worker[] = [];
let workerFailure: PixelWorkerFailure | undefined;
const workerCircuit = new PixelWorkerCircuitBreaker();
let taskSequence = 0;

if (parentPort === null) throw new Error("Export worker requires a parent port.");

parentPort.on("message", async (request: ExportWorkerRequest) => {
  let parallel = false;
  let result: SingleExportResult;
  try {
    result = await renderParallel(request);
    parallel = workers.length > 0;
    if (parallel) workerCircuit.recordSuccess();
  } catch (error) {
    if (error instanceof PixelWorkerFailure) {
      disablePixelWorkers();
      workerCircuit.recordFailure();
      // Re-decode and run the canonical pipeline in this background thread.
      // A partially transformed shared buffer is never reused after a failure.
      result = await renderPositive(request.sourcePath, request.recipe, request.format, request.outPath);
    } else {
      result = { ok: false, message: friendlyProcessingError(error) };
    }
  }
  const response: ExportWorkerResponse = { jobId: request.jobId, result, parallel };
  parentPort!.postMessage(response);
});

async function renderParallel(request: ExportWorkerRequest): Promise<SingleExportResult> {
  const meta = await probeSource(request.sourcePath);
  const geometryPlan = createGeometryPlan(meta.width, meta.height, request.recipe.rotate, request.recipe.crop);
  const pixelCount = geometryPlan.width * geometryPlan.height;
  await assertExportCapacity(request.outPath, geometryPlan.width, geometryPlan.height, request.format);
  const identityGeometry = isIdentityGeometry(geometryPlan);
  assertProcessingMemory({
    sourceWidth: meta.width,
    sourceHeight: meta.height,
    targetWidth: geometryPlan.width,
    targetHeight: geometryPlan.height,
    sourceDepth: meta.depth,
    sourceFormat: meta.format,
    format: request.format,
    identityGeometry,
  });
  // Do not create the parallel pool until metadata, disk and memory preflight
  // have all succeeded. A rejected job performs no decode or partial write.
  ensurePixelWorkers(desiredWorkerCount(pixelCount));
  const { raster } = await decodeSource(
    request.sourcePath,
    undefined,
    (length) => new Float32Array(new SharedArrayBuffer(length * Float32Array.BYTES_PER_ELEMENT)),
  );
  const sourcePixels = raster.data.buffer as SharedArrayBuffer;
  const sharedPixels = identityGeometry
    ? sourcePixels
    : new SharedArrayBuffer(geometryPlan.width * geometryPlan.height * 3 * Float32Array.BYTES_PER_ELEMENT);
  if (!identityGeometry) {
    await runKernel("geometry", geometryPlan.width, pixelCount, sharedPixels, {
      source: sourcePixels,
      geometryPlan,
    });
  }
  const pixels = new Float32Array(sharedPixels);
  const framed = new Raster(geometryPlan.width, geometryPlan.height, "transmission-linear", pixels);
  let whitePoint: number | undefined;
  if (request.recipe.engine === "negadoctor-5.6") {
    validateNegadoctor56(request.recipe);
    const working = workingPrimaries(request.recipe.workingSpace);
    await runKernel("primaries", framed.width, pixelCount, sharedPixels, {
      fromPrimaries: negadoctorInputPrimaries(request.recipe, meta.format),
      toPrimaries: working,
    });
    const base = request.recipe.baseMode === "manual"
      ? { rgb: request.recipe.dminRgb, confidence: 1, method: "manual" as const, sampleCount: 0 }
      : request.recipe.baseMode === "roi" && request.recipe.baseRoi !== undefined
        ? sampleFilmBase(framed, request.recipe.baseRoi)
        : estimateFilmBase(framed);
    const dmin: Rgb = request.recipe.filmStock === "black-and-white"
      ? [base.rgb[0], base.rgb[0], base.rgb[0]]
      : [...base.rgb];
    await runKernel("negadoctor", framed.width, pixelCount, sharedPixels, {
      base: dmin,
      negadoctorRecipe: request.recipe,
    });
    if (working === "rec2020") {
      await runKernel("primaries", framed.width, pixelCount, sharedPixels, {
        fromPrimaries: "rec2020",
        toPrimaries: "srgb",
      });
    }
  } else {
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
    whitePoint = estimateWhitePoint(scene);
    validateToneParameters(request.recipe);
  }

  if (request.format === "tiff") {
    const output = new SharedArrayBuffer(pixelCount * 3 * Uint16Array.BYTES_PER_ELEMENT);
    await runKernel(request.recipe.engine === "classic" ? "toneEncode16" : "encode16", framed.width, pixelCount, sharedPixels, {
      output,
      recipe: request.recipe,
      whitePoint,
    });
    await writeTiff16(request.outPath, framed.width, framed.height, new Uint16Array(output));
  } else {
    const output = new SharedArrayBuffer(pixelCount * 3);
    await runKernel(request.recipe.engine === "classic" ? "toneEncode8" : "encode8", framed.width, pixelCount, sharedPixels, {
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

function isIdentityGeometry(plan: ReturnType<typeof createGeometryPlan>): boolean {
  return plan.quarter === 0 && plan.residualRadians === 0
    && plan.cropX === 0 && plan.cropY === 0
    && plan.width === plan.sourceWidth && plan.height === plan.sourceHeight;
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
  const activeWorkerCount = Math.min(workers.length, desiredWorkerCount(pixelCount));
  if (activeWorkerCount <= 1) {
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
  await Promise.all(workers.slice(0, activeWorkerCount).map(async (worker) => {
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

function desiredWorkerCount(pixelCount: number): number {
  if (pixelCount < 4_000_000) return 1;
  return Math.min(workerCount, Math.max(2, Math.floor(pixelCount / 2_000_000)));
}

function ensurePixelWorkers(desired: number): void {
  if (workers.length >= desired || desired <= 1 || !workerCircuit.canCreatePool) return;
  const created: Worker[] = [];
  try {
    for (let index = workers.length; index < desired; index += 1) {
      const worker = new Worker(pixelWorkerPath);
      worker.on("error", (error) => {
        if (workers.includes(worker)) workerFailure ??= new PixelWorkerFailure("Pixel worker error.", error);
      });
      worker.on("exit", (code) => {
        if (code !== 0 && workers.includes(worker)) {
          workerFailure ??= new PixelWorkerFailure(`Pixel worker exited with code ${code}.`);
        }
      });
      created.push(worker);
    }
    workers.push(...created);
    workerFailure = undefined;
  } catch (error) {
    for (const worker of created) void worker.terminate();
    throw new PixelWorkerFailure("Pixel worker pool could not be created.", error);
  }
}

process.once("exit", disablePixelWorkers);

function dispatch(worker: Worker, task: KernelTask): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: { taskId: number; ok: boolean; message?: string }) => {
      if (message.taskId !== task.taskId) return;
      cleanup();
      if (message.ok) resolve();
      // A well-formed response carrying a task error proves that transport and
      // Worker lifecycle are healthy. Preserve it as a user/pipeline failure.
      else reject(new Error(message.message ?? "Pixel worker task failed."));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new PixelWorkerFailure("Pixel worker error.", error));
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new PixelWorkerFailure(`Pixel worker exited with code ${code}.`));
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    try {
      worker.postMessage(task);
    } catch (error) {
      cleanup();
      reject(new PixelWorkerFailure("Pixel worker message could not be sent.", error));
    }
  });
}
