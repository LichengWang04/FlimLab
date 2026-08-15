import { defaultProcessingRecipe } from "../../shared/contracts.ts";
import type { FilmRoll, ProjectRecipe } from "../../shared/project.ts";

/**
 * New frames start from the decoded source with no creative tone offset.
 * Film inversion still comes from the selected mode; these values only avoid
 * carrying edits from the previously active frame.
 */
export function createNeutralFrameRecipe(): ProjectRecipe {
  return {
    mode: "generic",
    view: "positive",
    tone: {
      exposureStops: 0,
      contrast: 1,
      highlightCompression: 0,
      saturation: 1,
    },
    processing: cloneProcessingRecipe(defaultProcessingRecipe),
  };
}

export function resolveFrameRecipe(
  roll: FilmRoll,
  frameId: string | undefined,
  fallback?: ProjectRecipe,
): ProjectRecipe {
  const recipe = roll.uniformRecipe?.recipe
    ?? (frameId === undefined ? undefined : roll.recipesByFrameId?.[frameId])
    ?? fallback
    ?? createNeutralFrameRecipe();
  return cloneFrameRecipe(recipe);
}

export function withFrameRecipe(
  roll: FilmRoll,
  frameId: string,
  recipe: ProjectRecipe,
): FilmRoll {
  if (!roll.frameOrder.includes(frameId) || roll.uniformRecipe !== undefined) return roll;
  const previous = roll.recipesByFrameId?.[frameId];
  if (previous !== undefined && frameRecipesEqual(previous, recipe)) return roll;
  return {
    ...roll,
    recipesByFrameId: {
      ...roll.recipesByFrameId,
      [frameId]: cloneFrameRecipe(recipe),
    },
  };
}

export function withRollFrameRecipe(
  rolls: readonly FilmRoll[],
  rollId: string,
  frameId: string,
  recipe: ProjectRecipe,
): readonly FilmRoll[] {
  const index = rolls.findIndex((roll) => roll.id === rollId);
  const roll = rolls[index];
  if (index < 0 || roll === undefined) return rolls;
  const nextRoll = withFrameRecipe(roll, frameId, recipe);
  if (nextRoll === roll) return rolls;
  const next = [...rolls];
  next[index] = nextRoll;
  return next;
}

export function withoutFrameRecipe(roll: FilmRoll, frameId: string): FilmRoll {
  if (roll.recipesByFrameId?.[frameId] === undefined) return roll;
  const recipesByFrameId = { ...roll.recipesByFrameId };
  delete recipesByFrameId[frameId];
  return {
    ...roll,
    ...(Object.keys(recipesByFrameId).length === 0 ? { recipesByFrameId: undefined } : { recipesByFrameId }),
  };
}

export function cloneFrameRecipe(value: ProjectRecipe): ProjectRecipe {
  return {
    mode: value.mode,
    view: value.view,
    tone: { ...value.tone },
    calibrationProfileId: value.calibrationProfileId,
    processing: cloneProcessingRecipe(value.processing),
  };
}

export function cloneProcessingRecipe(value: ProjectRecipe["processing"]): ProjectRecipe["processing"] {
  return {
    baseRoi: { ...value.baseRoi },
    filmBase: value.filmBase === undefined
      ? undefined
      : value.filmBase.kind === "automatic"
        ? { kind: "automatic" }
        : {
            ...value.filmBase,
            rgb: [...value.filmBase.rgb] as [number, number, number],
          },
    geometry: {
      ...value.geometry,
      crop: value.geometry.crop === undefined ? undefined : { ...value.geometry.crop },
      perspective: value.geometry.perspective === undefined ? undefined : {
        topLeft: { ...value.geometry.perspective.topLeft },
        topRight: { ...value.geometry.perspective.topRight },
        bottomRight: { ...value.geometry.perspective.bottomRight },
        bottomLeft: { ...value.geometry.perspective.bottomLeft },
      },
    },
    restoration: { ...value.restoration },
    channelGains: value.channelGains === undefined
      ? undefined
      : [...value.channelGains] as [number, number, number],
    autoNeutralDmax: value.autoNeutralDmax,
    preSaturation: value.preSaturation,
  };
}

function frameRecipesEqual(left: ProjectRecipe, right: ProjectRecipe): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
