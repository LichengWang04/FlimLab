import {
  processFilmToScene,
  Raster,
  rasterToSrgbRgba,
  toneMapToSrgbRgba,
  type CalibrationProfile,
  type CurveSet,
  type FilmMode,
  type Lut3d,
  type Matrix3,
  type PipelineSceneResult,
  type RestorationSettings,
  type Rgb,
} from "../core/index.ts";
import type { PreviewMode, PreviewRequest, PreviewResult, ProcessingRecipe } from "../shared/contracts.ts";
import { uncharacterizedColorTrust } from "../shared/color-trust.ts";

const FILM_BASE: Rgb = [0.54, 0.32, 0.14];
const IDENTITY_MATRIX: Matrix3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const C41_MATRIX: Matrix3 = [
  [1.06, -0.04, -0.02],
  [-0.025, 1.05, -0.025],
  [-0.035, -0.04, 1.075],
];
const C41_CURVES: CurveSet = [
  [
    { x: 0, y: 0 },
    { x: 0.24, y: 0.155 },
    { x: 0.62, y: 0.93 },
    { x: 1.08, y: 2.09 },
  ],
  [
    { x: 0, y: 0 },
    { x: 0.24, y: 0.155 },
    { x: 0.62, y: 0.93 },
    { x: 1.08, y: 2.09 },
  ],
  [
    { x: 0, y: 0 },
    { x: 0.24, y: 0.155 },
    { x: 0.62, y: 0.93 },
    { x: 1.08, y: 2.09 },
  ],
];

const demoSourceCache = new Map<string, Raster>();
const demoStageCache = new Map<string, PipelineSceneResult>();
const maximumDemoCacheEntries = 2;
const DEMO_CALIBRATION_PROFILE = calibratedProfile();

export function renderDemoPreview(request: PreviewRequest): PreviewResult {
  const startedAt = Date.now();
  const width = Math.round(request.maxEdge);
  const height = Math.round(width * 0.664);
  const source = getDemoNegative(width, height);
  const film = getFilmMode(request.mode, request.processing?.channelGains);
  const stageKey = JSON.stringify([
    width,
    height,
    request.mode,
    request.processing ?? null,
    request.dmaxOverride ?? null,
    request.dmaxSampleRoi ?? null,
  ]);
  let processed: PipelineSceneResult;
  const cachedStage = demoStageCache.get(stageKey);
  if (cachedStage !== undefined) {
    processed = cachedStage;
    demoStageCache.delete(stageKey);
    demoStageCache.set(stageKey, cachedStage);
  } else {
    processed = processFilmToScene(source, {
      baseRoi: request.processing?.baseRoi ?? { x: 0, y: 0, width: 0.08, height: 1 },
      baseStrategy: request.processing?.filmBase?.kind === "reference"
        ? { kind: "reference", rgb: request.processing.filmBase.rgb, confidence: request.processing.filmBase.confidence }
        : request.processing?.filmBase?.kind === "automatic"
          ? { kind: "automatic" }
          : undefined,
      geometry: request.processing?.geometry,
      dmaxOverride: request.dmaxOverride,
      dmaxSampleRoi: request.dmaxSampleRoi,
      restoration: toDemoRestorationSettings(request.processing),
      film,
      tone: request.tone,
    });
    setBoundedCacheEntry(demoStageCache, stageKey, processed);
  }

  const display = request.view === "transmission"
    ? processed.transmission
    : request.view === "density"
      ? densityVisualization(processed.density)
      : undefined;
  const widthOut = display?.width ?? processed.sceneLinear.width;
  const heightOut = display?.height ?? processed.sceneLinear.height;
  const rgba = display === undefined
    ? toneMapToSrgbRgba(processed.sceneLinear, { ...request.tone, whitePoint: processed.displayWhitePoint })
    : rasterToSrgbRgba(display);

  return {
    revision: request.revision,
    width: widthOut,
    height: heightOut,
    rgba,
    sceneLinear: display === undefined ? processed.sceneLinear.data : undefined,
    displayWhitePoint: display === undefined ? processed.displayWhitePoint : undefined,
    gpuPipeline: {
      sourceKey: "main-demo:" + source.width + "x" + source.height,
      sourceLinear: source.data,
      sourceWidth: source.width,
      sourceHeight: source.height,
      baseRgb: processed.base.rgb,
      film,
    },
    base: {
      rgb: processed.base.rgb,
      sampleCount: processed.base.sampleCount,
      rejectedCount: processed.base.rejectedCount,
      method: processed.base.method,
      confidence: processed.base.confidence,
    },
    density: processed.densityAnchors,
    colorTrust: uncharacterizedColorTrust(request.mode),
    elapsedMs: Date.now() - startedAt,
    warnings: buildWarnings(request.mode, processed.base),
  };
}

function getFilmMode(mode: PreviewMode, channelGains?: readonly [number, number, number]): FilmMode {
  const trim = channelGains === undefined ? [1, 1, 1] as const : channelGains;
  if (mode === "generic") {
    return {
      kind: "generic",
      densityGain: [1, 1, 1],
      whiteBalance: multiplyWhiteBalance([1.04, 1, 0.96], trim),
    };
  }
  if (mode === "preset") {
    return {
      kind: "preset",
      preset: {
        id: "demo-c41",
        version: "0.1",
        curves: C41_CURVES,
        matrix: C41_MATRIX,
      },
      whiteBalance: multiplyWhiteBalance([1.04, 1, 0.96], trim),
    };
  }
  return {
    kind: "calibrated",
    profile: DEMO_CALIBRATION_PROFILE,
    whiteBalance: multiplyWhiteBalance([1, 1, 1], trim),
  };
}

function multiplyWhiteBalance(
  base: readonly [number, number, number],
  trim: readonly [number, number, number],
): [number, number, number] {
  return [base[0] * trim[0], base[1] * trim[1], base[2] * trim[2]];
}

function calibratedProfile(): CalibrationProfile {
  return {
    id: "demo-calibrated",
    version: "0.1",
    calibrationId: "demo-light-camera-c41",
    captureFingerprint: "demo-camera/demo-light/c41",
    curves: C41_CURVES,
    matrix: C41_MATRIX,
    lut: calibratedLut(),
  };
}

function calibratedLut(): Lut3d {
  const size = 2;
  const data = new Float32Array(size * size * size * 3);
  for (let red = 0; red < size; red += 1) {
    for (let green = 0; green < size; green += 1) {
      for (let blue = 0; blue < size; blue += 1) {
        const offset = ((red * size + green) * size + blue) * 3;
        data[offset] = Math.min(1, red / (size - 1) * 1.025);
        data[offset + 1] = green / (size - 1);
        data[offset + 2] = Math.min(1, blue / (size - 1) * 0.97);
      }
    }
  }
  return { size, data };
}

function createDemoNegative(width: number, height: number): Raster {
  const image = new Raster(width, height, "transmission-linear-rgb");
  const borderWidth = Math.max(3, Math.floor(width * 0.09));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      if (x < borderWidth) {
        image.data[offset] = FILM_BASE[0];
        image.data[offset + 1] = FILM_BASE[1];
        image.data[offset + 2] = FILM_BASE[2];
        continue;
      }

      const u = (x - borderWidth) / Math.max(1, width - borderWidth - 1);
      const v = y / Math.max(1, height - 1);
      const sky = Math.max(0, 1 - v * 1.75);
      const warmLight = gaussian(u, 0.68, 0.13) * gaussian(v, 0.34, 0.18);
      const hill = 0.48 + 0.18 * Math.sin(u * 10.2) + 0.08 * Math.sin(u * 23.1);
      const isGround = v > hill;
      const windowGlow = gridGlow(u, v);

      let red = 0.05 + sky * 0.16 + warmLight * 1.1;
      let green = 0.075 + sky * 0.35 + warmLight * 0.68;
      let blue = 0.11 + sky * 0.76 + warmLight * 0.17;
      if (isGround) {
        const ground = Math.min(1, (v - hill) * 2.3);
        red = 0.055 + ground * 0.16 + windowGlow * 1.45;
        green = 0.07 + ground * 0.23 + windowGlow * 0.74;
        blue = 0.08 + ground * 0.18 + windowGlow * 0.28;
      }

      const vignette = 1 - 0.25 * Math.pow(Math.abs(u - 0.5) * 2, 2);
      const scene: Rgb = [
        Math.max(0, red * vignette),
        Math.max(0, green * vignette),
        Math.max(0, blue * vignette),
      ];
      image.data[offset] = FILM_BASE[0] / (scene[0] + 1);
      image.data[offset + 1] = FILM_BASE[1] / (scene[1] + 1);
      image.data[offset + 2] = FILM_BASE[2] / (scene[2] + 1);
    }
  }
  return image;
}

function getDemoNegative(width: number, height: number): Raster {
  const key = width + "x" + height;
  const cached = demoSourceCache.get(key);
  if (cached !== undefined) return cached;
  const source = createDemoNegative(width, height);
  setBoundedCacheEntry(demoSourceCache, key, source);
  return source;
}

function setBoundedCacheEntry<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.set(key, value);
  while (cache.size > maximumDemoCacheEntries) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function toDemoRestorationSettings(processing: ProcessingRecipe | undefined): RestorationSettings | undefined {
  const controls = processing?.restoration;
  if (controls === undefined || (!controls.dust && !controls.scratches && controls.denoise === 0 && controls.sharpen === 0)) {
    return undefined;
  }
  return {
    dust: controls.dust ? { detection: { threshold: 3.5, minDifference: 0.01 }, removal: { repairRadius: 2 } } : false,
    scratches: controls.scratches ? { detection: { threshold: 2.7, minDifference: 0.018, minLength: 12 } } : false,
    denoise: controls.denoise > 0 ? { radius: 2, rangeSigma: 0.012 + controls.denoise * 0.07, iterations: 1 } : false,
    sharpen: controls.sharpen > 0 ? { radius: 1, amount: controls.sharpen, threshold: 0.004 } : false,
  };
}

function densityVisualization(density: Raster): Raster {
  const output = new Raster(density.width, density.height, "display-linear-rgb");
  for (let offset = 0; offset < density.data.length; offset += 3) {
    const value = Math.max(0, Math.min(1, (density.data[offset] + density.data[offset + 1] + density.data[offset + 2]) / 1.7));
    output.data[offset] = value;
    output.data[offset + 1] = value;
    output.data[offset + 2] = value;
  }
  return output;
}

function gaussian(value: number, center: number, spread: number): number {
  return Math.exp(-Math.pow((value - center) / spread, 2) * 0.5);
}

function gridGlow(u: number, v: number): number {
  const horizontal = Math.max(0, Math.sin(u * 92) - 0.86) / 0.14;
  const vertical = Math.max(0, Math.sin(v * 74) - 0.9) / 0.1;
  return Math.min(1, horizontal * vertical);
}

function buildWarnings(mode: PreviewMode, base: PipelineSceneResult["base"]): readonly string[] {
  const warnings = mode === "generic"
    ? ["通用模式：用于浏览与分享，不声明场景绝对色彩准确性。"]
    : mode === "preset"
      ? ["C-41 演示预设：真实胶卷、冲洗与背光仍应分别校准。"]
      : ["演示配置文件：仅匹配内建样张，不可用于真实翻拍设备。"];
  if (base.method === "automatic") {
    warnings.push("片基来自无边框画面估算，不能替代同卷未曝光片基实测值。");
  } else if (base.rejectedCount > 0) {
    warnings.push("片基采样已剔除 " + base.rejectedCount + " 个异常像素。");
  }
  return warnings;
}
