import { defaultProcessingRecipe, type FilmLabApi, type PreviewRequest, type PreviewResult } from "../../shared/contracts.ts";
import { uncharacterizedColorTrust } from "../../shared/color-trust.ts";
import type { FilmMode } from "../../core/types.ts";
import {
  demoFrameId,
  projectSchemaVersion,
  type WorkspaceProject,
  type WorkspaceProjectDraft,
} from "../../shared/project.ts";

let cachedApi: FilmLabApi | null = null;
const demoSession = {
  id: "web-demo-session",
  projectId: "web-demo-project",
  name: "workspace.filmlab",
  readOnly: false,
  backupCount: 0,
} as const;
const masterExportUiDemo = typeof window !== "undefined"
  && new URLSearchParams(window.location.search).has("master-export-demo");
const masterExportDemoAsset = {
  id: "web-demo-master-source",
  name: "演示扫描.tiff",
  extension: ".tiff",
} as const;
let demoProject: WorkspaceProject = {
  schemaVersion: projectSchemaVersion,
  rolls: [{
    id: "default-roll",
    title: "演示胶卷",
    assets: [],
    frameOrder: masterExportUiDemo ? [] : [demoFrameId],
  }],
  activeRollId: "default-roll",
  recipe: {
    mode: "preset",
    view: "positive",
    tone: {
      exposureStops: 0,
      contrast: 1,
      highlightCompression: 0,
      saturation: 1,
    },
    processing: cloneDefaultProcessing(),
  },
  presets: [],
  updatedAt: new Date().toISOString(),
};

export function createWebDemoApi(): FilmLabApi {
  if (cachedApi !== null) {
    return cachedApi;
  }

  cachedApi = {
    selectSourceFiles: async () => masterExportUiDemo ? [masterExportDemoAsset] : [],
    renderPreview: async (request: PreviewRequest) => createPreview(request),
    precomputePreview: async (request: PreviewRequest) => createPreview(request),
    loadProject: async () => ({
      project: demoProject,
      session: demoSession,
      recentProjects: [],
      restoredCalibrationProfileIds: [],
      relinkedAssetIds: [],
      relinkedAssets: [],
      missingAssets: [],
    }),
    createProject: async () => undefined,
    openProject: async () => undefined,
    openRecentProject: async () => {
      throw new Error("浏览器演示模式没有最近项目目录。");
    },
    saveProject: async (_sessionId: string, project: WorkspaceProjectDraft) => {
      demoProject = {
        schemaVersion: projectSchemaVersion,
        ...project,
        presets: project.presets ?? [],
        updatedAt: new Date().toISOString(),
      };
      return { project: demoProject, backupCount: 0 };
    },
    saveProjectAs: async () => undefined,
    confirmProjectPendingAction: async () => ({
      project: demoProject,
      session: demoSession,
      recentProjects: [],
      restoredCalibrationProfileIds: [],
      relinkedAssetIds: [],
      relinkedAssets: [],
      missingAssets: [],
    }),
    createProjectBackup: async () => ({ created: false, backupCount: 0 }),
    onRequestClose: () => () => undefined,
    confirmClose: () => undefined,
    exportPreviewPng: async () => ({ saved: false }),
    exportMasterTiff: async () => ({ saved: false }),
    exportGpuMasterTiff: async () => ({ saved: false }),
    beginGpuMasterTiff: async () => ({ saved: false }),
    appendGpuMasterTiffStrip: async () => undefined,
    finishGpuMasterTiff: async () => ({ saved: false }),
    cancelGpuMasterTiff: async () => undefined,
    importCalibrationProfile: async () => undefined,
    listCalibrationProfiles: async () => [],
    generateCalibrationFromColorCard: async () => {
      throw new Error("浏览器演示模式不具备 RAW 色卡拟合能力。");
    },
    relinkProjectSources: async (assets) => masterExportUiDemo
      ? { relinkedAssetIds: assets.map((asset) => asset.id), relinkedAssets: assets, missingAssets: [] }
      : { relinkedAssetIds: [], relinkedAssets: [], missingAssets: assets },
    startBatchTiffExport: async () => undefined,
    getBatchJob: async () => undefined,
    cancelBatchJob: async () => undefined,
  };
  return cachedApi!;
}

function cloneDefaultProcessing() {
  return {
    baseRoi: { ...defaultProcessingRecipe.baseRoi },
    geometry: { ...defaultProcessingRecipe.geometry },
    restoration: { ...defaultProcessingRecipe.restoration },
  };
}

function createPreview(request: PreviewRequest): PreviewResult {
  const startedAt = performance.now();
  const width = Math.round(request.maxEdge);
  const height = Math.round(width * 0.664);
  const gpuSourceKey = "web-demo:bayer:" + width + "x" + height;
  const rgba = new Uint8Array(width * height * 4);
  const gpuSourceLinear = new Float32Array(width * height * 3);
  const sceneLinear = request.view === "positive"
    ? new Float32Array(width * height * 3)
    : undefined;
  const borderWidth = Math.max(3, Math.floor(width * 0.09));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (x < borderWidth) {
        writeDemoTransmission(gpuSourceLinear, (y * width + x) * 3, 0.54, 0.32, 0.14);
        if (sceneLinear !== undefined) {
          const sceneOffset = (y * width + x) * 3;
          sceneLinear[sceneOffset] = 0.54;
          sceneLinear[sceneOffset + 1] = 0.32;
          sceneLinear[sceneOffset + 2] = 0.14;
          writeToneMappedPixel(rgba, offset, 0.54, 0.32, 0.14, request.tone);
        } else {
          rgba[offset] = 194;
          rgba[offset + 1] = 153;
          rgba[offset + 2] = 104;
          rgba[offset + 3] = 255;
        }
        continue;
      }

      const u = (x - borderWidth) / Math.max(1, width - borderWidth - 1);
      const v = y / Math.max(1, height - 1);
      const light = Math.exp(-Math.pow((u - 0.68) / 0.13, 2) * 0.5) * Math.exp(-Math.pow((v - 0.34) / 0.18, 2) * 0.5);
      const ridge = 0.48 + 0.18 * Math.sin(u * 10.2) + 0.08 * Math.sin(u * 23.1);
      const ground = v > ridge;
      const windowGlow = Math.min(1, Math.max(0, Math.sin(u * 92) - 0.86) / 0.14 * Math.max(0, Math.sin(v * 74) - 0.9) / 0.1);
      const sky = Math.max(0, 1 - v * 1.75);
      let red = 0.05 + sky * 0.16 + light * 1.1;
      let green = 0.075 + sky * 0.35 + light * 0.68;
      let blue = 0.11 + sky * 0.76 + light * 0.17;

      if (ground) {
        const amount = Math.min(1, (v - ridge) * 2.3);
        red = 0.055 + amount * 0.16 + windowGlow * 1.45;
        green = 0.07 + amount * 0.23 + windowGlow * 0.74;
        blue = 0.08 + amount * 0.18 + windowGlow * 0.28;
      }
      writeDemoTransmission(gpuSourceLinear, (y * width + x) * 3, red, green, blue);

      if (sceneLinear !== undefined) {
        const sceneOffset = (y * width + x) * 3;
        sceneLinear[sceneOffset] = red;
        sceneLinear[sceneOffset + 1] = green;
        sceneLinear[sceneOffset + 2] = blue;
        writeToneMappedPixel(rgba, offset, red, green, blue, request.tone);
        continue;
      }

      const multiplier = Math.pow(2, request.tone.exposureStops);
      const saturation = request.tone.saturation;
      const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      red = (luma + (red - luma) * saturation) * multiplier;
      green = (luma + (green - luma) * saturation) * multiplier;
      blue = (luma + (blue - luma) * saturation) * multiplier;

      if (request.view === "transmission") {
        red = 0.56 * Math.pow(10, -red * 0.32);
        green = 0.33 * Math.pow(10, -green * 0.32);
        blue = 0.15 * Math.pow(10, -blue * 0.32);
      } else if (request.view === "density") {
        const density = Math.min(1, Math.max(0, (red + green + blue) / 1.6));
        red = density;
        green = density;
        blue = density;
      }

      rgba[offset] = toByte(red);
      rgba[offset + 1] = toByte(green);
      rgba[offset + 2] = toByte(blue);
      rgba[offset + 3] = 255;
    }
  }

  const requestedBase = request.processing?.filmBase;
  const baseRgb = requestedBase?.kind === "reference" ? requestedBase.rgb : [0.54, 0.32, 0.14] as const;
  const baseMethod = requestedBase?.kind === "reference"
    ? "reference" as const
    : requestedBase?.kind === "automatic"
      ? "automatic" as const
      : "roi" as const;
  const bayerPattern = [0, 1, 1, 2] as const;
  const sourceBayer = new Uint16Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const channel = bayerPattern[(y & 1) * 2 + (x & 1)];
      sourceBayer[pixel] = Math.round(
        Math.min(1, Math.max(0, gpuSourceLinear[pixel * 3 + channel])) * 65_535,
      );
    }
  }
  const dmin = 0.539;
  const automaticDmax = 0.88;
  const sampledDmax = request.dmaxSampleRoi === undefined
    ? undefined
    : estimateDemoDmax(gpuSourceLinear, width, height, baseRgb, request.dmaxSampleRoi);
  const dmax = request.dmaxOverride ?? sampledDmax ?? automaticDmax;
  return {
    revision: request.revision,
    width,
    height,
    rgba,
    sceneLinear,
    displayWhitePoint: sceneLinear === undefined
      ? undefined
      : request.dmaxOverride === undefined && request.dmaxSampleRoi === undefined
        ? 1
        : Math.max(0.05, dmax - dmin),
    gpuPipeline: {
      sourceKey: gpuSourceKey,
      sourceBayer: request.gpuReuseSourceKey === gpuSourceKey
        ? undefined
        : sourceBayer,
      bayerPattern,
      sourceWidth: width,
      sourceHeight: height,
      baseRgb,
      film: demoGpuFilm(request.mode),
    },
    base: {
      rgb: baseRgb,
      sampleCount: baseMethod === "reference" ? 0 : Math.max(3, borderWidth * height),
      rejectedCount: 0,
      method: baseMethod,
      confidence: requestedBase?.kind === "reference"
        ? requestedBase.confidence
        : baseMethod === "automatic"
          ? 0.52
          : 1,
    },
    density: {
      dmin,
      dmax,
      range: Math.max(0, dmax - dmin),
    },
    colorTrust: uncharacterizedColorTrust(request.mode),
    elapsedMs: Math.round(performance.now() - startedAt),
    warnings: ["浏览器视觉验收模式：使用隔离的模拟预览，不代替 Electron 核心计算。"],
  };
}

function estimateDemoDmax(
  source: Float32Array,
  width: number,
  height: number,
  base: readonly [number, number, number],
  roi: NonNullable<PreviewRequest["dmaxSampleRoi"]>,
): number {
  const left = Math.floor(roi.x * width);
  const top = Math.floor(roi.y * height);
  const right = Math.ceil((roi.x + roi.width) * width);
  const bottom = Math.ceil((roi.y + roi.height) * height);
  const values: number[] = [];
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * width + x) * 3;
      const density = (
        -Math.log10(Math.max(source[offset] / base[0], 1e-6))
        - Math.log10(Math.max(source[offset + 1] / base[1], 1e-6))
        - Math.log10(Math.max(source[offset + 2] / base[2], 1e-6))
      ) / 3;
      if (Number.isFinite(density)) values.push(Math.max(0, density));
    }
  }
  if (values.length === 0) return 0.539;
  values.sort((leftValue, rightValue) => leftValue - rightValue);
  return 0.539 + values[Math.round((values.length - 1) * 0.995)];
}

function writeDemoTransmission(
  target: Float32Array,
  offset: number,
  sceneRed: number,
  sceneGreen: number,
  sceneBlue: number,
): void {
  target[offset] = 0.54 * Math.pow(10, -Math.max(0, sceneRed));
  target[offset + 1] = 0.32 * Math.pow(10, -Math.max(0, sceneGreen));
  target[offset + 2] = 0.14 * Math.pow(10, -Math.max(0, sceneBlue));
}

function demoGpuFilm(mode: PreviewRequest["mode"]): FilmMode {
  if (mode === "generic") {
    return { kind: "generic", densityGain: [1, 1, 1], whiteBalance: [1, 1, 1] };
  }
  const curves = [
    [{ x: 0, y: 0 }, { x: 2, y: 2 }],
    [{ x: 0, y: 0 }, { x: 2, y: 2 }],
    [{ x: 0, y: 0 }, { x: 2, y: 2 }],
  ] as const;
  const matrix = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ] as const;
  if (mode === "preset") {
    return { kind: "preset", preset: { id: "web-demo-gpu", version: "1", curves, matrix } };
  }
  const lutData = new Float32Array(2 * 2 * 2 * 3);
  for (let red = 0; red < 2; red += 1) {
    for (let green = 0; green < 2; green += 1) {
      for (let blue = 0; blue < 2; blue += 1) {
        const offset = ((red * 2 + green) * 2 + blue) * 3;
        lutData[offset] = red;
        lutData[offset + 1] = green;
        lutData[offset + 2] = blue;
      }
    }
  }
  return {
    kind: "calibrated",
    profile: {
      id: "web-demo-gpu-calibrated",
      version: "1",
      calibrationId: "web-demo",
      captureFingerprint: "web-demo",
      curves,
      matrix,
      lut: { size: 2, data: lutData },
    },
  };
}

function writeToneMappedPixel(
  output: Uint8Array,
  offset: number,
  sourceRed: number,
  sourceGreen: number,
  sourceBlue: number,
  tone: PreviewRequest["tone"],
): void {
  const exposure = Math.pow(2, tone.exposureStops);
  const red = sourceRed * exposure;
  const green = sourceGreen * exposure;
  const blue = sourceBlue * exposure;
  const sourceLuma = Math.max(0, red * 0.2126 + green * 0.7152 + blue * 0.0722);
  let mappedLuma = sourceLuma;
  if (mappedLuma > 0 && mappedLuma < 1 && tone.contrast !== 1) {
    mappedLuma = 1 / (1 + Math.pow((1 - mappedLuma) / mappedLuma, tone.contrast));
  } else if (mappedLuma >= 1 && tone.contrast !== 1) {
    mappedLuma = 1 + (mappedLuma - 1) * tone.contrast;
  }
  if (mappedLuma > 0 && tone.highlightCompression > 0) {
    const knee = 1 / (1 + tone.highlightCompression);
    if (mappedLuma > knee) {
      const shoulder = 1 - knee;
      mappedLuma = knee + shoulder * (1 - Math.exp(-(mappedLuma - knee) / shoulder));
    }
  }
  const scale = sourceLuma > 1e-8 ? mappedLuma / sourceLuma : 0;
  let mappedRed = red * scale;
  let mappedGreen = green * scale;
  let mappedBlue = blue * scale;
  const outputLuma = mappedRed * 0.2126 + mappedGreen * 0.7152 + mappedBlue * 0.0722;
  mappedRed = outputLuma + (mappedRed - outputLuma) * tone.saturation;
  mappedGreen = outputLuma + (mappedGreen - outputLuma) * tone.saturation;
  mappedBlue = outputLuma + (mappedBlue - outputLuma) * tone.saturation;
  if (tone.highlightCompression > 0) {
    const maximum = Math.max(mappedRed, mappedGreen, mappedBlue);
    const ceiling = 1 - 1 / 65_536;
    if (maximum > ceiling) {
      const gamutScale = ceiling / maximum;
      mappedRed *= gamutScale;
      mappedGreen *= gamutScale;
      mappedBlue *= gamutScale;
    }
  }
  output[offset] = toByte(mappedRed);
  output[offset + 1] = toByte(mappedGreen);
  output[offset + 2] = toByte(mappedBlue);
  output[offset + 3] = 255;
}

function toByte(value: number): number {
  const bounded = Math.max(0, Math.min(1, value));
  const encoded = bounded <= 0.0031308
    ? bounded * 12.92
    : 1.055 * Math.pow(bounded, 1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}
