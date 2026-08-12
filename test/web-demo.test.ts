import assert from "node:assert/strict";
import test from "node:test";

import { createWebDemoApi } from "../src/renderer/src/web-demo.ts";
import { defaultProcessingRecipe, type PreviewRequest } from "../src/shared/contracts.ts";
import { demoFrameId } from "../src/shared/project.ts";

test("browser demo starts with a renderable built-in frame", async () => {
  const api = createWebDemoApi();
  const project = (await api.loadProject()).project;

  assert.deepEqual(project.rolls[0]?.frameOrder, [demoFrameId]);

  const request: PreviewRequest = {
    revision: 7,
    assetId: demoFrameId,
    maxEdge: 256,
    mode: "preset",
    view: "positive",
    tone: { exposureStops: 0, contrast: 1.16, highlightCompression: 0.5, saturation: 1.04 },
    processing: defaultProcessingRecipe,
  };
  const preview = await api.renderPreview(request);
  const precomputed = await api.precomputePreview({ ...request, revision: 8 });

  assert.equal(preview.revision, request.revision);
  assert.equal(preview.width, request.maxEdge);
  assert.equal(preview.rgba.length, preview.width * preview.height * 4);
  assert.equal(preview.sceneLinear?.length, preview.width * preview.height * 3);
  assert.equal(preview.displayWhitePoint, 1);
  assert.ok(preview.gpuPipeline !== undefined);
  assert.equal(
    preview.gpuPipeline.sourceBayer?.length,
    preview.gpuPipeline.sourceWidth * preview.gpuPipeline.sourceHeight,
  );
  assert.deepEqual(preview.gpuPipeline.bayerPattern, [0, 1, 1, 2]);
  assert.equal(preview.gpuPipeline?.film.kind, "preset");
  assert.deepEqual(preview.colorTrust, { level: "uncalibrated", reason: "default-preset" });
  assert.equal(precomputed.revision, 8);
  assert.equal(precomputed.gpuPipeline?.sourceKey, preview.gpuPipeline?.sourceKey);

  const reused = await api.renderPreview({
    ...request,
    revision: 2,
    gpuReuseSourceKey: preview.gpuPipeline?.sourceKey,
  });
  assert.equal(reused.gpuPipeline?.sourceKey, preview.gpuPipeline?.sourceKey);
  assert.equal(reused.gpuPipeline?.sourceBayer, undefined);
});

test("browser demo exposes automatic and frozen borderless film-base states", async () => {
  const api = createWebDemoApi();
  const automatic = await api.renderPreview({
    revision: 8,
    assetId: demoFrameId,
    maxEdge: 128,
    mode: "preset",
    view: "transmission",
    tone: { exposureStops: 0, contrast: 1.16, highlightCompression: 0.5, saturation: 1.04 },
    processing: { ...defaultProcessingRecipe, filmBase: { kind: "automatic" } },
  });

  assert.equal(automatic.base.method, "automatic");
  assert.ok(automatic.base.confidence <= 0.65);
  assert.equal(automatic.sceneLinear, undefined);
  assert.equal(automatic.displayWhitePoint, undefined);
  assert.equal(automatic.gpuPipeline?.sourceBayer?.length, automatic.width * automatic.height);

  const frozen = await api.renderPreview({
    revision: 9,
    assetId: demoFrameId,
    maxEdge: 128,
    mode: "preset",
    view: "positive",
    tone: { exposureStops: 0, contrast: 1.16, highlightCompression: 0.5, saturation: 1.04 },
    processing: {
      ...defaultProcessingRecipe,
      filmBase: {
        kind: "reference",
        rgb: automatic.base.rgb,
        origin: "estimated",
        confidence: automatic.base.confidence,
      },
    },
  });

  assert.equal(frozen.base.method, "reference");
  assert.deepEqual(frozen.base.rgb, automatic.base.rgb);
  assert.equal(frozen.base.confidence, automatic.base.confidence);
});
