import assert from "node:assert/strict";
import test from "node:test";

import { defaultProcessingRecipe } from "../src/shared/contracts.ts";
import {
  previewPerformanceProfile,
  processingForInteractivePreview,
  straightenFromReferenceLine,
} from "../src/renderer/src/preview-interaction.ts";
import { maximumBackgroundPreviewEdge } from "../src/shared/contracts.ts";

test("preview performance profile reduces interactive pixel work before refinement", () => {
  assert.equal(previewPerformanceProfile.quickMaxEdge, 768);
  assert.equal(previewPerformanceProfile.prewarmMaxEdge, 1024);
  assert.equal(previewPerformanceProfile.prewarmMaxEdge, maximumBackgroundPreviewEdge);
  assert.equal(previewPerformanceProfile.settledMaxEdge, 1280);
  assert.ok(previewPerformanceProfile.prewarmMaxEdge < previewPerformanceProfile.settledMaxEdge);
  assert.ok(previewPerformanceProfile.quickMaxEdge < previewPerformanceProfile.analysisMaxEdge);
  assert.ok(previewPerformanceProfile.analysisMaxEdge < previewPerformanceProfile.settledMaxEdge);
  assert.ok((previewPerformanceProfile.quickMaxEdge / 1920) ** 2 <= 0.25);
  assert.ok((previewPerformanceProfile.settledMaxEdge / 1920) ** 2 <= 0.57);
  assert.ok(previewPerformanceProfile.inputDebounceMs < 60);
});

test("crop editing maps the final-frame base sample back to the uncropped preview", () => {
  const processing = {
    ...defaultProcessingRecipe,
    baseRoi: { x: 0.1, y: 0.2, width: 0.25, height: 0.3 },
    geometry: {
      ...defaultProcessingRecipe.geometry,
      crop: { x: 0.1, y: 0.15, width: 0.7, height: 0.6 },
    },
  };

  const preview = processingForInteractivePreview(processing, true);

  assert.equal(preview.geometry.crop, undefined);
  assert.ok(Math.abs(preview.baseRoi.x - 0.17) < 1e-12);
  assert.ok(Math.abs(preview.baseRoi.y - 0.27) < 1e-12);
  assert.ok(Math.abs(preview.baseRoi.width - 0.175) < 1e-12);
  assert.ok(Math.abs(preview.baseRoi.height - 0.18) < 1e-12);
  assert.notEqual(preview, processing);
  assert.deepEqual(processing.geometry.crop, { x: 0.1, y: 0.15, width: 0.7, height: 0.6 });
  assert.deepEqual(processing.baseRoi, { x: 0.1, y: 0.2, width: 0.25, height: 0.3 });
});

test("preview processing preserves identity outside crop editing", () => {
  assert.equal(
    processingForInteractivePreview(defaultProcessingRecipe, false),
    defaultProcessingRecipe,
  );
});

test("ruler straightening makes a drawn horizontal reference level", () => {
  const result = straightenFromReferenceLine({ x: 0, y: 0 }, { x: 100, y: 10 }, 0);
  const reversed = straightenFromReferenceLine({ x: 100, y: 10 }, { x: 0, y: 0 }, 0);

  assert.equal(result?.axis, "horizontal");
  assert.ok(Math.abs((result?.straightenDegrees ?? 0) + 5.710593) < 1e-5);
  assert.ok(Math.abs((reversed?.straightenDegrees ?? 0) - (result?.straightenDegrees ?? 0)) < 1e-9);
});

test("ruler straightening recognises vertical references and enforces the safe angle limit", () => {
  const vertical = straightenFromReferenceLine({ x: 0, y: 0 }, { x: 10, y: 100 }, 2);
  const clamped = straightenFromReferenceLine({ x: 0, y: 0 }, { x: 100, y: 58 }, 0);

  assert.equal(vertical?.axis, "vertical");
  assert.ok((vertical?.correctionDegrees ?? 0) > 0);
  assert.equal(clamped?.straightenDegrees, -15);
  assert.equal(clamped?.clamped, true);
  assert.equal(straightenFromReferenceLine({ x: 0, y: 0 }, { x: 4, y: 4 }, 0), undefined);
});
