import assert from "node:assert/strict";
import test from "node:test";

import {
  createColorCardGrid,
  createColorChartPatches,
  detectColorCardGrid,
  fitColorCardRaster,
  Raster,
  sampleColorCardSwatches,
} from "../src/core/index.ts";
import type { ColorCardReferencePatch, Matrix3, Rgb } from "../src/core/index.ts";

const layout = { columns: 6, rows: 4 } as const;
const sourceValues = buildSources();
const expectedMatrix: Matrix3 = [
  [1.08, 0.07, -0.03],
  [0.04, 0.93, 0.09],
  [-0.02, 0.11, 1.02],
];

test("detectColorCardGrid locates a regular axis-aligned swatch grid", () => {
  const fixture = colorCardRaster();
  const grid = detectColorCardGrid(fixture.raster, { layout, minimumSwatchSize: 10 });

  near(grid.bounds.left, fixture.bounds.left, 1);
  near(grid.bounds.top, fixture.bounds.top, 1);
  near(grid.bounds.right, fixture.bounds.right, 1);
  near(grid.bounds.bottom, fixture.bounds.bottom, 1);
  assert.equal(grid.swatches.length, 24);
  assert.equal(grid.swatches[0].index, 0);
  assert.equal(grid.swatches[23].row, 3);
  assert.equal(grid.swatches[23].column, 5);
  assert.ok(grid.edgeScore > 0);
});

test("color-card swatch sampling rejects isolated dust while preserving the median patch values", () => {
  const fixture = colorCardRaster();
  const grid = createColorCardGrid(layout, fixture.bounds);
  fixture.raster.setPixel(25, 25, [20, 20, 20]);
  fixture.raster.setPixel(26, 25, [-10, -10, -10]);
  const samples = sampleColorCardSwatches(fixture.raster, grid);

  assert.equal(samples.length, sourceValues.length);
  assert.ok(samples[0].rejectedCount >= 2);
  nearRgb(samples[0].rgb, sourceValues[0]);
  nearRgb(samples[19].rgb, sourceValues[19]);
});

test("fitting a sampled color card produces existing calibration matrix-fit input", () => {
  const fixture = colorCardRaster();
  const references: ColorCardReferencePatch[] = sourceValues.map((source, index) => ({
    id: "patch-" + (index + 1),
    target: multiply(expectedMatrix, source),
  }));
  const result = fitColorCardRaster(fixture.raster, references, {
    detection: { layout, minimumSwatchSize: 10 },
    matrix: { minimumPatchCount: 18, ridgeLambda: 1e-12 },
  });

  assert.equal(result.patches.length, 24);
  assert.equal(result.matrixFit.usedPatchCount, 24);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      near(result.matrixFit.matrix[row][column], expectedMatrix[row][column], 1e-6);
    }
  }
});

test("color-card patch conversion enforces reference order and unique ids", () => {
  const fixture = colorCardRaster();
  const samples = sampleColorCardSwatches(fixture.raster, createColorCardGrid(layout, fixture.bounds));
  assert.throws(
    () => createColorChartPatches(samples, [{ id: "only-one", target: [0, 0, 0] }]),
    /reference count/,
  );
  assert.throws(
    () => createColorChartPatches(samples, samples.map(() => ({ id: "duplicate", target: [0, 0, 0] }))),
    /ids must be unique/,
  );
});

function colorCardRaster(): { readonly raster: Raster; readonly bounds: { left: number; top: number; right: number; bottom: number } } {
  const raster = Raster.filled(132, 104, "scene-linear-rgb", [0.012, 0.018, 0.024]);
  const bounds = { left: 20, top: 20, right: 104, bottom: 76 };
  const cellWidth = (bounds.right - bounds.left) / layout.columns;
  const cellHeight = (bounds.bottom - bounds.top) / layout.rows;
  for (let row = 0; row < layout.rows; row += 1) {
    for (let column = 0; column < layout.columns; column += 1) {
      const source = sourceValues[row * layout.columns + column];
      const left = bounds.left + column * cellWidth;
      const top = bounds.top + row * cellHeight;
      for (let y = top; y < top + cellHeight; y += 1) {
        for (let x = left; x < left + cellWidth; x += 1) {
          raster.setPixel(x, y, source);
        }
      }
    }
  }
  return { raster, bounds };
}

function buildSources(): Rgb[] {
  const values: Rgb[] = [];
  for (let row = 0; row < layout.rows; row += 1) {
    for (let column = 0; column < layout.columns; column += 1) {
      values.push([
        0.10 + column * 0.09 + row * 0.018,
        0.14 + row * 0.12 + column * 0.013,
        0.08 + ((row * 2 + column * 3) % 7) * 0.075,
      ]);
    }
  }
  return values;
}

function multiply(matrix: Matrix3, value: Rgb): Rgb {
  return [
    matrix[0][0] * value[0] + matrix[0][1] * value[1] + matrix[0][2] * value[2],
    matrix[1][0] * value[0] + matrix[1][1] * value[1] + matrix[1][2] * value[2],
    matrix[2][0] * value[0] + matrix[2][1] * value[1] + matrix[2][2] * value[2],
  ];
}

function nearRgb(actual: Rgb, expected: Rgb, tolerance = 1e-6): void {
  near(actual[0], expected[0], tolerance);
  near(actual[1], expected[1], tolerance);
  near(actual[2], expected[2], tolerance);
}

function near(actual: number, expected: number, tolerance = 1e-6): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, "Expected " + actual + " to be within " + tolerance + " of " + expected + ".");
}
