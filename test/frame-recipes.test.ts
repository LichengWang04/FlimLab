import assert from "node:assert/strict";
import test from "node:test";

import type { FilmRoll } from "../src/shared/project.ts";
import {
  createNeutralFrameRecipe,
  resolveFrameRecipe,
  withFrameRecipe,
  withRollFrameRecipe,
  withoutFrameRecipe,
} from "../src/renderer/src/frame-recipes.ts";

const roll: FilmRoll = {
  id: "roll-a",
  title: "Roll A",
  assets: [
    { id: "frame-a", name: "a.tif", extension: "TIF" },
    { id: "frame-b", name: "b.tif", extension: "TIF" },
  ],
  frameOrder: ["frame-a", "frame-b"],
};

test("new frames resolve to a neutral non-destructive tone recipe", () => {
  const recipe = resolveFrameRecipe(roll, "frame-a");
  assert.deepEqual(recipe.tone, {
    exposureStops: 0,
    contrast: 1,
    highlightCompression: 0,
    saturation: 1,
  });
});

test("frame recipes remain independent when another frame is edited", () => {
  const neutral = createNeutralFrameRecipe();
  const edited = {
    ...neutral,
    tone: { ...neutral.tone, exposureStops: 1.25, contrast: 1.3, saturation: 0.8 },
  };
  const nextRoll = withFrameRecipe(roll, "frame-a", edited);

  assert.deepEqual(resolveFrameRecipe(nextRoll, "frame-a").tone, edited.tone);
  assert.deepEqual(resolveFrameRecipe(nextRoll, "frame-b").tone, neutral.tone);
});

test("explicit roll-wide recipes override frame recipes without destroying them", () => {
  const frameRecipe = {
    ...createNeutralFrameRecipe(),
    tone: { ...createNeutralFrameRecipe().tone, exposureStops: 0.5 },
  };
  const withFrame = withFrameRecipe(roll, "frame-a", frameRecipe);
  const uniformRecipe = {
    ...createNeutralFrameRecipe(),
    tone: { ...createNeutralFrameRecipe().tone, saturation: 0.6 },
  };
  const uniformRoll: FilmRoll = {
    ...withFrame,
    uniformRecipe: { sourceFrameId: "frame-b", recipe: uniformRecipe },
  };

  assert.deepEqual(resolveFrameRecipe(uniformRoll, "frame-a").tone, uniformRecipe.tone);
  const restoredRoll: FilmRoll = { ...uniformRoll, uniformRecipe: undefined };
  assert.deepEqual(resolveFrameRecipe(restoredRoll, "frame-a").tone, frameRecipe.tone);
});

test("deleting a frame also removes its stored recipe", () => {
  const withFrame = withFrameRecipe(roll, "frame-a", createNeutralFrameRecipe());
  assert.equal(withoutFrameRecipe(withFrame, "frame-a").recipesByFrameId?.["frame-a"], undefined);
});

test("storing an unchanged frame recipe preserves the roll identity", () => {
  const recipe = createNeutralFrameRecipe();
  const withRecipe = withFrameRecipe(roll, "frame-a", recipe);
  assert.equal(withFrameRecipe(withRecipe, "frame-a", recipe), withRecipe);
  const rolls = [withRecipe] as const;
  assert.equal(withRollFrameRecipe(rolls, roll.id, "frame-a", recipe), rolls);
});
