import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  defaultProcessingRecipe,
  previewModes,
  previewViews,
  type PreviewTone,
  type ProcessingGeometry,
  type ProcessingRecipe,
} from "../shared/contracts.ts";
import {
  demoFrameId,
  projectSchemaVersion,
  type FilmRoll,
  type ProjectRecipe,
  type ProjectPreset,
  type SourceAsset,
  type WorkspaceProject,
  type WorkspaceProjectDraft,
} from "../shared/project.ts";

const projectBundleName = "workspace.filmlab";
const projectFileName = "project.json";
const legacyProjectFileName = "workspace.filmlab.json";
const maximumAssets = 1_000;
const maximumRolls = 100;

export class ProjectService {
  private readonly projectDirectory: string;

  public constructor(projectDirectory: string) {
    this.projectDirectory = projectDirectory;
  }

  public async load(): Promise<WorkspaceProject> {
    try {
      const contents = await this.readProjectContents();
      return parseStoredProject(JSON.parse(contents));
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) {
        return createDefaultProject();
      }
      if (error instanceof SyntaxError) {
        throw new Error("项目文件无法读取：它不是有效的 JSON。");
      }
      if (error instanceof Error && error.message.startsWith("项目文件")) {
        throw error;
      }
      throw new Error("项目文件无法读取。");
    }
  }

  public async save(value: unknown): Promise<WorkspaceProject> {
    const draft = parseProjectDraft(value);
    const project: WorkspaceProject = {
      schemaVersion: projectSchemaVersion,
      ...draft,
      presets: draft.presets ?? [],
      updatedAt: new Date().toISOString(),
    };

    await mkdir(this.bundleDirectory, { recursive: true });
    const temporaryPath = join(this.bundleDirectory, "." + randomUUID() + ".tmp");
    try {
      await writeFile(temporaryPath, JSON.stringify(project, null, 2), "utf8");
      await rename(temporaryPath, this.filePath);
    } catch (error: unknown) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return project;
  }

  private get filePath(): string {
    return join(this.bundleDirectory, projectFileName);
  }

  private get bundleDirectory(): string {
    return join(this.projectDirectory, projectBundleName);
  }

  private async readProjectContents(): Promise<string> {
    try {
      return await readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (!hasCode(error, "ENOENT")) throw error;
      return readFile(join(this.projectDirectory, legacyProjectFileName), "utf8");
    }
  }
}

export function createDefaultProject(): WorkspaceProject {
  return {
    schemaVersion: projectSchemaVersion,
    rolls: [{
      id: "default-roll",
      title: "未命名胶卷",
      assets: [],
      frameOrder: [],
      recipesByFrameId: {},
    }],
    activeRollId: "default-roll",
    recipe: {
      mode: "preset",
      view: "positive",
      tone: {
        exposureStops: 0,
        contrast: 1,
        highlightCompression: 0,
        saturation: 1,
      },
      processing: defaultRecipeProcessing(),
    },
    presets: [],
    updatedAt: new Date().toISOString(),
  };
}

function parseStoredProject(value: unknown): WorkspaceProject {
  const record = requireRecord(value, "项目文件");
  if (
    record.schemaVersion !== projectSchemaVersion
    && record.schemaVersion !== 7
    && record.schemaVersion !== 6
    && record.schemaVersion !== 5
    && record.schemaVersion !== 4
    && record.schemaVersion !== 3
    && record.schemaVersion !== 2
    && record.schemaVersion !== 1
  ) {
    throw new Error("项目文件版本不受支持。");
  }
  const draft = record.schemaVersion === projectSchemaVersion || record.schemaVersion === 7
    ? parseProjectDraft({
        rolls: record.rolls,
        activeRollId: record.activeRollId,
        recipe: record.recipe,
        presets: record.presets,
      })
    : record.schemaVersion === 6 || record.schemaVersion === 5 || record.schemaVersion === 4
      ? parseProjectDraft({
          rolls: removeLegacyFrameRecipes(record.rolls),
          activeRollId: record.activeRollId,
          recipe: record.recipe,
          presets: record.presets,
        })
      : record.schemaVersion === 3
      ? parseProjectDraft({
          rolls: migrateRollsToExplicitFrameOrder(record.rolls),
          activeRollId: record.activeRollId,
          recipe: record.recipe,
          presets: record.presets,
        })
      : parseProjectDraft({
          rolls: [{
            id: "legacy-roll",
            title: record.title,
            assets: record.assets,
            frameOrder: createLegacyFrameOrder(record.assets),
          }],
          activeRollId: "legacy-roll",
          recipe: record.recipe,
          presets: record.presets,
        });
  if (typeof record.updatedAt !== "string" || Number.isNaN(Date.parse(record.updatedAt))) {
    throw new Error("项目文件缺少有效的保存时间。");
  }
  return {
    schemaVersion: projectSchemaVersion,
    ...draft,
    presets: draft.presets ?? [],
    updatedAt: record.updatedAt,
  };
}

function parseProjectDraft(value: unknown): WorkspaceProjectDraft {
  const record = requireRecord(value, "项目");
  const recipe = parseRecipe(record.recipe);
  const rolls = parseRolls(record.rolls, recipe);
  const activeRollId = requireBoundedString(record.activeRollId, "当前胶卷 ID", 64);
  if (!rolls.some((roll) => roll.id === activeRollId)) {
    throw new Error("当前胶卷不在项目胶卷列表中。");
  }
  const presets = parsePresets(record.presets);
  return { rolls, activeRollId, recipe, presets };
}

function parseRolls(value: unknown, fallbackRecipe: ProjectRecipe): readonly FilmRoll[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumRolls) {
    throw new Error("项目中的胶卷列表无效。");
  }
  const rolls = value.map((item) => {
    const record = requireRecord(item, "胶卷");
    const id = requireBoundedString(record.id, "胶卷 ID", 64);
    if (!/^[a-zA-Z0-9-]+$/.test(id)) {
      throw new Error("胶卷 ID 包含不支持的字符。");
    }
    const assets = parseAssets(record.assets);
    const frameOrder = parseFrameOrder(record.frameOrder, assets);
    const recipesByFrameId = parseFrameRecipes(record.recipesByFrameId, frameOrder, fallbackRecipe);
    const uniformRecipe = parseRollUniformRecipe(record.uniformRecipe, frameOrder);
    const manualDmax = parseRollDmax(record.manualDmax, frameOrder);
    return {
      id,
      title: normalizeTitle(record.title),
      assets,
      frameOrder,
      recipesByFrameId,
      ...(uniformRecipe === undefined ? {} : { uniformRecipe }),
      ...(manualDmax === undefined ? {} : { manualDmax }),
    };
  });
  if (new Set(rolls.map((roll) => roll.id)).size !== rolls.length) {
    throw new Error("项目包含重复的胶卷 ID。");
  }
  if (rolls.reduce((total, roll) => total + roll.assets.length, 0) > maximumAssets) {
    throw new Error("项目中的源文件数量超过上限。");
  }
  return rolls;
}

function parseRollDmax(
  value: unknown,
  frameOrder: readonly string[],
): FilmRoll["manualDmax"] {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "整卷手动 Dmax");
  const sourceFrameId = requireBoundedString(record.sourceFrameId, "Dmax 来源帧 ID", 128);
  if (!frameOrder.includes(sourceFrameId)) {
    throw new Error("Dmax 来源帧不在胶卷中。");
  }
  return {
    value: requireBoundedNumber(record.value, "手动 Dmax", 0, 16),
    sourceFrameId,
  };
}

function parseFrameOrder(value: unknown, assets: readonly SourceAsset[]): readonly string[] {
  if (!Array.isArray(value) || value.length > assets.length + 1) {
    throw new Error("胶卷中的帧顺序无效。");
  }
  const frameOrder = value.map((item) => requireBoundedString(item, "帧 ID", 128));
  if (new Set(frameOrder).size !== frameOrder.length) {
    throw new Error("胶卷中的帧顺序包含重复项。");
  }
  const assetIds = new Set(assets.map((asset) => asset.id));
  if (
    frameOrder.some((id) => id !== demoFrameId && !assetIds.has(id))
    || assets.some((asset) => !frameOrder.includes(asset.id))
  ) {
    throw new Error("胶卷中的帧顺序与源文件不匹配。");
  }
  return frameOrder;
}

function parseFrameRecipes(
  value: unknown,
  frameOrder: readonly string[],
  fallbackRecipe: ProjectRecipe,
): Readonly<Record<string, ProjectRecipe>> {
  const record = value === undefined ? {} : requireRecord(value, "逐帧配方");
  const frameIds = new Set(frameOrder);
  for (const frameId of Object.keys(record)) {
    if (!frameIds.has(frameId)) {
      throw new Error("逐帧配方包含不在帧顺序中的帧 ID。");
    }
  }

  return Object.fromEntries(frameOrder.map((frameId) => [
    frameId,
    parseRecipe(
      Object.prototype.hasOwnProperty.call(record, frameId)
        ? record[frameId]
        : fallbackRecipe,
    ),
  ]));
}

function parseRollUniformRecipe(
  value: unknown,
  frameOrder: readonly string[],
): FilmRoll["uniformRecipe"] | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "整卷统一反转");
  const sourceFrameId = requireBoundedString(record.sourceFrameId, "整卷反转来源帧 ID", 128);
  if (!frameOrder.includes(sourceFrameId)) {
    throw new Error("整卷反转来源帧不在胶卷中。");
  }
  return {
    sourceFrameId,
    recipe: parseRecipe(record.recipe),
  };
}

function removeLegacyFrameRecipes(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
    const { recipesByFrameId: _ignored, ...roll } = item as Record<string, unknown>;
    return roll;
  });
}

function migrateRollsToExplicitFrameOrder(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return {
      id: record.id,
      title: record.title,
      assets: record.assets,
      frameOrder: createLegacyFrameOrder(record.assets),
    };
  });
}

function createLegacyFrameOrder(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => typeof item === "object" && item !== null && !Array.isArray(item)
    ? (item as Record<string, unknown>).id
    : undefined);
}

function normalizeTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("项目名称无效。");
  }
  const title = value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (title.length === 0) {
    return "未命名胶卷";
  }
  if (title.length > 80) {
    throw new Error("项目名称不能超过 80 个字符。");
  }
  return title;
}

function parseAssets(value: unknown): readonly SourceAsset[] {
  if (!Array.isArray(value) || value.length > maximumAssets) {
    throw new Error("项目中的源文件列表无效。");
  }
  const assets = value.map((item) => {
    const record = requireRecord(item, "源文件");
    const id = requireBoundedString(record.id, "源文件 ID", 64);
    const name = requireBoundedString(record.name, "源文件名称", 255);
    const extension = requireBoundedString(record.extension, "源文件格式", 16).toUpperCase();
    const identity = parseSourceIdentity(record.identity);
    if (
      !/^[a-zA-Z0-9-]+$/.test(id)
      || !/^[A-Z0-9]+$/.test(extension)
      || /[\\/\u0000-\u001F\u007F]/.test(name)
    ) {
      throw new Error("源文件信息包含不支持的字符。");
    }
    return { id, name, extension, ...(identity === undefined ? {} : { identity }) };
  });

  if (new Set(assets.map((asset) => asset.id)).size !== assets.length) {
    throw new Error("项目包含重复的源文件 ID。");
  }
  return assets;
}

function parseSourceIdentity(value: unknown): SourceAsset["identity"] {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "源文件身份");
  const fingerprint = requireRecord(record.fingerprint, "源文件内容指纹");
  const lastModifiedAt = requireBoundedString(record.lastModifiedAt, "源文件修改时间", 40);
  if (Number.isNaN(Date.parse(lastModifiedAt))) {
    throw new Error("源文件修改时间无效。");
  }
  if (
    fingerprint.algorithm !== "sha256-full-v1"
    || typeof fingerprint.value !== "string"
    || !/^[a-f0-9]{64}$/.test(fingerprint.value)
  ) {
    throw new Error("源文件内容指纹无效。");
  }
  return {
    size: requireBoundedNumber(record.size, "源文件尺寸", 0, Number.MAX_SAFE_INTEGER),
    lastModifiedAt,
    fingerprint: { algorithm: "sha256-full-v1", value: fingerprint.value },
  };
}

function parseRecipe(value: unknown): ProjectRecipe {
  const record = requireRecord(value, "处理配方");
  if (!previewModes.includes(record.mode as ProjectRecipe["mode"])) {
    throw new Error("处理模式无效。");
  }
  if (!previewViews.includes(record.view as ProjectRecipe["view"])) {
    throw new Error("预览视图无效。");
  }
  const toneRecord = requireRecord(record.tone, "色调设置");
  const tone: PreviewTone = {
    exposureStops: requireBoundedNumber(toneRecord.exposureStops, "曝光", -8, 8),
    contrast: requireBoundedNumber(toneRecord.contrast, "对比度", 0.1, 5),
    highlightCompression: requireBoundedNumber(toneRecord.highlightCompression, "高光压缩", 0, 10),
    saturation: requireBoundedNumber(toneRecord.saturation, "饱和度", 0, 5),
  };
  return {
    mode: record.mode as ProjectRecipe["mode"],
    view: record.view as ProjectRecipe["view"],
    tone,
    calibrationProfileId: parseOptionalProfileId(record.calibrationProfileId),
    processing: parseProcessingRecipe(record.processing),
  };
}

function parsePresets(value: unknown): readonly ProjectPreset[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("项目预设列表无效。");
  }
  const presets = value.map((item) => {
    const record = requireRecord(item, "项目预设");
    return {
      id: requireBoundedString(record.id, "预设 ID", 64),
      label: requireBoundedString(record.label, "预设名称", 80),
      recipe: parseRecipe(record.recipe),
    };
  });
  if (new Set(presets.map((preset) => preset.id)).size !== presets.length) {
    throw new Error("项目包含重复的预设 ID。");
  }
  return presets;
}

function parseProcessingRecipe(value: unknown): ProcessingRecipe {
  if (value === undefined) {
    // Version 1 projects did not persist processing controls. Their behavior
    // was the documented left-edge base ROI with no geometry correction.
    return defaultRecipeProcessing();
  }
  const record = requireRecord(value, "处理设置");
  const filmBase = parseFilmBaseReference(record.filmBase);
  return {
    baseRoi: parseRoi(record.baseRoi, "片基 ROI"),
    geometry: parseGeometry(record.geometry),
    restoration: parseRestoration(record.restoration),
    ...(filmBase === undefined ? {} : { filmBase }),
  };
}

function parseFilmBaseReference(value: unknown): ProcessingRecipe["filmBase"] | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "片基参考");
  if (record.kind !== "reference") {
    throw new Error("项目只能保存已经冻结的片基参考值。");
  }
  if (record.origin !== "sampled" && record.origin !== "estimated") {
    throw new Error("片基参考来源无效。");
  }
  return {
    kind: "reference",
    rgb: parseRgb(record.rgb, "片基参考 RGB", Number.EPSILON, 16),
    origin: record.origin,
    confidence: requireBoundedNumber(record.confidence, "片基参考置信度", 0, 1),
    sourceFrameId: record.sourceFrameId === undefined
      ? undefined
      : parseOptionalAssetId(record.sourceFrameId, "片基参考来源帧 ID"),
  };
}

function defaultRecipeProcessing(): ProcessingRecipe {
  return {
    baseRoi: { ...defaultProcessingRecipe.baseRoi },
    geometry: { ...defaultProcessingRecipe.geometry },
    restoration: { ...defaultProcessingRecipe.restoration },
  };
}

function parseGeometry(value: unknown): ProcessingGeometry {
  const record = requireRecord(value, "几何设置");
  const rotation = record.rotation;
  if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
    throw new Error("旋转角度无效。");
  }
  const straighten = record.straighten === undefined
    ? 0
    : requireBoundedNumber(record.straighten, "直尺拉直角度", -15, 15);
  const perspectiveRecord = optionalRecord(record.perspective, "透视校正");
  const geometry: {
    rotation: 0 | 90 | 180 | 270;
    straighten: number;
    crop?: ReturnType<typeof parseRoi>;
    perspective?: NonNullable<ProcessingGeometry["perspective"]>;
  } = { rotation, straighten };
  if (record.crop !== undefined) {
    geometry.crop = parseRoi(record.crop, "裁切");
  }
  if (perspectiveRecord !== undefined) {
    geometry.perspective = {
      topLeft: parsePoint(perspectiveRecord.topLeft, "左上角"),
      topRight: parsePoint(perspectiveRecord.topRight, "右上角"),
      bottomRight: parsePoint(perspectiveRecord.bottomRight, "右下角"),
      bottomLeft: parsePoint(perspectiveRecord.bottomLeft, "左下角"),
    };
  }
  return geometry;
}

function parseRoi(value: unknown, label: string) {
  const record = requireRecord(value, label);
  const roi = {
    x: requireBoundedNumber(record.x, label + " x", 0, 1),
    y: requireBoundedNumber(record.y, label + " y", 0, 1),
    width: requireBoundedNumber(record.width, label + " 宽度", 0.001, 1),
    height: requireBoundedNumber(record.height, label + " 高度", 0.001, 1),
  };
  if (roi.x + roi.width > 1 || roi.y + roi.height > 1) {
    throw new Error(label + " 必须位于图像范围内。");
  }
  return roi;
}

function parsePoint(value: unknown, label: string) {
  const record = requireRecord(value, label);
  return {
    x: requireBoundedNumber(record.x, label + " x", 0, 1),
    y: requireBoundedNumber(record.y, label + " y", 0, 1),
  };
}

function parseRestoration(value: unknown) {
  if (value === undefined) return { ...defaultProcessingRecipe.restoration };
  const record = requireRecord(value, "修复设置");
  if (typeof record.dust !== "boolean" || typeof record.scratches !== "boolean") {
    throw new Error("修复开关无效。");
  }
  return {
    dust: record.dust,
    scratches: record.scratches,
    denoise: requireBoundedNumber(record.denoise, "降噪", 0, 1),
    sharpen: requireBoundedNumber(record.sharpen, "锐化", 0, 2),
  };
}

function parseRgb(value: unknown, label: string, minimum: number, maximum: number): readonly [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(label + " 无效。");
  }
  return [
    requireBoundedNumber(value[0], label + " R", minimum, maximum),
    requireBoundedNumber(value[1], label + " G", minimum, maximum),
    requireBoundedNumber(value[2], label + " B", minimum, maximum),
  ];
}

function parseOptionalAssetId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const id = requireBoundedString(value, label, 128);
  if (!/^[a-zA-Z0-9-]+$/.test(id)) {
    throw new Error(label + " 包含不支持的字符。");
  }
  return id;
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : requireRecord(value, label);
}

function parseOptionalProfileId(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const id = requireBoundedString(value, "校准配置 ID", 128);
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new Error("校准配置 ID 包含不支持的字符。");
  }
  return id;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(label + "无效。");
  }
  return value as Record<string, unknown>;
}

function requireBoundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(label + "无效。");
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new Error(label + "长度无效。");
  }
  return normalized;
}

function requireBoundedNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(label + "超出允许范围。");
  }
  return value;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}
