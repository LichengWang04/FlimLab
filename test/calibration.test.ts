import assert from "node:assert/strict";
import test from "node:test";

import { supportsExactGpuFilmCurves } from "../src/shared/gpu-film-compatibility.ts";

import {
  createCalibrationProfileDocument,
  fitColorChartMatrix,
  fitColorChartCurves,
  parseCalibrationProfileDocument,
  parseCubeLut,
  sampleLut3d,
  serializeCalibrationProfileDocument,
  toRuntimeCalibrationProfile,
} from "../src/core/index.ts";
import type { CalibrationProfile, ColorChartPatch, CurveSet, Matrix3, Rgb } from "../src/core/index.ts";

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

test("GPU curve compatibility rejects profiles that would require resampling", () => {
  const exactCurve = makeCurve(32);
  const oversizedCurve = makeCurve(33);
  const profile = (curves: CurveSet) => ({
    kind: "calibrated" as const,
    profile: {
      id: "curve-limit-test",
      version: "1.0.0",
      calibrationId: "curve-limit-test",
      captureFingerprint: "test-capture",
      curves,
      matrix: identityMatrix(),
    },
  });

  assert.equal(supportsExactGpuFilmCurves({ kind: "generic" }), true);
  assert.equal(supportsExactGpuFilmCurves(profile([exactCurve, exactCurve, exactCurve])), true);
  assert.equal(supportsExactGpuFilmCurves(profile([exactCurve, oversizedCurve, exactCurve])), false);
});

test("calibration profiles round-trip their Float32 LUT and runtime transform", () => {
  const profile: CalibrationProfile = {
    id: "portra-400-c41-copy-stand-v1",
    version: "1.0.0",
    calibrationId: "2026-07-studio-a",
    captureFingerprint: "nikon-z7ii|105mm|light-a|decoder-1",
    curves: identityCurves,
    matrix: identityMatrix(),
    lut: parseCubeLut(identityCube(2)),
  };
  const document = createCalibrationProfileDocument(profile, {
    name: "Portra 400 · Studio A",
    createdAt: "2026-07-13T12:00:00.000Z",
    capture: {
      cameraModel: "Nikon Z7 II",
      lens: "Micro 105mm",
      filmStock: "Portra 400",
      process: "C-41",
      illuminationId: "light-a",
      decoderFingerprint: "libraw-0.22.1",
      demosaic: "filmlab-linear-ahd-v1",
    },
    fit: {
      algorithm: "weighted-ridge-3x3-no-intercept-v1",
      patchCount: 24,
      warnings: ["LUT was validated separately from the matrix fit."],
    },
  });

  const serialized = serializeCalibrationProfileDocument(document);
  assert.match(serialized, /"encoding": "f32le-base64"/);
  const restored = toRuntimeCalibrationProfile(parseCalibrationProfileDocument(serialized));
  assert.equal(restored.id, profile.id);
  assert.equal(document.name, "Portra 400 · Studio A");
  assert.equal(restored.captureFingerprint, profile.captureFingerprint);
  assert.ok(restored.lut !== undefined);
  near(restored.lut?.data[17] ?? Number.NaN, profile.lut?.data[17] ?? Number.NaN);
  assert.throws(
    () => parseCalibrationProfileDocument(serialized.replace("relative-density-log10", "display-srgb")),
    /transform.sourceDomain/,
  );
});

test("CUBE parsing preserves the R-major, G-major, B-fastest row order", () => {
  const lut = parseCubeLut([
    "TITLE \"identity\"",
    "DOMAIN_MIN 0 0 0",
    "DOMAIN_MAX 1 1 1",
    "LUT_3D_SIZE 2",
    "0 0 0",
    "0 0 1",
    "0 1 0",
    "0 1 1",
    "1 0 0",
    "1 0 1",
    "1 1 0",
    "1 1 1",
  ].join("\n"));

  assert.deepEqual(Array.from(lut.data.slice(9, 12)), [0, 1, 1]);
  const sampled = sampleLut3d(lut, [0.25, 0.5, 0.75]);
  near(sampled[0], 0.25);
  near(sampled[1], 0.5);
  near(sampled[2], 0.75);
});

test("weighted ridge color-chart fit recovers a 3x3 matrix without an intercept", () => {
  const expected: Matrix3 = [
    [1.1, 0.1, -0.05],
    [0.05, 0.95, 0.08],
    [-0.04, 0.12, 1.03],
  ];
  const sources: Rgb[] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [0.7, 0.3, 0.1],
    [0.1, 0.6, 0.8],
    [0.9, 0.4, 0.6],
  ];
  const patches: ColorChartPatch[] = sources.map((source, index) => ({
      id: "patch-" + (index + 1),
      source,
      target: multiply(expected, source),
      weight: index === 0 ? 0.5 : 1,
    }));
  patches.push({
      id: "out-of-gamut-reference",
      source: [0.3, 0.2, 0.1],
      target: [9, 9, 9],
      include: false,
    });
  const result = fitColorChartMatrix(
    patches,
    { minimumPatchCount: 3, ridgeLambda: 1e-12 },
  );

  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      near(result.matrix[row][column], expected[row][column], 1e-8);
    }
  }
  assert.deepEqual(result.rejectedPatchIds, ["out-of-gamut-reference"]);
  near(result.weightedRmse, 0, 1e-9);
  assert.throws(
    () => fitColorChartMatrix(sources.slice(0, 4).map((source) => ({ source, target: source }))),
    /At least 18 included color-chart patches/,
  );
});

test("color-chart curve fitting emits monotonic characteristic curves", () => {
  const patches: ColorChartPatch[] = Array.from({ length: 18 }, (_, index) => {
    const density = 0.08 + index / 20;
    const signal = Math.pow(Math.pow(10, density) - 1, 1.25);
    return {
      id: "curve-" + index,
      source: [density, density * 0.95, density * 1.05],
      target: [signal, signal * 0.9, signal * 1.1],
    };
  });
  const curves = fitColorChartCurves(patches);
  for (const curve of curves) {
    assert.ok(curve.length >= 2);
    for (let index = 1; index < curve.length; index += 1) {
      assert.ok(curve[index].x > curve[index - 1].x);
      assert.ok(curve[index].y >= curve[index - 1].y);
    }
  }
  assert.ok(curves[0][curves[0].length - 1].y > 0);
});

function identityMatrix(): Matrix3 {
  return [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
}

function makeCurve(pointCount: number): CurveSet[0] {
  return Array.from({ length: pointCount }, (_, index) => {
    const value = index / (pointCount - 1);
    return { x: value, y: value };
  });
}

function identityCube(size: number): string {
  const rows = ["LUT_3D_SIZE " + size];
  for (let red = 0; red < size; red += 1) {
    for (let green = 0; green < size; green += 1) {
      for (let blue = 0; blue < size; blue += 1) {
        rows.push(red / (size - 1) + " " + green / (size - 1) + " " + blue / (size - 1));
      }
    }
  }
  return rows.join("\n");
}

function multiply(matrix: Matrix3, value: Rgb): Rgb {
  return [
    matrix[0][0] * value[0] + matrix[0][1] * value[1] + matrix[0][2] * value[2],
    matrix[1][0] * value[0] + matrix[1][1] * value[1] + matrix[1][2] * value[2],
    matrix[2][0] * value[0] + matrix[2][1] * value[1] + matrix[2][2] * value[2],
  ];
}

function near(actual: number, expected: number, tolerance = 1e-6): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, "Expected " + actual + " to be within " + tolerance + " of " + expected + ".");
}
