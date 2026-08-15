import assert from "node:assert/strict";
import test from "node:test";

import { renderDemoPreview } from "../src/main/preview-service.ts";
import { defaultProcessingRecipe, type PreviewRequest } from "../src/shared/contracts.ts";

function request(revision: number, rotation: 0 | 90 = 0, exposureStops = 0, maxEdge = 256): PreviewRequest {
  return {
    revision,
    assetId: "demo-negative",
    maxEdge,
    mode: "generic",
    view: "positive",
    tone: { exposureStops, contrast: 1.16, highlightCompression: 0.5, saturation: 1.04 },
    processing: {
      ...defaultProcessingRecipe,
      baseRoi: { ...defaultProcessingRecipe.baseRoi },
      geometry: { ...defaultProcessingRecipe.geometry, rotation },
      restoration: { ...defaultProcessingRecipe.restoration },
    },
  };
}

test("demo preview reuses invariant processing while applying new tone settings", () => {
  const first = renderDemoPreview(request(1));
  const adjusted = renderDemoPreview(request(2, 0, 0.5));

  assert.equal(first.width, adjusted.width);
  assert.equal(first.height, adjusted.height);
  assert.deepEqual(first.base, adjusted.base);
  assert.equal(first.sceneLinear?.length, first.width * first.height * 3);
  assert.deepEqual(first.sceneLinear, adjusted.sceneLinear);
  assert.ok((first.displayWhitePoint ?? 0) > 0);
  assert.equal(first.gpuPipeline?.sourceLinear?.length, 256 * Math.round(256 * 0.664) * 3);
  assert.equal(first.gpuPipeline?.film.kind, "generic");
  assert.deepEqual(first.colorTrust, { level: "uncalibrated", reason: "generic-mode" });
  assert.notDeepEqual(first.rgba, adjusted.rgba);
});

test("demo preview applies geometry and reports the transformed dimensions", () => {
  const normal = renderDemoPreview(request(1));
  const rotated = renderDemoPreview(request(2, 90));

  assert.equal(rotated.width, normal.height);
  assert.equal(rotated.height, normal.width);
});

test("demo preview can alternate quick and settled resolutions without losing tone updates", () => {
  const quick = renderDemoPreview(request(11, 0, 0, 256));
  const settled = renderDemoPreview(request(12, 0, 0, 384));
  const adjustedQuick = renderDemoPreview(request(13, 0, 0.4, 256));

  assert.equal(quick.width, 256);
  assert.equal(settled.width, 384);
  assert.equal(adjustedQuick.width, quick.width);
  assert.deepEqual(adjustedQuick.base, quick.base);
  assert.notDeepEqual(adjustedQuick.rgba, quick.rgba);
});

test("demo preview clamps oversized maxEdge instead of allocating in the main process", () => {
  const clamped = renderDemoPreview(request(1, 0, 0, 32_768));

  assert.equal(clamped.width, 2_048);
  assert.equal(clamped.height, Math.round(2_048 * 0.664));
  assert.equal(clamped.rgba.length, clamped.width * clamped.height * 4);
});

test("demo preview rejects full-resolution source payload requests", () => {
  assert.throws(
    () => renderDemoPreview({ ...request(1), gpuSourceOnly: true }),
    /演示模式/,
  );
});
