import assert from "node:assert/strict";
import test from "node:test";

import {
  denoiseEdgePreserving,
  detectDust,
  detectScratches,
  Raster,
  removeDust,
  removeScratches,
  RepairAbortedError,
  sharpenUnsharp,
} from "../src/core/index.ts";

test("dust detection finds a single neutral outlier and median inpainting removes it", () => {
  const source = Raster.filled(5, 5, "transmission-linear-rgb", [0.5, 0.5, 0.5]);
  source.setPixel(2, 2, [1, 1, 1]);

  const mask = detectDust(source);
  const repaired = removeDust(source, mask);

  assert.equal(mask.data[2 + 2 * source.width], 1);
  assert.equal(repaired.domain, source.domain);
  assert.deepEqual(repaired.getPixel(2, 2), [0.5, 0.5, 0.5]);
  assert.deepEqual(source.getPixel(2, 2), [1, 1, 1]);
});

test("scratch repair finds a continuous vertical dark mark and samples across it", () => {
  const source = Raster.filled(5, 9, "scene-linear-rgb", [0.5, 0.5, 0.5]);
  for (let y = 0; y < source.height; y += 1) {
    source.setPixel(2, y, [0.1, 0.1, 0.1]);
  }

  const mask = detectScratches(source, { orientation: "vertical", halfWidth: 1, minLength: 8 });
  const repaired = removeScratches(source, mask);

  assert.equal(mask.vertical[4 * source.width + 2], 1);
  assert.deepEqual(repaired.getPixel(2, 4), [0.5, 0.5, 0.5]);
  assert.equal(mask.horizontal[4 * source.width + 2], 0);
});

test("bilateral denoise reduces a flat-field impulse without changing the raster domain", () => {
  const source = Raster.filled(3, 3, "display-linear-rgb", [0.5, 0.5, 0.5]);
  source.setPixel(1, 1, [0.6, 0.6, 0.6]);

  const denoised = denoiseEdgePreserving(source, { radius: 1, spatialSigma: 1, rangeSigma: 0.5 });

  assert.equal(denoised.domain, "display-linear-rgb");
  assert.ok(denoised.getPixel(1, 1)[0] < 0.6);
  assert.ok(denoised.getPixel(1, 1)[0] > 0.5);
});

test("unsharp masking boosts detail only above its configured threshold", () => {
  const source = Raster.filled(3, 1, "scene-linear-rgb", [0.5, 0.5, 0.5]);
  source.setPixel(1, 0, [0.6, 0.6, 0.6]);

  const sharpened = sharpenUnsharp(source, { radius: 1, sigma: 1, amount: 1, threshold: 0.001 });
  const thresholdedOut = sharpenUnsharp(source, { radius: 1, sigma: 1, amount: 1, threshold: 1 });

  assert.ok(sharpened.getPixel(1, 0)[0] > source.getPixel(1, 0)[0]);
  assert.deepEqual(thresholdedOut.getPixel(1, 0), source.getPixel(1, 0));
});

test("restoration reports deterministic stage progress and honours cancellation", () => {
  const source = Raster.filled(4, 4, "transmission-linear-rgb", [0.5, 0.5, 0.5]);
  const events: string[] = [];
  detectDust(source, {}, { onProgress: (progress) => events.push(progress.stage + ":" + progress.completed) });
  assert.equal(events[0], "dust-detection:0");
  assert.equal(events.at(-1), "dust-detection:4");

  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => detectDust(source, {}, { signal: controller.signal }),
    RepairAbortedError,
  );
});
