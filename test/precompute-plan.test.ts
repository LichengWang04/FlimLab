import assert from "node:assert/strict";
import test from "node:test";

import type { FilmRoll } from "../src/shared/project.ts";
import { createNeutralFrameRecipe, withFrameRecipe } from "../src/renderer/src/frame-recipes.ts";
import {
  createFramePrecomputePlan,
  createFramePrecomputePlanKey,
  createPrecomputeSettingsKey,
} from "../src/renderer/src/precompute-plan.ts";

const assets = ["frame-a", "frame-b", "frame-c"].map((id) => ({
  id,
  name: id + ".tif",
  extension: "TIF",
}));

function rollWithNeutralRecipes(): FilmRoll {
  const roll: FilmRoll = {
    id: "roll-a",
    title: "Roll A",
    assets,
    frameOrder: assets.map((asset) => asset.id),
  };
  return assets.reduce(
    (current, asset) => withFrameRecipe(current, asset.id, createNeutralFrameRecipe()),
    roll,
  );
}

test("editing the active frame does not restart neighbour precomputation", () => {
  const linked = new Set(assets.map((asset) => asset.id));
  const initial = rollWithNeutralRecipes();
  const initialKey = createFramePrecomputePlanKey(
    createFramePrecomputePlan(initial, "frame-a", linked),
  );
  const activeRecipe = {
    ...createNeutralFrameRecipe(),
    tone: { ...createNeutralFrameRecipe().tone, exposureStops: 1.4 },
  };
  const editedActive = withFrameRecipe(initial, "frame-a", activeRecipe);

  assert.equal(
    createFramePrecomputePlanKey(createFramePrecomputePlan(editedActive, "frame-a", linked)),
    initialKey,
  );
});

test("editing an inactive frame invalidates only its precompute plan", () => {
  const linked = new Set(assets.map((asset) => asset.id));
  const initial = rollWithNeutralRecipes();
  const initialPlan = createFramePrecomputePlan(initial, "frame-b", linked);
  assert.deepEqual(initialPlan.map((item) => item.frameId), ["frame-a", "frame-c"]);

  const neighbourRecipe = {
    ...createNeutralFrameRecipe(),
    processing: {
      ...createNeutralFrameRecipe().processing,
      filmBase: {
        kind: "reference" as const,
        rgb: [0.8, 0.55, 0.3] as const,
        origin: "sampled" as const,
        confidence: 0.95,
      },
    },
  };
  const editedNeighbour = withFrameRecipe(initial, "frame-c", neighbourRecipe);
  assert.notEqual(
    createFramePrecomputePlanKey(createFramePrecomputePlan(editedNeighbour, "frame-b", linked)),
    createFramePrecomputePlanKey(initialPlan),
  );
});

test("GPU precompute payloads are invalidated when channel gains change", () => {
  const neutral = createNeutralFrameRecipe().processing;
  const adjusted = {
    ...neutral,
    channelGains: [1.35, 0.95, 0.8] as const,
  };

  assert.notEqual(
    createPrecomputeSettingsKey("generic", undefined, neutral),
    createPrecomputeSettingsKey("generic", undefined, adjusted),
  );
});
