import assert from "node:assert/strict";
import test from "node:test";

import { restorationPassPlan } from "../src/renderer/src/webgpu-restoration.ts";
import type { RestorationControls } from "../src/shared/contracts.ts";

function controls(partial: Partial<RestorationControls>): RestorationControls {
  return { dust: false, scratches: false, denoise: 0, sharpen: 0, ...partial };
}

test("restoration pass plan chains every enabled pass from the previous output", () => {
  const all = restorationPassPlan(controls({ dust: true, denoise: 1, sharpen: 1 }));
  assert.deepEqual(all.map((step) => step.pass), [0, 1, 2, 3]);
  assert.deepEqual(all.map((step) => step.output), [0, 1, 0, 1]);
});

test("restoration pass plan never reads an unwritten scratch buffer", () => {
  // Denoise alone must start from the input, not from a dust pass that never ran.
  const denoiseOnly = restorationPassPlan(controls({ denoise: 1 }));
  assert.deepEqual(denoiseOnly.map((step) => step.pass), [1, 2]);
  assert.deepEqual(denoiseOnly.map((step) => step.output), [0, 1]);

  // Sharpen alone likewise starts from the input buffer.
  const sharpenOnly = restorationPassPlan(controls({ sharpen: 1 }));
  assert.deepEqual(sharpenOnly.map((step) => step.pass), [3]);
  assert.deepEqual(sharpenOnly.map((step) => step.output), [0]);

  // No enabled controls produce no passes.
  assert.equal(restorationPassPlan(controls({})).length, 0);
});
