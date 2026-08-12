import { basename, dirname, extname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";

import {
  maximumBackgroundPreviewEdge,
  previewModes,
  previewViews,
  type BatchTiffExportRequest,
  type GpuMasterTiffBeginRequest,
  type GpuMasterTiffExportRequest,
  type GpuMasterTiffStripRequest,
  type MasterExportFormat,
  type MasterTiffExportRequest,
  type OpenRecentProjectRequest,
  type ProcessingRecipe,
  type PreviewRequest,
  type SourceAsset,
} from "../shared/contracts.ts";
import { createCalibrationProfileDocument } from "../core/calibration.ts";
import type { CurveSet } from "../core/types.ts";
import { BatchService } from "./batch-service.ts";
import { createGeneratedCalibrationCaptureIdentity } from "./calibration-capture.ts";
import { CalibrationProfileService } from "./calibration-profile-service.ts";
import { exportPreviewPng } from "./export-service.ts";
import { ProcessingService } from "./processing-service.ts";
import { renderDemoPreview } from "./preview-service.ts";
import { ProjectLifecycleService, type LifecycleProjectLoad } from "./project-lifecycle-service.ts";
import { SourceRegistry } from "./source-registry.ts";
import {
  createStreamingMasterWriter,
  type StreamingRgb16Writer,
} from "./master-export-codec.ts";
import { writeSrgb16Tiff } from "./tiff-codec.ts";

const PREVIEW_CHANNEL = "preview:render";
const PRECOMPUTE_PREVIEW_CHANNEL = "preview:precompute";
const SELECT_SOURCES_CHANNEL = "project:select-sources";
const LOAD_PROJECT_CHANNEL = "project:load";
const CREATE_PROJECT_CHANNEL = "project:create";
const OPEN_PROJECT_CHANNEL = "project:open";
const OPEN_RECENT_PROJECT_CHANNEL = "project:open-recent";
const SAVE_PROJECT_CHANNEL = "project:save";
const SAVE_PROJECT_AS_CHANNEL = "project:save-as";
const CONFIRM_PROJECT_PENDING_CHANNEL = "project:confirm-pending";
const CREATE_PROJECT_BACKUP_CHANNEL = "project:create-backup";
const EXPORT_PNG_CHANNEL = "preview:export-png";
const EXPORT_TIFF_CHANNEL = "master:export-tiff";
const EXPORT_GPU_TIFF_CHANNEL = "master:export-gpu-tiff";
const BEGIN_GPU_TIFF_CHANNEL = "master:begin-gpu-tiff";
const APPEND_GPU_TIFF_STRIP_CHANNEL = "master:append-gpu-tiff-strip";
const FINISH_GPU_TIFF_CHANNEL = "master:finish-gpu-tiff";
const CANCEL_GPU_TIFF_CHANNEL = "master:cancel-gpu-tiff";
const IMPORT_CALIBRATION_CHANNEL = "calibration:import";
const LIST_CALIBRATIONS_CHANNEL = "calibration:list";
const GENERATE_CALIBRATION_CHANNEL = "calibration:generate-from-card";
const RELINK_SOURCES_CHANNEL = "project:relink-sources";
const START_BATCH_TIFF_CHANNEL = "batch:start-tiff";
const GET_BATCH_JOB_CHANNEL = "batch:get";
const CANCEL_BATCH_JOB_CHANNEL = "batch:cancel";

export function registerIpcHandlers(
  getMainWindow: () => BrowserWindow | null,
  projectService: ProjectLifecycleService,
  sourceRegistry: SourceRegistry,
  processingService: ProcessingService,
  backgroundProcessingService: ProcessingService,
  calibrationProfiles: CalibrationProfileService,
): () => Promise<void> {
  const batchService = new BatchService(processingService);
  const gpuTiffSessions = new Map<string, {
    readonly writer: StreamingRgb16Writer;
    readonly fileName: string;
    readonly format: MasterExportFormat;
    readonly width: number;
    readonly height: number;
    readonly rowsPerStrip: number;
  }>();
  ipcMain.removeHandler(PREVIEW_CHANNEL);
  ipcMain.removeHandler(PRECOMPUTE_PREVIEW_CHANNEL);
  ipcMain.removeHandler(SELECT_SOURCES_CHANNEL);
  ipcMain.removeHandler(LOAD_PROJECT_CHANNEL);
  ipcMain.removeHandler(CREATE_PROJECT_CHANNEL);
  ipcMain.removeHandler(OPEN_PROJECT_CHANNEL);
  ipcMain.removeHandler(OPEN_RECENT_PROJECT_CHANNEL);
  ipcMain.removeHandler(SAVE_PROJECT_CHANNEL);
  ipcMain.removeHandler(SAVE_PROJECT_AS_CHANNEL);
  ipcMain.removeHandler(CONFIRM_PROJECT_PENDING_CHANNEL);
  ipcMain.removeHandler(CREATE_PROJECT_BACKUP_CHANNEL);
  ipcMain.removeHandler(EXPORT_PNG_CHANNEL);
  ipcMain.removeHandler(EXPORT_TIFF_CHANNEL);
  ipcMain.removeHandler(EXPORT_GPU_TIFF_CHANNEL);
  ipcMain.removeHandler(BEGIN_GPU_TIFF_CHANNEL);
  ipcMain.removeHandler(APPEND_GPU_TIFF_STRIP_CHANNEL);
  ipcMain.removeHandler(FINISH_GPU_TIFF_CHANNEL);
  ipcMain.removeHandler(CANCEL_GPU_TIFF_CHANNEL);
  ipcMain.removeHandler(IMPORT_CALIBRATION_CHANNEL);
  ipcMain.removeHandler(LIST_CALIBRATIONS_CHANNEL);
  ipcMain.removeHandler(GENERATE_CALIBRATION_CHANNEL);
  ipcMain.removeHandler(RELINK_SOURCES_CHANNEL);
  ipcMain.removeHandler(START_BATCH_TIFF_CHANNEL);
  ipcMain.removeHandler(GET_BATCH_JOB_CHANNEL);
  ipcMain.removeHandler(CANCEL_BATCH_JOB_CHANNEL);

  ipcMain.handle(PREVIEW_CHANNEL, async (event, value: unknown) => {
    assertTrustedSender(event, getMainWindow);
    if (!isPreviewRequest(value)) {
      throw new Error("预览请求无效。");
    }
    if (value.assetId === "demo-negative") {
      return renderDemoPreview(value);
    }
    const sourcePath = sourceRegistry.getPath(value.assetId);
    if (sourcePath === undefined) {
      throw new Error("找不到该源文件的本机会话链接。请重新导入此帧；项目文件不会保存绝对路径。");
    }
    const profile = await getCalibrationProfile(value, calibrationProfiles);
    return processingService.render(value.assetId, sourcePath, value, profile);
  });

  ipcMain.handle(PRECOMPUTE_PREVIEW_CHANNEL, async (event, value: unknown) => {
    assertTrustedSender(event, getMainWindow);
    if (
      !isPreviewRequest(value)
      || value.gpuSourceOnly === true
      || value.maxEdge > maximumBackgroundPreviewEdge
    ) {
      throw new Error("后台预计算请求无效。");
    }
    if (value.assetId === "demo-negative") {
      return renderDemoPreview(value);
    }
    const sourcePath = sourceRegistry.getPath(value.assetId);
    if (sourcePath === undefined) {
      throw new Error("该帧尚未连接本地源文件，无法后台预计算。");
    }
    const profile = await getCalibrationProfile(value, calibrationProfiles);
    return backgroundProcessingService.render(value.assetId, sourcePath, value, profile);
  });

  ipcMain.handle(SELECT_SOURCES_CHANNEL, async (event): Promise<readonly SourceAsset[]> => {
    assertTrustedSender(event, getMainWindow);
    const parent = getMainWindow();
    if (parent === null) {
      throw new Error("应用窗口不可用。");
    }

    const result = await dialog.showOpenDialog(parent, {
      title: "导入胶片翻拍源文件",
      buttonLabel: "导入",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "RAW 或 16-bit TIFF",
          extensions: ["dng", "nef", "cr2", "cr3", "arw", "raf", "rw2", "orf", "iiq", "pef", "srw", "tif", "tiff"],
        },
        { name: "所有文件", extensions: ["*"] },
      ],
    });

    if (result.canceled) {
      return [];
    }
    return sourceRegistry.register(result.filePaths);
  });

  ipcMain.handle(LOAD_PROJECT_CHANNEL, async (event) => {
    assertTrustedSender(event, getMainWindow);
    return enrichProjectLoad(await projectService.loadStartup(), sourceRegistry);
  });

  ipcMain.handle(CREATE_PROJECT_CHANNEL, async (event) => {
    assertTrustedSender(event, getMainWindow);
    const parent = requireMainWindow(getMainWindow);
    const selection = await dialog.showSaveDialog(parent, {
      title: "新建 FilmLab 项目",
      buttonLabel: "创建项目",
      defaultPath: "未命名项目.filmlab",
      filters: [{ name: "FilmLab 项目目录", extensions: ["filmlab"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    });
    if (selection.canceled || selection.filePath === undefined) return undefined;
    return enrichProjectLoad(await projectService.create(selection.filePath), sourceRegistry);
  });

  ipcMain.handle(OPEN_PROJECT_CHANNEL, async (event, value: unknown) => {
    assertTrustedSender(event, getMainWindow);
    if (typeof value !== "boolean") throw new Error("项目打开模式无效。");
    const parent = requireMainWindow(getMainWindow);
    const selection = await dialog.showOpenDialog(parent, {
      title: value ? "只读打开 FilmLab 项目" : "打开 FilmLab 项目",
      buttonLabel: value ? "只读打开" : "打开项目",
      properties: ["openDirectory"],
    });
    if (selection.canceled || selection.filePaths[0] === undefined) return undefined;
    return enrichProjectLoad(await projectService.open(selection.filePaths[0], value), sourceRegistry);
  });

  ipcMain.handle(OPEN_RECENT_PROJECT_CHANNEL, async (event, value: unknown) => {
    assertTrustedSender(event, getMainWindow);
    const request = parseOpenRecentProjectRequest(value);
    return enrichProjectLoad(await projectService.openRecent(request.id, request.readOnly), sourceRegistry);
  });

  ipcMain.handle(SAVE_PROJECT_CHANNEL, async (event, value: unknown) => {
    assertTrustedSender(event, getMainWindow);
    const request = parseProjectWriteRequest(value);
    return projectService.save(request.sessionId, request.project);
  });

  ipcMain.handle(SAVE_PROJECT_AS_CHANNEL, async (event, value: unknown) => {
    assertTrustedSender(event, getMainWindow);
    const request = parseProjectWriteRequest(value);
    const parent = requireMainWindow(getMainWindow);
    const selection = await dialog.showSaveDialog(parent, {
      title: "项目另存为",
      buttonLabel: "另存项目",
      defaultPath: "FilmLab 项目副本.filmlab",
      filters: [{ name: "FilmLab 项目目录", extensions: ["filmlab"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    });
    if (selection.canceled || selection.filePath === undefined) return undefined;
    return enrichProjectLoad(
      await projectService.saveAs(request.sessionId, request.project, selection.filePath),
      sourceRegistry,
    );
  });

  ipcMain.handle(CONFIRM_PROJECT_PENDING_CHANNEL, async (event, value: unknown) => {
    assertTrustedSender(event, getMainWindow);
    const request = parseProjectWriteRequest(value);
    return enrichProjectLoad(
      await projectService.confirmPending(request.sessionId, request.project),
      sourceRegistry,
    );
  });

  ipcMain.handle(CREATE_PROJECT_BACKUP_CHANNEL, async (event, value: unknown) => {
    assertTrustedSender(event, getMainWindow);
    if (typeof value !== "string") throw new Error("项目会话 ID 无效。");
    return projectService.createBackup(value);
  });

  ipcMain.handle(RELINK_SOURCES_CHANNEL, async (event, value: unknown) => {
    assertTrustedSender(event, getMainWindow);
    const assets = parseRelinkAssets(value);
    const parent = getMainWindow();
    if (parent === null) throw new Error("应用窗口不可用。");
    const result = await dialog.showOpenDialog(parent, {
      title: "选择源文件所在目录",
      buttonLabel: "扫描并重新连接",
      properties: ["openDirectory", "multiSelections"],
    });
    if (result.canceled) return { relinkedAssetIds: [], relinkedAssets: [], missingAssets: assets };
    return sourceRegistry.relinkDirectories(assets, result.filePaths);
  });

  ipcMain.handle(EXPORT_PNG_CHANNEL, async (event, value: unknown) => {
    assertTrustedSender(event, getMainWindow);
    const parent = getMainWindow();
    if (parent === null) {
      throw new Error("应用窗口不可用。");
    }
    return exportPreviewPng(parent, value);
  });

  ipcMain.handle(EXPORT_TIFF_CHANNEL, async (event, value: unknown) => {
    assertTrustedSender(event, getMainWindow);
    const request = parseMasterTiffRequest(value);
    if (request.assetId === "demo-negative") {
      throw new Error("母版导出需要已导入的真实 RAW 或 16-bit TIFF 源文件。");
    }
    const sourcePath = sourceRegistry.getPath(request.assetId);
    if (sourcePath === undefined) {
      throw new Error("找不到该源文件的本机会话链接。请重新导入此帧后导出。");
    }
    const parent = getMainWindow();
    if (parent === null) {
      throw new Error("应用窗口不可用。");
    }
    const format = request.format ?? "tiff";
    const exportSpec = getMasterExportSpec(format);
    const selection = await dialog.showSaveDialog(parent, {
      title: "导出" + exportSpec.label,
      buttonLabel: "导出 " + exportSpec.shortLabel,
      defaultPath: normalizeMasterFileName(request.suggestedFileName, format),
      filters: [{ name: exportSpec.label, extensions: exportSpec.extensions }],
      properties: ["showOverwriteConfirmation"],
    });
    if (selection.canceled || selection.filePath === undefined) {
      return { saved: false };
    }
    const profile = await getCalibrationProfile(request, calibrationProfiles);
    const exported = await processingService.exportTiff(request.assetId, sourcePath, {
      outputPath: forceMasterExtension(selection.filePath, format),
      suggestedFileName: request.suggestedFileName,
      format,
      mode: request.mode,
      tone: request.tone,
      calibrationProfile: profile,
      processing: request.processing,
      dmaxOverride: request.dmaxOverride,
    });
    return {
      saved: true,
      fileName: exported.fileName,
      width: exported.width,
      height: exported.height,
      colorTrust: exported.colorTrust,
    };
  });

  ipcMain.handle(EXPORT_GPU_TIFF_CHANNEL, async (event, value: unknown) => {
    assertTrustedSender(event, getMainWindow);
    const request = parseGpuMasterTiffRequest(value);
    const parent = getMainWindow();
    if (parent === null) throw new Error("应用窗口不可用。");
    const selection = await dialog.showSaveDialog(parent, {
      title: "导出 GPU 16-bit TIFF 母版",
      buttonLabel: "导出 TIFF",
      defaultPath: normalizeTiffFileName(request.suggestedFileName),
      filters: [{ name: "16-bit TIFF", extensions: ["tif", "tiff"] }],
      properties: ["showOverwriteConfirmation"],
    });
    if (selection.canceled || selection.filePath === undefined) return { saved: false };
    const outputPath = forceTiffExtension(selection.filePath);
    await writeSrgb16Tiff({
      width: request.width,
      height: request.height,
      data: request.srgb16,
      outputPath,
      processingMetadata: {
        ...(request.processingMetadata ?? {}),
        application: "FilmLab",
        pipeline: "webgl2-tiled",
        colorTrust: "profile-unverified",
        colorTrustReason: "gpu-export-contract-has-no-device-verification",
        colorAccuracyClaim: "not-device-characterized",
      },
    });
    return {
      saved: true,
      fileName: basename(outputPath),
      width: request.width,
      height: request.height,
    };
  });

  ipcMain.handle(BEGIN_GPU_TIFF_CHANNEL, async (event, value: unknown) => {
    assertTrustedSender(event, getMainWindow);
    const request = parseGpuMasterTiffBeginRequest(value);
    const format = request.format ?? "tiff";
    const exportSpec = getMasterExportSpec(format);
    const parent = getMainWindow();
    if (parent === null) throw new Error("应用窗口不可用。");
    const selection = await dialog.showSaveDialog(parent, {
      title: "导出 GPU " + exportSpec.label,
      buttonLabel: "导出 " + exportSpec.shortLabel,
      defaultPath: normalizeMasterFileName(request.suggestedFileName, format),
      filters: [{ name: exportSpec.label, extensions: exportSpec.extensions }],
      properties: ["showOverwriteConfirmation"],
    });
    if (selection.canceled || selection.filePath === undefined) return { saved: false };
    const outputPath = forceMasterExtension(selection.filePath, format);
    const writer = await createStreamingMasterWriter({
      outputPath,
      format,
      width: request.width,
      height: request.height,
      rowsPerStrip: request.rowsPerStrip,
      processingMetadata: {
        ...(request.processingMetadata ?? {}),
        application: "FilmLab",
        pipeline: "webgl2-pbo-streaming",
        format,
        colorTrust: "profile-unverified",
        colorTrustReason: "gpu-export-contract-has-no-device-verification",
        colorAccuracyClaim: "not-device-characterized",
      },
    });
    const sessionId = randomUUID();
    gpuTiffSessions.set(sessionId, {
      writer,
      fileName: basename(outputPath),
      format,
      width: request.width,
      height: request.height,
      rowsPerStrip: request.rowsPerStrip,
    });
    return { saved: true, sessionId };
  });

  ipcMain.handle(APPEND_GPU_TIFF_STRIP_CHANNEL, async (event, value: unknown) => {
    assertTrustedSender(event, getMainWindow);
    const request = parseGpuMasterTiffStripRequest(value);
    const session = gpuTiffSessions.get(request.sessionId);
    if (session === undefined) throw new Error("GPU TIFF streaming session does not exist.");
    if (
      request.width !== session.width
      || request.height > session.rowsPerStrip
    ) {
      throw new Error("GPU TIFF strip dimensions do not match the streaming session.");
    }
    await session.writer.appendStrip(request.outputY, request.height, request.rgb16);
  });

  ipcMain.handle(FINISH_GPU_TIFF_CHANNEL, async (event, value: unknown) => {
    assertTrustedSender(event, getMainWindow);
    const sessionId = parseGpuTiffSessionId(value);
    const session = gpuTiffSessions.get(sessionId);
    if (session === undefined) throw new Error("GPU TIFF streaming session does not exist.");
    gpuTiffSessions.delete(sessionId);
    try {
      await session.writer.finish();
    } catch (error) {
      // Both streaming writers clean up their file handle and temporary
      // files when finish() throws, but cancel() is idempotent and keeps
      // that guarantee for future writers. Without it a failed finish
      // would leak the handle and the .tmp files permanently.
      await session.writer.cancel().catch(() => undefined);
      throw error;
    }
    return {
      saved: true,
      fileName: session.fileName,
      width: session.width,
      height: session.height,
    };
  });

  ipcMain.handle(CANCEL_GPU_TIFF_CHANNEL, async (event, value: unknown) => {
    assertTrustedSender(event, getMainWindow);
    const sessionId = parseGpuTiffSessionId(value);
    const session = gpuTiffSessions.get(sessionId);
    if (session === undefined) return;
    gpuTiffSessions.delete(sessionId);
    await session.writer.cancel();
  });

  ipcMain.handle(IMPORT_CALIBRATION_CHANNEL, async (event) => {
    assertTrustedSender(event, getMainWindow);
    const parent = getMainWindow();
    if (parent === null) {
      throw new Error("应用窗口不可用。");
    }
    return calibrationProfiles.importFromDialog(parent);
  });

  ipcMain.handle(LIST_CALIBRATIONS_CHANNEL, async (event) => {
    assertTrustedSender(event, getMainWindow);
    return calibrationProfiles.list();
  });

  ipcMain.handle(GENERATE_CALIBRATION_CHANNEL, async (event, value: unknown) => {
    assertTrustedSender(event, getMainWindow);
    const request = parseColorCardCalibrationRequest(value);
    const sourcePath = sourceRegistry.getPath(request.assetId);
    if (sourcePath === undefined) {
      throw new Error("找不到色卡照片的本机会话链接；请先重新连接或重新导入该照片。");
    }
    const fit = await processingService.fitColorCard(
      request.assetId,
      sourcePath,
      request.processing,
    );
    const id = "color-card-" + randomUUID();
    const capture = createGeneratedCalibrationCaptureIdentity(fit);
    const document = createCalibrationProfileDocument({
      id,
      version: "1.0",
      calibrationId: id,
      captureFingerprint: capture.captureFingerprint,
      curves: IDENTITY_CURVES,
      matrix: fit.matrix,
    }, {
      name: "色卡标定 " + new Date().toLocaleDateString("zh-CN"),
      createdAt: new Date().toISOString(),
      capture: {
        cameraModel: capture.cameraModel,
        decoderFingerprint: capture.decoderFingerprint,
        demosaic: capture.demosaic,
      },
      fit: {
        algorithm: "color-card-grid-v1 / weighted-ridge-matrix / identity-curves",
        patchCount: fit.usedPatchCount,
        rejectedPatchIds: fit.rejectedPatchIds,
        warnings: [
          "自动工作流识别已校正、正向、6×4 ColorChecker Classic 网格。",
          "此版本生成矩阵配置并使用单位特性曲线；对特定胶片应在受控拍摄下复核色差与曲线。",
        ],
      },
    });
    const profile = await calibrationProfiles.saveGenerated(document);
    return {
      profile,
      detectedPatchCount: fit.detectedPatchCount,
      usedPatchCount: fit.usedPatchCount,
      rejectedPatchIds: fit.rejectedPatchIds,
      edgeScore: fit.edgeScore,
    };
  });

  ipcMain.handle(START_BATCH_TIFF_CHANNEL, async (event, value: unknown) => {
    assertTrustedSender(event, getMainWindow);
    const request = parseBatchTiffRequest(value);
    const parent = getMainWindow();
    if (parent === null) throw new Error("应用窗口不可用。");
    const directory = await dialog.showOpenDialog(parent, {
      title: "选择批处理 TIFF 输出文件夹",
      buttonLabel: "开始批处理",
      properties: ["openDirectory", "createDirectory"],
    });
    if (directory.canceled || directory.filePaths[0] === undefined) return undefined;
    const sources = await Promise.all(request.items.map(async (item) => {
      if (item.assetId === "demo-negative") throw new Error("批处理仅支持已导入的 RAW 或 16-bit TIFF 源文件。");
      const sourcePath = sourceRegistry.getPath(item.assetId);
      if (sourcePath === undefined) throw new Error("批处理有未重新连接的源文件；请先重新连接项目源文件。");
      return {
        item,
        sourcePath,
        sourceName: basename(sourcePath),
        calibrationProfile: await getCalibrationProfile(item, calibrationProfiles),
      };
    }));
    return batchService.start(sources, directory.filePaths[0]);
  });

  ipcMain.handle(GET_BATCH_JOB_CHANNEL, async (event, jobId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return typeof jobId === "string" ? batchService.get(jobId) : undefined;
  });

  ipcMain.handle(CANCEL_BATCH_JOB_CHANNEL, async (event, jobId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return typeof jobId === "string" ? batchService.cancel(jobId) : undefined;
  });

  // The renderer owns streaming GPU TIFF sessions; when the window is closed
  // or the app quits, no FINISH/CANCEL message will ever arrive for sessions
  // that are still open. Return a cleanup hook so the main process can cancel
  // every live writer (closing its file handle and removing .tmp files).
  return async () => {
    const sessions = [...gpuTiffSessions.values()];
    gpuTiffSessions.clear();
    await Promise.allSettled(sessions.map((session) => session.writer.cancel()));
  };
}

function assertTrustedSender(
  event: IpcMainInvokeEvent,
  getMainWindow: () => BrowserWindow | null,
): void {
  const mainWindow = getMainWindow();
  if (mainWindow === null || event.sender.id !== mainWindow.webContents.id) {
    throw new Error("Rejected IPC request from an unknown renderer.");
  }
}

async function enrichProjectLoad(
  loaded: LifecycleProjectLoad,
  sourceRegistry: SourceRegistry,
) {
  const assets = loaded.project.rolls.flatMap((roll) => roll.assets);
  const relinked = await sourceRegistry.restore(assets);
  return { ...loaded, ...relinked };
}

function requireMainWindow(getMainWindow: () => BrowserWindow | null): BrowserWindow {
  const parent = getMainWindow();
  if (parent === null) throw new Error("应用窗口不可用。");
  return parent;
}

function parseProjectWriteRequest(value: unknown): {
  readonly sessionId: string;
  readonly project: unknown;
} {
  if (typeof value !== "object" || value === null) throw new Error("项目保存请求无效。");
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId !== "string" || !/^[a-f0-9]{64}$/.test(record.sessionId)) {
    throw new Error("项目会话 ID 无效。");
  }
  return { sessionId: record.sessionId, project: record.project };
}

function parseOpenRecentProjectRequest(value: unknown): OpenRecentProjectRequest {
  if (typeof value !== "object" || value === null) throw new Error("最近项目请求无效。");
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" || !/^[a-f0-9]{64}$/.test(record.id)
    || typeof record.readOnly !== "boolean"
  ) throw new Error("最近项目请求无效。");
  return { id: record.id, readOnly: record.readOnly };
}

function isPreviewRequest(value: unknown): value is PreviewRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const request = value as Record<string, unknown>;
  if (
    typeof request.assetId !== "string"
    || request.assetId.length === 0
    || request.assetId.length > 128
    || typeof request.revision !== "number"
    || !Number.isInteger(request.revision)
    || typeof request.maxEdge !== "number"
    || request.maxEdge < 256
    || request.maxEdge > (request.gpuSourceOnly === true ? 32_768 : 2_048)
    || !previewModes.includes(request.mode as PreviewRequest["mode"])
    || !previewViews.includes(request.view as PreviewRequest["view"])
    || typeof request.tone !== "object"
    || request.tone === null
  ) {
    return false;
  }

  const tone = request.tone as Record<string, unknown>;
  const gpuBase = request.gpuBaseRgb;
  const gpuFieldsAreValid = (request.gpuInteractive === undefined || typeof request.gpuInteractive === "boolean")
    && (
      request.gpuReuseSourceKey === undefined
      || (
        typeof request.gpuReuseSourceKey === "string"
        && request.gpuReuseSourceKey.length > 0
        && request.gpuReuseSourceKey.length <= 512
      )
    )
    && (request.gpuSourceOnly === undefined || typeof request.gpuSourceOnly === "boolean")
    && (request.gpuSourceOnly !== true
      || (
        Array.isArray(gpuBase)
        && gpuBase.length === 3
        && gpuBase.every((item) => typeof item === "number" && Number.isFinite(item) && item > 0)
      ));
  const toneIsValid = [
    tone.exposureStops,
    tone.contrast,
    tone.highlightCompression,
    tone.saturation,
  ].every((item) => typeof item === "number" && Number.isFinite(item));
  return toneIsValid
    && gpuFieldsAreValid
    && isDmaxOverride(request.dmaxOverride)
    && (request.dmaxSampleRoi === undefined || isRoi(request.dmaxSampleRoi))
    && (request.calibrationProfileId === undefined
      || (typeof request.calibrationProfileId === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(request.calibrationProfileId)))
    && isProcessingRecipe(request.processing);
}

async function getCalibrationProfile(
  request: Pick<PreviewRequest, "mode" | "calibrationProfileId">,
  profiles: CalibrationProfileService,
) {
  if (request.mode !== "calibrated") {
    return undefined;
  }
  if (request.calibrationProfileId === undefined) {
    throw new Error("校准配置模式需要先导入并选择色卡标定配置。");
  }
  const profile = await profiles.get(request.calibrationProfileId);
  if (profile === undefined) {
    throw new Error("选择的色卡标定配置在本机不可用；请重新导入该配置文件。");
  }
  return profile;
}

function parseMasterTiffRequest(value: unknown): MasterTiffExportRequest {
  if (typeof value !== "object" || value === null) {
    throw new Error("TIFF 导出请求无效。");
  }
  const record = value as Record<string, unknown>;
  const previewRequest: PreviewRequest = {
    revision: 1,
    assetId: typeof record.assetId === "string" ? record.assetId : "",
    maxEdge: 256,
    mode: record.mode as PreviewRequest["mode"],
    view: "positive",
    tone: record.tone as PreviewRequest["tone"],
    calibrationProfileId: record.calibrationProfileId as string | undefined,
    processing: record.processing as ProcessingRecipe | undefined,
    dmaxOverride: record.dmaxOverride as number | undefined,
  };
  if (
    !isPreviewRequest(previewRequest)
    || typeof record.suggestedFileName !== "string"
    || record.suggestedFileName.length > 120
    || !isMasterExportFormat(record.format)
  ) {
    throw new Error("母版导出请求无效。");
  }
  return {
    assetId: previewRequest.assetId,
    suggestedFileName: record.suggestedFileName,
    format: record.format as MasterExportFormat | undefined,
    mode: previewRequest.mode,
    tone: previewRequest.tone,
    calibrationProfileId: previewRequest.calibrationProfileId,
    processing: previewRequest.processing,
    dmaxOverride: previewRequest.dmaxOverride,
  };
}

function parseGpuMasterTiffRequest(value: unknown): GpuMasterTiffExportRequest {
  if (typeof value !== "object" || value === null) {
    throw new Error("GPU TIFF 导出请求无效。");
  }
  const record = value as Record<string, unknown>;
  const width = record.width;
  const height = record.height;
  const data = record.srgb16;
  if (
    typeof record.suggestedFileName !== "string"
    || record.suggestedFileName.length === 0
    || record.suggestedFileName.length > 120
    || !Number.isInteger(width)
    || !Number.isInteger(height)
    || (width as number) <= 0
    || (height as number) <= 0
    || (width as number) * (height as number) > 80_000_000
    || !(data instanceof Uint16Array)
    || data.length !== (width as number) * (height as number) * 3
  ) {
    throw new Error("GPU TIFF 像素缓冲区无效。");
  }
  const metadata = record.processingMetadata;
  if (
    metadata !== undefined
    && (
      typeof metadata !== "object"
      || metadata === null
      || Object.values(metadata).some((item) => !["string", "number", "boolean"].includes(typeof item))
    )
  ) {
    throw new Error("GPU TIFF 元数据无效。");
  }
  return {
    suggestedFileName: record.suggestedFileName,
    width: width as number,
    height: height as number,
    srgb16: data,
    processingMetadata: metadata as GpuMasterTiffExportRequest["processingMetadata"],
  };
}

function parseGpuMasterTiffBeginRequest(value: unknown): GpuMasterTiffBeginRequest {
  if (typeof value !== "object" || value === null) {
    throw new Error("GPU TIFF streaming request is invalid.");
  }
  const record = value as Record<string, unknown>;
  const width = record.width;
  const height = record.height;
  const rowsPerStrip = record.rowsPerStrip;
  if (
    typeof record.suggestedFileName !== "string"
    || record.suggestedFileName.length === 0
    || record.suggestedFileName.length > 120
    || !Number.isInteger(width)
    || !Number.isInteger(height)
    || !Number.isInteger(rowsPerStrip)
    || (width as number) <= 0
    || (height as number) <= 0
    || (rowsPerStrip as number) < 32
    || (rowsPerStrip as number) > 4096
    || (width as number) * (height as number) > 80_000_000
    || !isMasterExportFormat(record.format)
    || !isSimpleMetadata(record.processingMetadata)
  ) {
    throw new Error("GPU TIFF streaming dimensions or metadata are invalid.");
  }
  return {
    suggestedFileName: record.suggestedFileName,
    format: record.format as MasterExportFormat | undefined,
    width: width as number,
    height: height as number,
    rowsPerStrip: rowsPerStrip as number,
    processingMetadata: record.processingMetadata as GpuMasterTiffBeginRequest["processingMetadata"],
  };
}

function parseGpuMasterTiffStripRequest(value: unknown): GpuMasterTiffStripRequest {
  if (typeof value !== "object" || value === null) {
    throw new Error("GPU TIFF strip request is invalid.");
  }
  const record = value as Record<string, unknown>;
  const sessionId = parseGpuTiffSessionId(record.sessionId);
  const width = record.width;
  const height = record.height;
  const outputY = record.outputY;
  const data = record.rgb16;
  if (
    !Number.isInteger(width)
    || !Number.isInteger(height)
    || !Number.isInteger(outputY)
    || (width as number) <= 0
    || (height as number) <= 0
    || (outputY as number) < 0
    || !(data instanceof Uint16Array)
    || data.length !== (width as number) * (height as number) * 3
  ) {
    throw new Error("GPU TIFF strip pixels are invalid.");
  }
  return {
    sessionId,
    outputY: outputY as number,
    width: width as number,
    height: height as number,
    rgb16: data,
  };
}

function parseGpuTiffSessionId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new Error("GPU TIFF streaming session id is invalid.");
  }
  return value;
}

function isSimpleMetadata(value: unknown): boolean {
  return value === undefined || (
    typeof value === "object"
    && value !== null
    && Object.values(value).every((item) => ["string", "number", "boolean"].includes(typeof item))
  );
}

function parseBatchTiffRequest(value: unknown): BatchTiffExportRequest {
  if (typeof value !== "object" || value === null) throw new Error("批处理请求无效。");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.items) || record.items.length === 0 || record.items.length > 1_000) {
    throw new Error("批处理源文件列表无效。");
  }
  const items = record.items.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("批处理设置无效。");
    }
    const item = value as Record<string, unknown>;
    if (typeof item.assetId !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(item.assetId)) {
      throw new Error("批处理源文件列表无效。");
    }
    const preview = {
      revision: 1,
      assetId: item.assetId,
      maxEdge: 256,
      mode: item.mode,
      view: "positive",
      tone: item.tone,
      calibrationProfileId: item.calibrationProfileId,
      processing: item.processing,
      dmaxOverride: item.dmaxOverride,
    };
    if (!isPreviewRequest(preview)) throw new Error("批处理设置无效。");
    return {
      assetId: preview.assetId,
      mode: preview.mode,
      tone: preview.tone,
      calibrationProfileId: preview.calibrationProfileId,
      processing: preview.processing,
      dmaxOverride: preview.dmaxOverride,
    };
  });
  if (new Set(items.map((item) => item.assetId)).size !== items.length) {
    throw new Error("批处理源文件不能重复。");
  }
  return { items };
}

function parseColorCardCalibrationRequest(value: unknown): { readonly assetId: string; readonly processing?: ProcessingRecipe } {
  if (typeof value !== "object" || value === null) throw new Error("色卡标定请求无效。");
  const record = value as Record<string, unknown>;
  if (typeof record.assetId !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(record.assetId) || !isProcessingRecipe(record.processing)) {
    throw new Error("色卡标定请求无效。");
  }
  return { assetId: record.assetId, processing: record.processing as ProcessingRecipe | undefined };
}

function parseRelinkAssets(value: unknown): readonly SourceAsset[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new Error("待重新连接的源文件列表无效。");
  return value.map((item) => {
    if (typeof item !== "object" || item === null) throw new Error("待重新连接的源文件无效。");
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(record.id)
      || typeof record.name !== "string" || record.name.length === 0 || record.name.length > 255 || /[\\/\u0000-\u001F\u007F]/.test(record.name)
      || typeof record.extension !== "string" || !/^[A-Za-z0-9]{1,16}$/.test(record.extension)
    ) throw new Error("待重新连接的源文件无效。");
    const identity = parseRelinkIdentity(record.identity);
    return {
      id: record.id,
      name: record.name,
      extension: record.extension.toUpperCase(),
      ...(identity === undefined ? {} : { identity }),
    };
  });
}

function parseRelinkIdentity(value: unknown): SourceAsset["identity"] {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("待重新连接的源文件身份无效。");
  }
  const record = value as Record<string, unknown>;
  const fingerprint = record.fingerprint;
  if (typeof fingerprint !== "object" || fingerprint === null || Array.isArray(fingerprint)) {
    throw new Error("待重新连接的源文件身份无效。");
  }
  const fingerprintRecord = fingerprint as Record<string, unknown>;
  if (
    typeof record.size !== "number" || !Number.isSafeInteger(record.size) || record.size < 0
    || typeof record.lastModifiedAt !== "string" || Number.isNaN(Date.parse(record.lastModifiedAt))
    || fingerprintRecord.algorithm !== "sha256-full-v1"
    || typeof fingerprintRecord.value !== "string" || !/^[a-f0-9]{64}$/.test(fingerprintRecord.value)
  ) throw new Error("待重新连接的源文件身份无效。");
  return {
    size: record.size,
    lastModifiedAt: record.lastModifiedAt,
    fingerprint: { algorithm: "sha256-full-v1", value: fingerprintRecord.value },
  };
}

function isProcessingRecipe(value: unknown): value is ProcessingRecipe | undefined {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!isRoi(record.baseRoi) || typeof record.geometry !== "object" || record.geometry === null) return false;
  if (!isFilmBaseOverride(record.filmBase)) return false;
  const geometry = record.geometry as Record<string, unknown>;
  if (![0, 90, 180, 270].includes(geometry.rotation as number) || (geometry.crop !== undefined && !isRoi(geometry.crop))) return false;
  if (geometry.straighten !== undefined && (
    typeof geometry.straighten !== "number"
    || !Number.isFinite(geometry.straighten)
    || Math.abs(geometry.straighten) > 15
  )) return false;
  if (geometry.perspective !== undefined) {
    if (typeof geometry.perspective !== "object" || geometry.perspective === null) return false;
    const perspective = geometry.perspective as Record<string, unknown>;
    if (!["topLeft", "topRight", "bottomRight", "bottomLeft"].every((key) => isPoint(perspective[key]))) return false;
  }
  if (!isRestoration(record.restoration)) return false;
  if (record.channelGains !== undefined) {
    if (
      !Array.isArray(record.channelGains)
      || record.channelGains.length !== 3
      || record.channelGains.some((item) => typeof item !== "number" || !Number.isFinite(item) || item <= 0 || item > 4)
    ) {
      return false;
    }
  }
  return true;
}

function isDmaxOverride(value: unknown): value is number | undefined {
  return value === undefined
    || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 16);
}

function isFilmBaseOverride(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "automatic") return Object.keys(record).length === 1;
  if (record.kind !== "reference") return false;
  return Array.isArray(record.rgb)
    && record.rgb.length === 3
    && record.rgb.every((item) => typeof item === "number" && Number.isFinite(item) && item > 0 && item <= 16)
    && (record.origin === "sampled" || record.origin === "estimated")
    && typeof record.confidence === "number"
    && Number.isFinite(record.confidence)
    && record.confidence >= 0
    && record.confidence <= 1
    && (record.sourceFrameId === undefined || (typeof record.sourceFrameId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(record.sourceFrameId)));
}

function isRestoration(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const restoration = value as Record<string, unknown>;
  return typeof restoration.dust === "boolean"
    && typeof restoration.scratches === "boolean"
    && typeof restoration.denoise === "number" && Number.isFinite(restoration.denoise) && restoration.denoise >= 0 && restoration.denoise <= 1
    && typeof restoration.sharpen === "number" && Number.isFinite(restoration.sharpen) && restoration.sharpen >= 0 && restoration.sharpen <= 2;
}

function isRoi(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const roi = value as Record<string, unknown>;
  return [roi.x, roi.y, roi.width, roi.height].every((item) => typeof item === "number" && Number.isFinite(item))
    && (roi.x as number) >= 0 && (roi.y as number) >= 0 && (roi.width as number) > 0 && (roi.height as number) > 0
    && (roi.x as number) + (roi.width as number) <= 1 && (roi.y as number) + (roi.height as number) <= 1;
}

function isPoint(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const point = value as Record<string, unknown>;
  return [point.x, point.y].every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 1);
}

const IDENTITY_CURVES: CurveSet = [
  [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  [{ x: 0, y: 0 }, { x: 1, y: 1 }],
];

function isMasterExportFormat(value: unknown): value is MasterExportFormat | undefined {
  return value === undefined || value === "tiff" || value === "jpeg" || value === "heif" || value === "dng";
}

function getMasterExportSpec(format: MasterExportFormat): {
  readonly label: string;
  readonly shortLabel: string;
  readonly extensions: string[];
  readonly defaultExtension: string;
} {
  switch (format) {
    case "jpeg":
      return { label: "高质量 JPEG", shortLabel: "JPG", extensions: ["jpg", "jpeg"], defaultExtension: "jpg" };
    case "heif":
      return { label: "10-bit HEIF（AVIF）", shortLabel: "HEIF", extensions: ["avif"], defaultExtension: "avif" };
    case "dng":
      return { label: "16-bit 线性 DNG", shortLabel: "DNG", extensions: ["dng"], defaultExtension: "dng" };
    default:
      return { label: "16-bit TIFF", shortLabel: "TIFF", extensions: ["tif", "tiff"], defaultExtension: "tiff" };
  }
}

function normalizeMasterFileName(value: string, format: MasterExportFormat): string {
  const spec = getMasterExportSpec(format);
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const fileName = sanitized.length === 0 ? "filmlab-positive" : sanitized;
  const extensionPattern = new RegExp("\\.(?:" + spec.extensions.join("|") + ")$", "i");
  if (extensionPattern.test(fileName)) return fileName;
  return fileName.replace(/\.[^.]+$/, "") + "." + spec.defaultExtension;
}

function forceMasterExtension(filePath: string, format: MasterExportFormat): string {
  const spec = getMasterExportSpec(format);
  const extensionPattern = new RegExp("\\.(?:" + spec.extensions.join("|") + ")$", "i");
  if (extensionPattern.test(filePath)) return filePath;
  const extension = extname(filePath);
  const fileName = extension.length === 0 ? basename(filePath) : basename(filePath, extension);
  return join(dirname(filePath), fileName + "." + spec.defaultExtension);
}

function normalizeTiffFileName(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const stem = sanitized.length === 0 ? "filmlab-positive" : sanitized;
  return /\.tiff?$/i.test(stem) ? stem : stem + ".tiff";
}

function forceTiffExtension(filePath: string): string {
  if (/\.tiff?$/i.test(filePath)) {
    return filePath;
  }
  const extension = extname(filePath);
  const fileName = extension.length === 0 ? basename(filePath) : basename(filePath, extension);
  return join(dirname(filePath), fileName + ".tiff");
}
