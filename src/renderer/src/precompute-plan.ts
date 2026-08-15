import type { PreviewMode, ProcessingRecipe } from "../../shared/contracts.ts";
import { demoFrameId, type FilmRoll, type ProjectRecipe } from "../../shared/project.ts";
import { resolveFrameRecipe } from "./frame-recipes.ts";

export interface FramePrecomputePlanItem {
  readonly frameId: string;
  readonly recipe: ProjectRecipe;
  readonly settingsKey: string;
  readonly dmaxOverride?: number;
  readonly dmaxChannelRange?: readonly [number, number, number];
}

/**
 * Builds only the inactive-frame work. Edits to the active frame must not
 * invalidate or restart decoding already under way for its neighbours.
 */
export function createFramePrecomputePlan(
  roll: FilmRoll,
  activeFrameId: string | undefined,
  linkedAssetIds: ReadonlySet<string>,
): readonly FramePrecomputePlanItem[] {
  const activeIndex = activeFrameId === undefined ? -1 : roll.frameOrder.indexOf(activeFrameId);
  return roll.frameOrder
    .filter((frameId) => (
      frameId !== activeFrameId
      && (frameId === demoFrameId || linkedAssetIds.has(frameId))
    ))
    .sort((left, right) => (
      frameDistance(roll, left, activeIndex) - frameDistance(roll, right, activeIndex)
    ))
    .map((frameId) => {
      const recipe = resolveFrameRecipe(roll, frameId);
      const dmaxOverride = roll.manualDmax?.value;
      const dmaxChannelRange = roll.manualDmax?.channelRange;
      return {
        frameId,
        recipe,
        dmaxOverride,
        dmaxChannelRange,
        settingsKey: createPrecomputeSettingsKey(
          recipe.mode,
          recipe.calibrationProfileId,
          recipe.processing,
          dmaxOverride,
          dmaxChannelRange,
        ),
      };
    });
}

export function createFramePrecomputePlanKey(plan: readonly FramePrecomputePlanItem[]): string {
  return JSON.stringify(plan.map((item) => [
    item.frameId,
    item.recipe.view,
    item.recipe.tone,
    item.settingsKey,
  ]));
}

export function createPrecomputeSettingsKey(
  mode: PreviewMode,
  calibrationProfileId: string | undefined,
  processing: ProcessingRecipe,
  dmaxOverride?: number,
  dmaxChannelRange?: readonly [number, number, number],
): string {
  return JSON.stringify([
    mode,
    calibrationProfileId ?? null,
    processing.baseRoi,
    processing.filmBase ?? null,
    // Channel gains are expanded into the FilmMode that travels with the GPU
    // payload. Unlike geometry, restoration, view and tone, they are not live
    // renderer uniforms, so reusing a payload across gain changes would leave
    // the WebGL preview on the previous white balance.
    processing.channelGains ?? [1, 1, 1],
    processing.autoNeutralDmax ?? false,
    processing.preSaturation ?? 1.08,
    dmaxOverride ?? null,
    dmaxChannelRange ?? null,
  ]);
}

function frameDistance(roll: FilmRoll, frameId: string, activeIndex: number): number {
  if (activeIndex < 0) return roll.frameOrder.indexOf(frameId);
  return Math.abs(roll.frameOrder.indexOf(frameId) - activeIndex);
}
