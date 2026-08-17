import type { Recipe, Rect } from "../core/index.ts";
import type {
  RollExportRequest,
  RollOpenMode,
  SessionSaveRequest,
  SingleExportRequest,
} from "../shared/ipc.ts";
import { MAX_ROLL_FRAMES } from "./resource-limits.ts";

const FRAME_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseOpenMode(value: unknown): RollOpenMode {
  if (value !== "files" && value !== "folder") throw new Error("导入模式无效。");
  return value;
}

export function parseFrameId(value: unknown): string {
  if (typeof value !== "string" || !FRAME_ID.test(value)) throw new Error("帧标识无效，请重新导入。");
  return value;
}

export function parseSingleExportRequest(value: unknown): SingleExportRequest {
  const record = asRecord(value, "单帧导出请求");
  return {
    id: parseFrameId(record["id"]),
    recipe: parseRecipe(record["recipe"]),
    format: parseFormat(record["format"]),
  };
}

export function parseRollExportRequest(value: unknown): RollExportRequest {
  const record = asRecord(value, "整卷导出请求");
  if (!Array.isArray(record["frames"]) || record["frames"].length < 1) {
    throw new Error("整卷导出至少需要一帧。");
  }
  if (record["frames"].length > MAX_ROLL_FRAMES) {
    throw new Error(`整卷最多包含 ${MAX_ROLL_FRAMES} 帧。`);
  }
  const seen = new Set<string>();
  const frames = record["frames"].map((value) => {
    const frame = asRecord(value, "整卷帧");
    const id = parseFrameId(frame["id"]);
    if (seen.has(id)) throw new Error("整卷导出请求包含重复帧。");
    seen.add(id);
    return { id, recipe: parseRecipe(frame["recipe"]) };
  });
  return { frames, format: parseFormat(record["format"]) };
}

export function parseSessionSaveRequest(value: unknown): SessionSaveRequest {
  const record = asRecord(value, "会话保存请求");
  if (!Array.isArray(record["frames"]) || record["frames"].length > MAX_ROLL_FRAMES) {
    throw new Error(`会话最多保存 ${MAX_ROLL_FRAMES} 帧。`);
  }
  const seen = new Set<string>();
  const frames = record["frames"].map((value) => {
    const frame = asRecord(value, "会话帧");
    const id = parseFrameId(frame["id"]);
    if (seen.has(id)) throw new Error("会话包含重复帧。");
    seen.add(id);
    return {
      id,
      recipe: parseRecipe(frame["recipe"]),
      skipped: booleanValue(frame["skipped"], "跳过状态"),
    };
  });
  const activeId = record["activeId"] === undefined ? undefined : parseFrameId(record["activeId"]);
  if (activeId !== undefined && !seen.has(activeId)) throw new Error("活动帧不在会话中。");
  return { frames, ...(activeId === undefined ? {} : { activeId }) };
}

export function parseRecipe(value: unknown): Recipe {
  const recipe = asRecord(value, "配方");
  const baseMode = enumValue(recipe["baseMode"], ["auto", "roi"] as const, "片基模式");
  const dmaxMode = enumValue(recipe["dmaxMode"], ["auto", "manual"] as const, "Dmax 模式");
  const parsed: Recipe = {
    rotate: finiteRange(recipe["rotate"], -180, 180, "旋转角度", false),
    baseMode,
    dmaxMode,
    manualDmax: finiteRange(recipe["manualDmax"], 0.2, 3.5, "Dmax"),
    autoNeutralize: booleanValue(recipe["autoNeutralize"], "自动中和"),
    temperatureKelvin: finiteRange(recipe["temperatureKelvin"], 2500, 10_000, "色温"),
    autoWhiteBalance: booleanValue(recipe["autoWhiteBalance"], "自动白平衡"),
    preSaturation: finiteRange(recipe["preSaturation"], 0.5, 2, "密度预饱和"),
    exposure: finiteRange(recipe["exposure"], -3, 3, "曝光"),
    contrast: finiteRange(recipe["contrast"], 0.5, 1.5, "对比度"),
    highlightCompression: finiteRange(recipe["highlightCompression"], 0, 1, "高光压缩"),
    saturation: finiteRange(recipe["saturation"], 0, 2, "饱和度"),
  };
  const crop = optionalRect(recipe["crop"], "裁剪区域");
  const baseRoi = optionalRect(recipe["baseRoi"], "片基区域");
  const neutralRoi = optionalRect(recipe["neutralRoi"], "中性区域");
  if (crop !== undefined) parsed.crop = crop;
  if (baseRoi !== undefined) parsed.baseRoi = baseRoi;
  if (neutralRoi !== undefined) parsed.neutralRoi = neutralRoi;
  return parsed;
}

function optionalRect(value: unknown, name: string): Rect | undefined {
  if (value === undefined) return undefined;
  const rect = asRecord(value, name);
  const parsed = {
    x: finiteRange(rect["x"], 0, 1, `${name} x`),
    y: finiteRange(rect["y"], 0, 1, `${name} y`),
    width: finiteRange(rect["width"], 0, 1, `${name}宽度`, false),
    height: finiteRange(rect["height"], 0, 1, `${name}高度`, false),
  };
  if (parsed.x + parsed.width > 1 + 1e-9 || parsed.y + parsed.height > 1 + 1e-9) {
    throw new Error(`${name}超出图像范围。`);
  }
  return parsed;
}

function parseFormat(value: unknown): "tiff" | "jpeg" {
  return enumValue(value, ["tiff", "jpeg"] as const, "导出格式");
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name}无效。`);
  return value as Record<string, unknown>;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name}必须为布尔值。`);
  return value;
}

function finiteRange(value: unknown, min: number, max: number, name: string, inclusiveMin = true): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value > max || (inclusiveMin ? value < min : value <= min)) {
    throw new Error(`${name}超出允许范围。`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${name}无效。`);
  return value as T[number];
}
