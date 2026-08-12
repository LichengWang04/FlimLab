import assert from "node:assert/strict";
import test from "node:test";

import {
  computeGeometryLayout,
  fitPreviewIntoBounds,
  resolvePreviewDisplaySize,
} from "../src/renderer/src/preview-layout.ts";

test("GPU preview layout keeps rotation, perspective and crop output dimensions", () => {
  const geometry = {
    rotation: 90 as const,
    perspective: {
      topLeft: { x: 0, y: 0 },
      topRight: { x: 0.6, y: 0 },
      bottomRight: { x: 0.6, y: 1 },
      bottomLeft: { x: 0, y: 1 },
    },
    crop: { x: 0.1, y: 0.2, width: 0.4, height: 0.5 },
  };

  const layout = computeGeometryLayout(1280, 850, geometry);

  assert.deepEqual(layout, {
    geometryWidth: 510,
    geometryHeight: 1280,
    outputWidth: 204,
    outputHeight: 640,
    cropLeft: 51,
    cropTop: 256,
  });
  assert.deepEqual(
    resolvePreviewDisplaySize({
      width: 1280,
      height: 850,
      gpuPipeline: { sourceWidth: 1280, sourceHeight: 850 },
    }, geometry),
    { width: 204, height: 640 },
  );
});

test("preview fitting uses one scale for both axes and never clips a tall crop", () => {
  const fit = fitPreviewIntoBounds(203, 510, 660, 407);

  assert.ok(Math.abs(fit.width - 162.00196078431372) < 1e-9);
  assert.equal(fit.height, 407);
  assert.ok(Math.abs(fit.width / fit.height - 203 / 510) < 1e-12);
  assert.ok(fit.width <= 660);
  assert.ok(fit.height <= 407);
});

test("preview fitting preserves 100 percent size when the crop already fits", () => {
  assert.deepEqual(
    fitPreviewIntoBounds(536, 357, 660, 407),
    { width: 536, height: 357, scale: 1 },
  );
});

test("preview fitting keeps a wide crop complete and proportional", () => {
  const fit = fitPreviewIntoBounds(1178, 783, 660, 407);

  assert.ok(Math.abs(fit.width - 612.3192848020434) < 1e-9);
  assert.equal(fit.height, 407);
  assert.ok(Math.abs(fit.width / fit.height - 1178 / 783) < 1e-12);
});

test("geometry crop rounds outward so first and last edge pixels remain present", () => {
  const layout = computeGeometryLayout(101, 79, {
    crop: { x: 0.101, y: 0.099, width: 0.503, height: 0.507 },
  });

  assert.equal(layout.cropLeft, Math.floor(0.101 * 101));
  assert.equal(layout.cropTop, Math.floor(0.099 * 79));
  assert.equal(layout.outputWidth, Math.ceil(0.604 * 101) - layout.cropLeft);
  assert.equal(layout.outputHeight, Math.ceil(0.606 * 79) - layout.cropTop);
});

test("non-GPU preview sizing uses the rendered fallback dimensions", () => {
  assert.deepEqual(
    resolvePreviewDisplaySize({ width: 768, height: 510 }, { rotation: 90 }),
    { width: 768, height: 510 },
  );
});
