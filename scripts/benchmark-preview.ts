import { performance } from "node:perf_hooks";

import {
  Raster,
  applyFilmTransform,
  measureDensityAnchors,
  processFilm,
  processFilmToScene,
  sampleFilmBase,
  toRelativeDensity,
  toneMap,
  toneMapToSrgbRgba,
} from "../src/core/index.ts";
import type { PipelineSettings } from "../src/core/types.ts";
import { renderDemoPreview } from "../src/main/preview-service.ts";
import { previewPerformanceProfile } from "../src/renderer/src/preview-interaction.ts";
import { defaultProcessingRecipe, type PreviewRequest } from "../src/shared/contracts.ts";

const width = 1920;
const height = 1080;
const source = new Raster(width, height, "transmission-linear-rgb");
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 3;
    const horizontal = x / Math.max(1, width - 1);
    const vertical = y / Math.max(1, height - 1);
    source.data[offset] = 0.72 + horizontal * 0.18;
    source.data[offset + 1] = 0.5 + vertical * 0.2;
    source.data[offset + 2] = 0.34 + horizontal * vertical * 0.14;
  }
}

const settings: PipelineSettings = {
  baseRoi: { x: 0, y: 0, width: 0.08, height: 1 },
  film: {
    kind: "preset",
    preset: {
      name: "preview-benchmark",
      matrix: [
        [1.06, -0.04, -0.02],
        [-0.025, 1.05, -0.025],
        [-0.035, -0.04, 1.075],
      ],
      curves: [
        [{ x: 0, y: 0 }, { x: 0.24, y: 0.15 }, { x: 0.62, y: 0.93 }, { x: 1.08, y: 2.1 }],
        [{ x: 0, y: 0 }, { x: 0.24, y: 0.17 }, { x: 0.62, y: 0.9 }, { x: 1.08, y: 2.02 }],
        [{ x: 0, y: 0 }, { x: 0.24, y: 0.14 }, { x: 0.62, y: 0.95 }, { x: 1.08, y: 2.16 }],
      ],
    },
  },
  tone: {
    exposureStops: 0,
    contrast: 1.16,
    highlightCompression: 0.5,
    saturation: 1.04,
  },
};

const timings: number[] = [];
for (let iteration = 0; iteration < 3; iteration += 1) {
  const startedAt = performance.now();
  processFilm(source, settings);
  timings.push(performance.now() - startedAt);
}

const sorted = [...timings].sort((left, right) => left - right);
const scene = processFilmToScene(source, settings);
const toneTimings: number[] = [];
for (let iteration = 0; iteration < 5; iteration += 1) {
  const startedAt = performance.now();
  toneMap(scene.sceneLinear, {
    ...settings.tone,
    exposureStops: iteration * 0.05,
  });
  toneTimings.push(performance.now() - startedAt);
}
const sortedTone = [...toneTimings].sort((left, right) => left - right);
const fusedToneTimings: number[] = [];
for (let iteration = 0; iteration < 5; iteration += 1) {
  const startedAt = performance.now();
  toneMapToSrgbRgba(scene.sceneLinear, { ...settings.tone, exposureStops: iteration * 0.05 });
  fusedToneTimings.push(performance.now() - startedAt);
}
const sortedFusedTone = [...fusedToneTimings].sort((left, right) => left - right);
const stages: Record<string, number> = {};
let stageStartedAt = performance.now();
const base = sampleFilmBase(source, settings.baseRoi);
stages.baseSample = performance.now() - stageStartedAt;
stageStartedAt = performance.now();
const density = toRelativeDensity(source, base.rgb);
stages.density = performance.now() - stageStartedAt;
stageStartedAt = performance.now();
measureDensityAnchors(base.rgb, density);
stages.densityAnchors = performance.now() - stageStartedAt;
stageStartedAt = performance.now();
applyFilmTransform(density, settings.film);
stages.filmTransform = performance.now() - stageStartedAt;
const demoRequest: PreviewRequest = {
  revision: 1,
  assetId: "demo-negative",
  maxEdge: previewPerformanceProfile.quickMaxEdge,
  mode: "preset",
  view: "positive",
  tone: settings.tone,
  processing: defaultProcessingRecipe,
};
stageStartedAt = performance.now();
renderDemoPreview(demoRequest);
const demoInitialMs = performance.now() - stageStartedAt;
stageStartedAt = performance.now();
renderDemoPreview({ ...demoRequest, revision: 2, tone: { ...demoRequest.tone, exposureStops: 0.25 } });
const demoCachedToneMs = performance.now() - stageStartedAt;
const settledRequest: PreviewRequest = {
  ...demoRequest,
  revision: 3,
  maxEdge: previewPerformanceProfile.settledMaxEdge,
};
stageStartedAt = performance.now();
renderDemoPreview(settledRequest);
const demoSettledInitialMs = performance.now() - stageStartedAt;
stageStartedAt = performance.now();
renderDemoPreview({ ...settledRequest, revision: 4, tone: { ...settledRequest.tone, exposureStops: 0.25 } });
const demoSettledCachedToneMs = performance.now() - stageStartedAt;
stageStartedAt = performance.now();
renderDemoPreview({ ...demoRequest, revision: 5, tone: { ...demoRequest.tone, exposureStops: 0.5 } });
const demoQuickRevisitedMs = performance.now() - stageStartedAt;
console.log(JSON.stringify({
  dimensions: `${width}x${height}`,
  timingsMs: timings.map((value) => Math.round(value)),
  medianMs: Math.round(sorted[Math.floor(sorted.length / 2)]),
  cachedToneTimingsMs: toneTimings.map((value) => Math.round(value)),
  cachedToneMedianMs: Math.round(sortedTone[Math.floor(sortedTone.length / 2)]),
  fusedPreviewMedianMs: Math.round(sortedFusedTone[Math.floor(sortedFusedTone.length / 2)]),
  stageTimingsMs: Object.fromEntries(Object.entries(stages).map(([key, value]) => [key, Math.round(value)])),
  adaptivePreview: {
    quickMaxEdge: previewPerformanceProfile.quickMaxEdge,
    settledMaxEdge: previewPerformanceProfile.settledMaxEdge,
    quickPixelWorkVsFhd: (previewPerformanceProfile.quickMaxEdge / 1920) ** 2,
    settledPixelWorkVsFhd: (previewPerformanceProfile.settledMaxEdge / 1920) ** 2,
  },
  demoMs: {
    quickInitial: Math.round(demoInitialMs),
    quickCachedTone: Math.round(demoCachedToneMs),
    settledInitial: Math.round(demoSettledInitialMs),
    settledCachedTone: Math.round(demoSettledCachedToneMs),
    quickRevisited: Math.round(demoQuickRevisitedMs),
  },
}));
