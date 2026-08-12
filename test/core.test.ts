import assert from "node:assert/strict";
import test from "node:test";

import {
  applyFilmTransform,
  applyGeometry,
  estimateFilmBase,
  estimateDisplayWhitePoint,
  measureDensityAnchors,
  processFilm,
  processFilmToScene,
  Raster,
  rotateAndConstrain,
  rasterToSrgbRgba,
  sampleMonotonicCurve,
  sampleFilmBase,
  toRelativeDensity,
  toneMap,
  toneMapToSrgbRgba,
} from "../src/core/index.ts";
import type { CalibrationProfile, CurveSet, Lut3d, Matrix3 } from "../src/core/index.ts";
import { estimateAlignmentFromRgba } from "../src/renderer/src/alignment.ts";
import { estimateFilmFrameCropFromRgba } from "../src/renderer/src/film-frame.ts";

const identityMatrix: Matrix3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

const identityCurves: CurveSet = [
  [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
];

test("film-base sampling is robust and relative density is zero at the base", () => {
  const image = raster("transmission-linear-rgb", 4, 2, [
    0.5, 0.25, 0.125, 0.5, 0.25, 0.125, 0.25, 0.125, 0.0625, 0.25, 0.125, 0.0625,
    0.5, 0.25, 0.125, 0.5, 0.25, 0.125, 0.25, 0.125, 0.0625, 0.25, 0.125, 0.0625,
  ]);
  const base = sampleFilmBase(image, { x: 0, y: 0, width: 0.5, height: 1 });
  const density = toRelativeDensity(image, base.rgb);

  near(base.rgb[0], 0.5);
  near(base.rgb[1], 0.25);
  near(base.rgb[2], 0.125);
  near(density.data[0], 0);
  near(density.data[6], Math.log10(2));
  near(density.data[7], Math.log10(2));
  near(density.data[8], Math.log10(2));
});

test("film-base quick selection rejects an outlier without changing the median", () => {
  const values: number[] = [];
  for (const red of [0.46, 0.47, 0.48, 0.49, 0.5, 0.51, 0.52, 0.53, 0.54, 0.9]) {
    values.push(red, red / 2, red / 4);
  }
  const base = sampleFilmBase(raster("transmission-linear-rgb", 10, 1, values), { x: 0, y: 0, width: 1, height: 1 });

  near(base.rgb[0], 0.5);
  near(base.rgb[1], 0.25);
  near(base.rgb[2], 0.125);
  assert.equal(base.sampleCount, 9);
  assert.equal(base.rejectedCount, 1);
});

test("automatic film-base estimation finds a joint high-transmission envelope with capped confidence", () => {
  const values: number[] = [];
  const expected = [0.82, 0.55, 0.3] as const;
  for (let pixel = 0; pixel < 1_000; pixel += 1) {
    if (pixel < 24) {
      const variation = 0.996 + (pixel % 4) * 0.001;
      values.push(expected[0] * variation, expected[1] * variation, expected[2] * variation);
    } else {
      const density = 0.18 + ((pixel * 37) % 620) / 1_000;
      values.push(expected[0] * density, expected[1] * density * 0.98, expected[2] * density * 0.96);
    }
  }

  const estimate = estimateFilmBase(raster("transmission-linear-rgb", 100, 10, values));

  near(estimate.rgb[0], expected[0], 0.01);
  near(estimate.rgb[1], expected[1], 0.01);
  near(estimate.rgb[2], expected[2], 0.01);
  assert.equal(estimate.method, "automatic");
  assert.ok(estimate.confidence >= 0.3);
  assert.ok(estimate.confidence <= 0.65);
});

test("a fixed film-base reference bypasses a cropped frame ROI", () => {
  const source = raster("transmission-linear-rgb", 2, 1, [
    0.4, 0.25, 0.1,
    0.2, 0.125, 0.05,
  ]);
  const processed = processFilmToScene(source, {
    baseRoi: { x: 0, y: 0, width: 0.5, height: 1 },
    baseStrategy: { kind: "reference", rgb: [0.8, 0.5, 0.2], confidence: 0.94 },
    film: { kind: "generic" },
  });

  assert.equal(processed.base.method, "reference");
  near(processed.base.confidence, 0.94);
  near(processed.base.rgb[0], 0.8);
  near(processed.density.data[0], Math.log10(2));
  near(processed.density.data[3], Math.log10(4));
});

test("density anchors report film-base Dmin and a robust high-density Dmax", () => {
  const density = raster("relative-density", 4, 1, [
    0, 0, 0,
    0.2, 0.2, 0.2,
    0.4, 0.4, 0.4,
    5, 5, 5,
  ]);
  const anchors = measureDensityAnchors([0.5, 0.5, 0.5], density, 2 / 3);

  near(anchors.dmin, Math.log10(2));
  near(anchors.range, 0.4);
  near(anchors.dmax, Math.log10(2) + 0.4);
});

test("manual Dmax overrides automatic anchors and can be measured from an ROI", () => {
  const density = raster("relative-density", 4, 1, [
    0, 0, 0,
    0.2, 0.2, 0.2,
    0.4, 0.4, 0.4,
    5, 5, 5,
  ]);
  const manual = measureDensityAnchors([0.5, 0.5, 0.5], density, 0.995, { dmaxOverride: 1.25 });
  near(manual.dmax, 1.25);
  near(manual.range, 1.25 - Math.log10(2));

  const sampled = measureDensityAnchors(
    [0.5, 0.5, 0.5],
    density,
    0.5,
    { dmaxRoi: { x: 0.25, y: 0, width: 0.5, height: 1 } },
  );
  near(sampled.dmax, Math.log10(2) + 0.3);
});

test("generic mode maps higher negative density to a brighter positive", () => {
  const density = raster("relative-density", 2, 1, [
    0, 0, 0,
    Math.log10(2), Math.log10(2), Math.log10(2),
  ]);
  const result = applyFilmTransform(density, { kind: "generic" });

  near(result.data[0], 0);
  near(result.data[3], 1);
  near(result.data[4], 1);
  near(result.data[5], 1);
  assert.equal(result.domain, "scene-linear-rgb");
});

test("preset mode applies its curves then its colour matrix", () => {
  const density = raster("relative-density", 1, 1, [0.25, 0.5, 0.75]);
  const result = applyFilmTransform(density, {
    kind: "preset",
    preset: {
      id: "unit-preset",
      version: "1",
      curves: identityCurves,
      matrix: identityMatrix,
    },
  });

  near(result.data[0], 0.25);
  near(result.data[1], 0.5);
  near(result.data[2], 0.75);
});

test("film curves clamp outside their calibrated density domain", () => {
  const curve = [
    { x: 0, y: 0.1 },
    { x: 1, y: 0.9 },
  ];

  near(sampleMonotonicCurve(curve, -2), 0.1);
  near(sampleMonotonicCurve(curve, 3), 0.9);
});

test("calibrated mode supports a trilinear 3D LUT", () => {
  const lut = identityLut(2);
  const profile: CalibrationProfile = {
    id: "unit-calibration",
    version: "1",
    calibrationId: "calibration-1",
    captureFingerprint: "camera-light-1",
    curves: identityCurves,
    matrix: identityMatrix,
    lut,
  };
  const density = raster("relative-density", 1, 1, [0.25, 0.5, 0.75]);
  const result = applyFilmTransform(density, { kind: "calibrated", profile });

  near(result.data[0], 0.25);
  near(result.data[1], 0.5);
  near(result.data[2], 0.75);
});

test("geometry uses lossless right-angle rotation before crop", () => {
  const transmission = raster("transmission-linear-rgb", 2, 1, [
    1, 0, 0,
    0, 1, 0,
  ]);
  const result = applyGeometry(transmission, { rotation: 90 });

  assert.equal(result.width, 1);
  assert.equal(result.height, 2);
  assert.deepEqual(result.getPixel(0, 0), [1, 0, 0]);
  assert.deepEqual(result.getPixel(0, 1), [0, 1, 0]);
});

test("geometry supports identity perspective without changing samples", () => {
  const transmission = raster("transmission-linear-rgb", 2, 2, [
    0.1, 0.2, 0.3, 0.4, 0.5, 0.6,
    0.7, 0.8, 0.9, 0.2, 0.3, 0.4,
  ]);
  const result = applyGeometry(transmission, {
    perspective: {
      topLeft: { x: 0, y: 0 }, topRight: { x: 1, y: 0 },
      bottomRight: { x: 1, y: 1 }, bottomLeft: { x: 0, y: 1 },
    },
  });

  assert.equal(result.width, 2);
  assert.equal(result.height, 2);
  for (let index = 0; index < transmission.data.length; index += 1) {
    near(result.data[index], transmission.data[index]);
  }
});

test("fine rotation constrains the image without introducing empty corners", () => {
  const source = Raster.filled(12, 8, "transmission-linear-rgb", [0.4, 0.3, 0.2]);
  const result = rotateAndConstrain(source, 7.5);

  assert.equal(result.width, source.width);
  assert.equal(result.height, source.height);
  for (let index = 0; index < result.data.length; index += 3) {
    near(result.data[index], 0.4);
    near(result.data[index + 1], 0.3);
    near(result.data[index + 2], 0.2);
  }
});

test("film-base sampling and density anchors use the final cropped frame", () => {
  const source = raster("transmission-linear-rgb", 4, 2, [
    0.5, 0.25, 0.125, 0.5, 0.25, 0.125, 0.25, 0.125, 0.0625, 0.25, 0.125, 0.0625,
    0.5, 0.25, 0.125, 0.5, 0.25, 0.125, 0.25, 0.125, 0.0625, 0.25, 0.125, 0.0625,
  ]);
  const result = processFilm(source, {
    baseRoi: { x: 0, y: 0, width: 1, height: 1 },
    geometry: { crop: { x: 0.5, y: 0, width: 0.5, height: 1 } },
    film: { kind: "generic" },
  });

  assert.equal(result.transmission.width, 2);
  near(result.base.rgb[0], 0.25);
  near(result.base.rgb[1], 0.125);
  near(result.base.rgb[2], 0.0625);
  near(result.density.data[0], 0);
  near(result.densityAnchors.range, 0);
});

test("automatic alignment detects a tilted film-frame edge", () => {
  const width = 240;
  const height = 160;
  const rgba = new Uint8Array(width * height * 4);
  const slope = Math.tan(5 * Math.PI / 180);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const upper = 30 + (x - width / 2) * slope;
      const lower = 128 + (x - width / 2) * slope;
      const value = y > upper && y < lower ? 230 : 18;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
  }
  const estimate = estimateAlignmentFromRgba(rgba, width, height);

  assert.ok(estimate.confidence > 0.2);
  near(estimate.correctionDegrees, -5, 0.6);
});

test("automatic alignment favours paired film edges over interior texture", () => {
  const width = 300;
  const height = 200;
  const rgba = new Uint8Array(width * height * 4);
  const radians = 4 * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const centeredX = x - width / 2;
      const centeredY = y - height / 2;
      const localX = cosine * centeredX + sine * centeredY;
      const localY = -sine * centeredX + cosine * centeredY;
      const inside = Math.abs(localX) < 132 && Math.abs(localY) < 76;
      const textured = ((Math.floor(x / 18) + Math.floor(y / 14)) & 1) === 0;
      const value = inside ? (textured ? 165 : 92) : 12;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
  }

  const estimate = estimateAlignmentFromRgba(rgba, width, height);

  assert.ok(estimate.confidence > 0.12);
  near(estimate.correctionDegrees, -4, 0.7);
});

test("automatic crop follows the exposed image area without retaining a film-base border", () => {
  const width = 320;
  const height = 220;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      let value = 12;
      if (x >= 20 && x < 300 && y >= 15 && y < 205) value = 212;
      if (x >= 38 && x < 282 && y >= 32 && y < 188) value = 48 + ((x * 7 + y * 11) % 90);
      rgba[offset] = value;
      rgba[offset + 1] = Math.round(value * 0.82);
      rgba[offset + 2] = Math.round(value * 0.58);
      rgba[offset + 3] = 255;
    }
  }

  const estimate = estimateFilmFrameCropFromRgba(rgba, width, height);

  assert.ok(estimate.confidence > 0.25);
  near(estimate.crop.x, 38 / width, 0.03);
  near(estimate.crop.y, 32 / height, 0.03);
  near(estimate.crop.x + estimate.crop.width, 282 / width, 0.03);
  near(estimate.crop.y + estimate.crop.height, 188 / height, 0.03);
});

test("tone mapping preserves a neutral colour axis", () => {
  const scene = raster("scene-linear-rgb", 1, 1, [0.5, 0.5, 0.5]);
  const result = toneMap(scene, { contrast: 1.5, saturation: 0.5 });

  near(result.data[0], result.data[1]);
  near(result.data[1], result.data[2]);
});

test("highlight compression rolls HDR luminance into display range", () => {
  const scene = raster("scene-linear-rgb", 4, 1, [
    0.5, 0.5, 0.5,
    1, 1, 1,
    2, 2, 2,
    8, 8, 8,
  ]);
  const result = toneMap(scene, { highlightCompression: 0.5 });

  assert.ok(result.data[0] < result.data[3]);
  assert.ok(result.data[3] < result.data[6]);
  assert.ok(result.data[6] < result.data[9]);
  assert.ok(result.data.every((value) => value >= 0 && value < 1));
});

test("display white estimation ignores frame borders and density beyond Dmax", () => {
  const width = 20;
  const height = 20;
  const density = Raster.filled(width, height, "relative-density", [0.5, 0.5, 0.5]);
  const scene = Raster.filled(width, height, "scene-linear-rgb", [1, 1, 1]);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1 || (x === 10 && y === 10)) {
        const offset = (y * width + x) * 3;
        scene.data[offset] = 100;
        scene.data[offset + 1] = 100;
        scene.data[offset + 2] = 100;
        if (x === 10 && y === 10) {
          density.data[offset] = 2;
          density.data[offset + 1] = 2;
          density.data[offset + 2] = 2;
        }
      }
    }
  }

  near(estimateDisplayWhitePoint(density, scene, { dmin: 0.2, dmax: 1.2, range: 1 }, 1), 1);
});

test("fused preview tone mapping matches canonical display conversion", () => {
  const scene = raster("scene-linear-rgb", 3, 1, [0.02, 0.2, 0.8, 0.4, 0.5, 0.6, 1.2, 0.8, 0.3]);
  const settings = { exposureStops: 0.3, contrast: 1.2, highlightCompression: 0.4, saturation: 0.85 };

  assert.deepEqual(toneMapToSrgbRgba(scene, settings), rasterToSrgbRgba(toneMap(scene, settings)));
});

test("the complete pipeline routes a camera-linear image through all core domains", () => {
  const source = raster("camera-linear-rgb", 4, 2, [
    0.5, 0.25, 0.125, 0.5, 0.25, 0.125, 0.25, 0.125, 0.0625, 0.25, 0.125, 0.0625,
    0.5, 0.25, 0.125, 0.5, 0.25, 0.125, 0.25, 0.125, 0.0625, 0.25, 0.125, 0.0625,
  ]);
  const result = processFilm(source, {
    baseRoi: { x: 0, y: 0, width: 0.5, height: 1 },
    film: { kind: "generic" },
  });

  assert.equal(result.transmission.domain, "transmission-linear-rgb");
  assert.equal(result.density.domain, "relative-density");
  assert.equal(result.sceneLinear.domain, "scene-linear-rgb");
  assert.equal(result.displayLinear.domain, "display-linear-rgb");
  assert.ok(result.sceneLinear.data[6] > result.sceneLinear.data[0]);
});

test("scene-stage processing matches the invariant outputs of the complete pipeline", () => {
  const source = raster("transmission-linear-rgb", 4, 2, [
    0.5, 0.25, 0.125, 0.5, 0.25, 0.125, 0.25, 0.125, 0.0625, 0.25, 0.125, 0.0625,
    0.5, 0.25, 0.125, 0.5, 0.25, 0.125, 0.25, 0.125, 0.0625, 0.25, 0.125, 0.0625,
  ]);
  const settings = {
    baseRoi: { x: 0, y: 0, width: 0.5, height: 1 },
    film: { kind: "generic" as const },
    tone: { exposureStops: 0.25, contrast: 1.1, highlightCompression: 0.3, saturation: 0.9 },
  };
  const scene = processFilmToScene(source, settings);
  const complete = processFilm(source, settings);

  assert.deepEqual(scene.base, complete.base);
  assert.deepEqual(scene.densityAnchors, complete.densityAnchors);
  assert.deepEqual(scene.sceneLinear.data, complete.sceneLinear.data);
  assert.deepEqual(
    toneMap(scene.sceneLinear, { ...settings.tone, whitePoint: scene.displayWhitePoint }).data,
    complete.displayLinear.data,
  );
});

function raster(
  domain: "camera-linear-rgb" | "transmission-linear-rgb" | "relative-density" | "scene-linear-rgb",
  width: number,
  height: number,
  values: readonly number[],
): Raster {
  return new Raster(width, height, domain, new Float32Array(values));
}

function identityLut(size: number): Lut3d {
  const data = new Float32Array(size * size * size * 3);
  for (let red = 0; red < size; red += 1) {
    for (let green = 0; green < size; green += 1) {
      for (let blue = 0; blue < size; blue += 1) {
        const offset = (((red * size + green) * size + blue) * 3);
        data[offset] = red / (size - 1);
        data[offset + 1] = green / (size - 1);
        data[offset + 2] = blue / (size - 1);
      }
    }
  }
  return { size, data };
}

function near(actual: number, expected: number, tolerance = 1e-5): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, "Expected " + actual + " to be within " + tolerance + " of " + expected + ".");
}
