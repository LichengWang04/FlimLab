import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import sharp from "sharp";

import { processFilm, processFilmToScene, Raster, toneMapToSrgbRgba } from "../src/core/index.ts";
import type { PipelineSettings } from "../src/core/types.ts";
import {
  createDecodedPreviewCacheEntry,
  readDecodedPreviewCache,
  writeDecodedPreviewCache,
} from "../src/main/decoded-preview-cache.ts";

const sourcePath = resolve(process.argv[2] ?? "A7R5_RAW/DSC01683.tif");
const maximumEdge = Number(process.argv[3] ?? 4096);
if (!Number.isSafeInteger(maximumEdge) || maximumEdge < 256 || maximumEdge > 16_384) {
  throw new Error("Benchmark maximum edge must be an integer from 256 to 16384.");
}

const decodeStartedAt = performance.now();
const decoded = await sharp(sourcePath, {
  failOn: "error",
  limitInputPixels: 80_000_000,
  sequentialRead: true,
})
  .resize({ width: maximumEdge, height: maximumEdge, fit: "inside", withoutEnlargement: true })
  .removeAlpha()
  .toColourspace("rgb16")
  .raw({ depth: "ushort" })
  .toBuffer({ resolveWithObject: true });
const decodeMs = performance.now() - decodeStartedAt;
const samples = new Uint16Array(
  decoded.data.buffer,
  decoded.data.byteOffset,
  decoded.data.byteLength / Uint16Array.BYTES_PER_ELEMENT,
);
const conversionStartedAt = performance.now();
const linear = new Float32Array(samples.length);
for (let index = 0; index < samples.length; index += 1) linear[index] = samples[index] / 65_535;
const rgb16ToFloatMs = performance.now() - conversionStartedAt;
const raster = new Raster(
  decoded.info.width,
  decoded.info.height,
  "transmission-linear-rgb",
  linear,
);
const settings: PipelineSettings = {
  baseRoi: { x: 0, y: 0, width: 0.08, height: 1 },
  film: {
    kind: "generic",
    densityGain: [1, 1, 1],
    whiteBalance: [1.04, 1, 0.96],
  },
  tone: {
    exposureStops: 0,
    contrast: 1.16,
    highlightCompression: 0.5,
    saturation: 1.04,
  },
};

const completeStartedAt = performance.now();
processFilm(raster, settings);
const completeMs = performance.now() - completeStartedAt;
const sceneStartedAt = performance.now();
const scene = processFilmToScene(raster, settings);
const sceneMs = performance.now() - sceneStartedAt;
const toneRuns: number[] = [];
for (let iteration = 0; iteration < 5; iteration += 1) {
  const startedAt = performance.now();
  toneMapToSrgbRgba(scene.sceneLinear, {
    ...settings.tone,
    exposureStops: iteration * 0.05,
    whitePoint: scene.displayWhitePoint,
  });
  toneRuns.push(performance.now() - startedAt);
}
toneRuns.sort((left, right) => left - right);

const gpuPreparationStartedAt = performance.now();
const analysisRaster = resizeRasterNearest(raster, 320);
const analysisScene = processFilmToScene(analysisRaster, settings);
const analysisRgba = toneMapToSrgbRgba(analysisScene.sceneLinear, {
  ...settings.tone,
  whitePoint: analysisScene.displayWhitePoint,
});
resizeRgbaNearest(
  analysisRgba,
  analysisScene.sceneLinear.width,
  analysisScene.sceneLinear.height,
  raster.width,
  raster.height,
);
const gpuPreparationMs = performance.now() - gpuPreparationStartedAt;
const cacheDirectory = await mkdtemp(join(tmpdir(), "filmlab-cache-benchmark-"));
const cacheEntry = await createDecodedPreviewCacheEntry(
  cacheDirectory,
  sourcePath,
  maximumEdge,
  "benchmark:" + sharp.versions.sharp + ":" + sharp.versions.vips,
);
const cacheWriteStartedAt = performance.now();
await writeDecodedPreviewCache(cacheDirectory, cacheEntry, {
  source: raster,
  summary: {
    width: raster.width,
    height: raster.height,
    bitDepth: 16,
    sourceDomain: "transmission-linear-rgb",
    decoder: "sharp-raster",
    warnings: [],
  },
}, decoded.data);
const coldCacheWriteMs = performance.now() - cacheWriteStartedAt;
const hotCacheStartedAt = performance.now();
const hotCached = await readDecodedPreviewCache(cacheEntry);
const hotCacheMs = performance.now() - hotCacheStartedAt;
await rm(cacheDirectory, { recursive: true, force: true });
if (hotCached === undefined) throw new Error("Preview cache benchmark failed.");

console.log(JSON.stringify({
  sourcePath,
  decodedDimensions: decoded.info.width + "x" + decoded.info.height,
  megapixels: Math.round(decoded.info.width * decoded.info.height / 10_000) / 100,
  sourceLinearMiB: Math.round(linear.byteLength / 1024 / 1024),
  decodeMs: Math.round(decodeMs),
  rgb16ToFloatMs: Math.round(rgb16ToFloatMs),
  cpuCompletePipelineMs: Math.round(completeMs),
  cpuScenePipelineMs: Math.round(sceneMs),
  cpuToneMedianMs: Math.round(toneRuns[Math.floor(toneRuns.length / 2)]),
  gpuInteractiveCpuPreparationMs: Math.round(gpuPreparationMs),
  cpuWorkSpeedupBeforeGpuDraw: Math.round(
    completeMs / Math.max(gpuPreparationMs, 0.01) * 10,
  ) / 10,
  hotLinearPreviewCacheMs: Math.round(hotCacheMs),
  coldCachePublishMs: Math.round(coldCacheWriteMs),
  decodeToHotCacheSpeedup: Math.round(
    decodeMs / Math.max(hotCacheMs, 0.01) * 10,
  ) / 10,
  gpuTiming: "Load this source in FilmLab; EXT_disjoint_timer_query_webgl2 writes the real GPU time to preview canvas data-gpu-milliseconds.",
}, null, 2));

function resizeRasterNearest(source: Raster, maximumEdge: number): Raster {
  const scale = Math.min(1, maximumEdge / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  if (width === source.width && height === source.height) return source;
  const output = new Raster(width, height, source.domain);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor((y + 0.5) * source.height / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor((x + 0.5) * source.width / width));
      const from = (sourceY * source.width + sourceX) * 3;
      const to = (y * width + x) * 3;
      output.data[to] = source.data[from];
      output.data[to + 1] = source.data[from + 1];
      output.data[to + 2] = source.data[from + 2];
    }
  }
  return output;
}

function resizeRgbaNearest(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): Uint8Array {
  const output = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor((y + 0.5) * sourceHeight / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x + 0.5) * sourceWidth / width));
      const from = (sourceY * sourceWidth + sourceX) * 4;
      const to = (y * width + x) * 4;
      output[to] = source[from];
      output[to + 1] = source[from + 1];
      output[to + 2] = source[from + 2];
      output[to + 3] = source[from + 3];
    }
  }
  return output;
}
