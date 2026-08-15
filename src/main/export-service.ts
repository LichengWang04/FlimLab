import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { BrowserWindow, dialog } from "electron";

import { atomicTemporaryPath, renameWithRetry, syncDirectory, syncFile } from "./atomic-output.ts";

import type {
  PreviewPngExportRequest,
  PreviewPngExportResult,
} from "../shared/contracts.ts";

const maximumPngBytes = 32 * 1024 * 1024;
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10] as const;

/**
 * Saves a renderer-encoded PNG through the native dialog. The renderer never
 * receives a filesystem path, and the main process does not depend on
 * platform-specific raw bitmap channel order.
 */
export async function exportPreviewPng(
  parent: BrowserWindow,
  value: unknown,
): Promise<PreviewPngExportResult> {
  const request = parsePngExportRequest(value);
  const selection = await dialog.showSaveDialog(parent, {
    title: "导出 PNG 预览",
    buttonLabel: "导出 PNG",
    defaultPath: normalizeFileName(request.suggestedFileName),
    filters: [{ name: "PNG 图像", extensions: ["png"] }],
    properties: ["showOverwriteConfirmation"],
  });

  if (selection.canceled || selection.filePath === undefined) {
    return { saved: false };
  }

  const outputPath = forcePngExtension(selection.filePath);
  const temporaryPath = atomicTemporaryPath(outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await writeFile(temporaryPath, request.png, { flag: "wx" });
    await syncFile(temporaryPath);
    await renameWithRetry(temporaryPath, outputPath);
    await syncDirectory(dirname(outputPath));
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return {
    saved: true,
    fileName: basename(outputPath),
  };
}

function parsePngExportRequest(value: unknown): PreviewPngExportRequest {
  if (typeof value !== "object" || value === null) {
    throw new Error("导出请求无效。");
  }
  const request = value as Record<string, unknown>;
  if (
    typeof request.suggestedFileName !== "string"
    || request.suggestedFileName.length > 120
    || !(request.png instanceof Uint8Array)
  ) {
    throw new Error("导出请求无效。");
  }
  const png = request.png;
  if (png.byteLength < pngSignature.length || png.byteLength > maximumPngBytes) {
    throw new Error("PNG 预览数据大小无效。");
  }
  if (!pngSignature.every((byte, index) => png[index] === byte)) {
    throw new Error("预览数据不是 PNG。");
  }
  return {
    suggestedFileName: request.suggestedFileName,
    png,
  };
}

function normalizeFileName(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const stem = sanitized.length === 0 ? "filmlab-preview" : sanitized;
  return stem.toLowerCase().endsWith(".png") ? stem : stem + ".png";
}

function forcePngExtension(filePath: string): string {
  if (extname(filePath).toLowerCase() === ".png") {
    return filePath;
  }
  const extension = extname(filePath);
  const fileName = extension.length === 0 ? basename(filePath) : basename(filePath, extension);
  return join(dirname(filePath), fileName + ".png");
}
