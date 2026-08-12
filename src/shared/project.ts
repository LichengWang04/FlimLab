import type { PreviewMode, PreviewTone, PreviewView, ProcessingRecipe } from "./contracts.ts";

export const projectSchemaVersion = 8 as const;
export const demoFrameId = "demo-negative" as const;

export interface SourceFingerprint {
  readonly algorithm: "sha256-full-v1";
  readonly value: string;
}

/** Shareable source identity. It intentionally contains no filesystem path. */
export interface SourceIdentity {
  readonly size: number;
  readonly lastModifiedAt: string;
  readonly fingerprint: SourceFingerprint;
}

export interface SourceAsset {
  readonly id: string;
  readonly name: string;
  readonly extension: string;
  /** Optional only for projects migrated from schema versions before v8. */
  readonly identity?: SourceIdentity;
}

/** A logical film roll in the workspace. Source paths remain main-process-only. */
export interface FilmRoll {
  readonly id: string;
  readonly title: string;
  readonly assets: readonly SourceAsset[];
  /** Ordered renderer-safe frame IDs. The optional built-in demo uses demoFrameId. */
  readonly frameOrder: readonly string[];
  /**
   * Independent frame recipes. Project storage normalizes this optional input
   * into a complete mapping whose keys exactly follow `frameOrder`.
   */
  readonly recipesByFrameId?: Readonly<Record<string, ProjectRecipe>>;
  /** Optional roll-wide recipe captured from one frame and reused by every frame. */
  readonly uniformRecipe?: RollUniformRecipe;
  /** Optional manual Dmax measured from one frame and applied to every frame. */
  readonly manualDmax?: RollDmaxOverride;
}

export interface RollDmaxOverride {
  readonly value: number;
  readonly sourceFrameId: string;
}

export interface ProjectRecipe {
  readonly mode: PreviewMode;
  readonly view: PreviewView;
  readonly tone: PreviewTone;
  readonly calibrationProfileId?: string;
  readonly processing: ProcessingRecipe;
}

/** A deliberate snapshot that makes one frame the inversion source for a roll. */
export interface RollUniformRecipe {
  readonly sourceFrameId: string;
  readonly recipe: ProjectRecipe;
}

/** A named, project-local recipe. Presets intentionally contain no paths. */
export interface ProjectPreset {
  readonly id: string;
  readonly label: string;
  readonly recipe: ProjectRecipe;
}

/**
 * A renderer-safe project document. It contains durable source identities but
 * deliberately no filesystem paths. Absolute locations live only in a local,
 * machine-private index maintained by the main process.
 */
export interface WorkspaceProject {
  readonly schemaVersion: typeof projectSchemaVersion;
  readonly rolls: readonly FilmRoll[];
  readonly activeRollId: string;
  /** Neutral fallback used to initialize frames that do not yet have a recipe. */
  readonly recipe: ProjectRecipe;
  readonly presets: readonly ProjectPreset[];
  readonly updatedAt: string;
}

export interface WorkspaceProjectDraft {
  readonly rolls: readonly FilmRoll[];
  readonly activeRollId: string;
  readonly recipe: ProjectRecipe;
  readonly presets?: readonly ProjectPreset[];
}
