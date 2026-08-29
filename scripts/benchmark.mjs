import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import {
  DEFAULT_NEGADOCTOR_56,
  DEFAULT_RECIPE,
  downscaleRaster,
  NegativeSession,
  Raster,
} from "../src/core/index.ts";
import { renderPositive } from "../src/main/export.ts";
import { decodeSource } from "../src/main/decode.ts";
import { readTiff, readTiffRaster } from "../src/main/tiff-decode.ts";
import { writeTiff16 } from "../src/main/tiff-write.ts";

const quick = process.argv.includes("--quick");
const parallelOnly = process.argv.includes("--parallel-only");
const includeDecode = process.argv.includes("--include-decode");
const workerCount = Number(process.argv.find((argument) => argument.startsWith("--workers="))?.slice("--workers=".length) ?? 4);
const temp = await fs.mkdtemp(join(tmpdir(), "filmlab-benchmark-"));

try {
  const preview = makeNegative(1600, 1067);
  const session = new NegativeSession(preview);
  const cold = measure(() => session.processPreview(DEFAULT_RECIPE));
  const hot = measure(() => session.processPreview({ ...DEFAULT_RECIPE, exposure: 0.2 }));
  const hotRatio = hot.ms / cold.ms;

  console.log(`preview cold (including RGBA encode): ${cold.ms.toFixed(1)} ms`);
  console.log(`preview tone-only hot: ${hot.ms.toFixed(1)} ms (${(hotRatio * 100).toFixed(1)}% of cold)`);
  console.log(`preview encoded hash: ${hash(hot.value.rgba)}`);

  const negadoctorSession = new NegativeSession(preview);
  const negadoctorCold = measure(() => negadoctorSession.processPreview(DEFAULT_NEGADOCTOR_56));
  const negadoctorHot = measure(() => negadoctorSession.processPreview({ ...DEFAULT_NEGADOCTOR_56, printExposure: 0.95 }));
  console.log(`Negadoctor preview cold: ${negadoctorCold.ms.toFixed(1)} ms`);
  console.log(`Negadoctor print-control hot: ${negadoctorHot.ms.toFixed(1)} ms (${(negadoctorHot.ms / negadoctorCold.ms * 100).toFixed(1)}% of cold)`);
  console.log(`Negadoctor encoded hash: ${hash(negadoctorHot.value.rgba)}`);

  const width = quick ? 1600 : 6000;
  const height = quick ? 1067 : 4000;
  console.log(`export fixture: ${width}x${height} (${(width * height / 1_000_000).toFixed(1)} MP)`);
  const input = join(temp, "negative.tiff");
  const canonicalPath = join(temp, "canonical.tiff");
  const parallelPath = join(temp, "parallel.tiff");
  const raw = makeNegative16(width, height);
  await writeTiff16(input, width, height, raw);

  if (includeDecode) {
    const legacyPreview = await measureAsync(async () => {
      const full = await readTiffRaster(input);
      return downscaleRaster(new Raster(width, height, "transmission-linear", full.data), 1600);
    });
    const streamingPreview = await measureAsync(async () => (await decodeSource(input, 1600)).raster);
    if (!Buffer.from(legacyPreview.value.data.buffer).equals(Buffer.from(streamingPreview.value.data.buffer))) {
      throw new Error("Streaming TIFF preview differs from full decode plus area-average downscale.");
    }
    const fullBytes = width * height * 3 * Float32Array.BYTES_PER_ELEMENT;
    const previewBytes = longestSide(width, height) <= 1600
      ? streamingPreview.value.data.byteLength
      : streamingPreview.value.data.byteLength * (1 + Float64Array.BYTES_PER_ELEMENT / Float32Array.BYTES_PER_ELEMENT);
    console.log(`TIFF preview legacy full-raster: ${legacyPreview.ms.toFixed(1)} ms, ${(fullBytes / 2 ** 20).toFixed(1)} MiB raster`);
    console.log(`TIFF preview streaming: ${streamingPreview.ms.toFixed(1)} ms, ${(previewBytes / 2 ** 20).toFixed(1)} MiB sums+raster`);
    console.log(`TIFF preview parity: Float32 byte-identical, ${hash(streamingPreview.value.data)}`);
  }

  const canonical = parallelOnly
    ? undefined
    : await measureAsync(() => renderPositive(input, DEFAULT_RECIPE, "tiff", canonicalPath));
  if (canonical !== undefined && !canonical.value.ok) throw new Error(canonical.value.message);

  const bundles = await fs.readdir(join(process.cwd(), "out", "main"));
  const coordinatorName = bundles.find((name) => /^export-worker-.+\.js$/.test(name));
  const pixelName = bundles.find((name) => /^pixel-worker-.+\.js$/.test(name));
  if (coordinatorName === undefined || pixelName === undefined) {
    throw new Error("Worker bundles are missing; run npm.cmd run build before this benchmark.");
  }
  const coordinatorPath = join(process.cwd(), "out", "main", coordinatorName);
  const pixelPath = join(process.cwd(), "out", "main", pixelName);
  const parallel = await measureAsync(() => runExportWorker(coordinatorPath, pixelPath, input, parallelPath, workerCount));
  if (!parallel.value.ok) throw new Error(parallel.value.message);

  const parallelImage = await readTiff(parallelPath);
  const right = Buffer.from(parallelImage.pixels.buffer, parallelImage.pixels.byteOffset, parallelImage.pixels.byteLength);
  if (canonical !== undefined) {
    const canonicalImage = await readTiff(canonicalPath);
    const left = Buffer.from(canonicalImage.pixels.buffer, canonicalImage.pixels.byteOffset, canonicalImage.pixels.byteLength);
    if (!left.equals(right)) throw new Error("Parallel 16-bit export differs from the canonical output.");
    console.log(`canonical export: ${canonical.ms.toFixed(1)} ms`);
    console.log(`parallel export (${workerCount} pixel workers): ${parallel.ms.toFixed(1)} ms (${(canonical.ms / parallel.ms).toFixed(2)}x)`);
    console.log(`parallel parity: byte-identical, ${hash(right)}`);
  } else {
    console.log(`parallel export (${workerCount} pixel workers): ${parallel.ms.toFixed(1)} ms`);
    console.log(`parallel output hash: ${hash(right)}`);
  }
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}

function measure(fn) {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
}

async function measureAsync(fn) {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
}

function makeNegative(width, height) {
  const raster = new Raster(width, height, "transmission-linear");
  fillNegative(raster.data, width, height, 1);
  return raster;
}

function makeNegative16(width, height) {
  const pixels = new Uint16Array(width * height * 3);
  fillNegative(pixels, width, height, 65535);
  return pixels;
}

function fillNegative(target, width, height, scale) {
  const base = [0.84, 0.61, 0.39];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const border = x < width * 0.06 || y < height * 0.025;
      const level = border ? 1 : 0.08 + 0.86 * (x / width * 0.7 + y / height * 0.3);
      const colour = (x * 17 + y * 31) % 29 === 0;
      const channels = colour ? [level, level * 0.58, level * 0.31] : [level, level, level];
      for (let channel = 0; channel < 3; channel += 1) {
        const density = border ? 0 : [0.03, 0, 0.05][channel] + -Math.log10(channels[channel]) * [0.96, 1.02, 1.08][channel];
        const value = base[channel] * Math.pow(10, -density);
        target[offset + channel] = scale === 1 ? value : Math.round(value * scale);
      }
    }
  }
}

function runExportWorker(coordinatorPath, pixelPath, sourcePath, outPath, workers) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(coordinatorPath, { workerData: { pixelWorkerPath: pixelPath, workerCountOverride: workers } });
    worker.once("error", reject);
    worker.on("message", (message) => {
      if (message.jobId !== 1) return;
      void worker.terminate();
      resolve(message.result);
    });
    worker.postMessage({
      jobId: 1,
      sourcePath,
      recipe: DEFAULT_RECIPE,
      format: "tiff",
      outPath,
    });
  });
}

function hash(data) {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

function longestSide(width, height) {
  return Math.max(width, height);
}
