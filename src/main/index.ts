import { basename } from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { IPC_CHANNELS } from "../shared/ipc.ts";
import type { RollExportRequest, RollFrameInfo, RollOpenMode, SingleExportRequest } from "../shared/ipc.ts";
import { ProcessingService } from "./processing-service.ts";
import {
  parseFrameId,
  parseOpenMode,
  parseRollExportRequest,
  parseSessionSaveRequest,
  parseSingleExportRequest,
} from "./ipc-validation.ts";
import {
  clearFrames,
  decodeRollPreview,
  decodeRollThumbnail,
  exportRoll,
  framePath,
  registerFrames,
  releaseFrame,
  scanFolder,
} from "./roll-service.ts";
import { SessionStore } from "./session-store.ts";
import { runReleaseExportSmoke } from "./release-export-smoke.ts";

const smokeMode = process.argv.includes("--smoke") || process.env["FILMLAB_SMOKE"] === "1";
const exportSmokeRoot = process.argv
  .find((argument) => argument.startsWith("--release-export-smoke="))
  ?.slice("--release-export-smoke=".length);

let mainWindow: BrowserWindow | null = null;
const exportCancelFlags = new Map<number, boolean>();
const processingService = new ProcessingService();
const sessionStore = new SessionStore(() => join(app.getPath("userData"), "session-v1.json"));

const IMAGE_FILTERS = [
  { name: "支持的图像", extensions: ["tif", "tiff", "jpg", "jpeg", "png"] },
  { name: "所有文件", extensions: ["*"] },
];

async function openRoll(mode: RollOpenMode): Promise<RollFrameInfo[] | null> {
  if (mode === "folder") {
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: "选择整卷胶片所在的文件夹",
      properties: ["openDirectory"],
    });
    if (selection.canceled || selection.filePaths.length === 0) return null;
    return registerFrames(await scanFolder(selection.filePaths[0]!));
  }
  const selection = await dialog.showOpenDialog(mainWindow!, {
    title: "导入底片扫描/翻拍图像",
    properties: ["openFile", "multiSelections"],
    filters: IMAGE_FILTERS,
  });
  if (selection.canceled || selection.filePaths.length === 0) return null;
  return registerFrames(selection.filePaths);
}

async function handleSingleExport(request: SingleExportRequest) {
  const path = framePath(request.id);
  if (path === null) return { ok: false, message: "帧不存在,请重新导入。" };
  if (request.format !== "tiff" && request.format !== "jpeg") {
    return { ok: false, message: `不支持的导出格式:${request.format}` };
  }
  const extension = request.format === "tiff" ? "tiff" : "jpg";
  const stem = basename(path).replace(/\.[^.]+$/, "");
  const selection = await dialog.showSaveDialog(mainWindow!, {
    title: "导出正像",
    defaultPath: `${stem}-positive.${extension}`,
    filters: request.format === "tiff"
      ? [{ name: "16-bit TIFF", extensions: ["tiff", "tif"] }]
      : [{ name: "JPEG", extensions: ["jpg", "jpeg"] }],
  });
  if (selection.canceled || selection.filePath === undefined) {
    return { ok: false, message: "已取消导出。" };
  }
  return processingService.renderPositive(path, request.recipe, request.format, selection.filePath);
}

async function handleRollExport(event: Electron.IpcMainInvokeEvent, request: RollExportRequest) {
  if (request.frames.length === 0) {
    return { ok: false, succeeded: [], failed: [], cancelled: false, message: "没有可导出的帧。" };
  }
  const selection = await dialog.showOpenDialog(mainWindow!, {
    title: "选择整卷导出文件夹",
    properties: ["openDirectory", "createDirectory"],
  });
  if (selection.canceled || selection.filePaths.length === 0) {
    return { ok: false, succeeded: [], failed: [], cancelled: true, message: "已取消导出。" };
  }
  const sender = event.sender;
  exportCancelFlags.set(sender.id, false);
  try {
    return await exportRoll(
      { frames: request.frames, format: request.format, outDir: selection.filePaths[0]! },
      (progress) => {
        if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.rollExportProgress, progress);
      },
      () => exportCancelFlags.get(sender.id) === true,
      (path, recipe, format, outPath) => processingService.renderPositive(path, recipe, format, outPath),
    );
  } finally {
    exportCancelFlags.delete(sender.id);
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: "FilmLab",
    icon: app.isPackaged ? undefined : join(app.getAppPath(), "build/icon.png"),
    backgroundColor: "#11110f",
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.once("ready-to-show", () => {
    if (!smokeMode) mainWindow?.show();
  });
  mainWindow.on("closed", () => {
    clearFrames();
    mainWindow = null;
  });
  const webContentsId = mainWindow.webContents.id;
  mainWindow.webContents.once("destroyed", () => exportCancelFlags.delete(webContentsId));

  if (smokeMode) {
    // Headless verification: report renderer console output and exit once
    // React has mounted into the document.
    mainWindow.webContents.on("console-message", (details) => {
      console.log(`[smoke] renderer console: ${details.message}`);
    });
    mainWindow.webContents.on("did-finish-load", () => {
      void mainWindow?.webContents
        .executeJavaScript('document.querySelector("#root")?.children.length ?? 0')
        .then((children) => {
          if (typeof children === "number" && children > 0) {
            console.log("[smoke] renderer-mounted");
            app.quit();
          } else {
            console.error("[smoke] renderer root is empty");
            app.exit(1);
          }
        })
        .catch((error: unknown) => {
          console.error("[smoke] renderer check failed:", error);
          app.exit(1);
        });
    });
  }

  if (process.env["ELECTRON_RENDERER_URL"] !== undefined) {
    void mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  if (exportSmokeRoot !== undefined) {
    try {
      const output = await runReleaseExportSmoke(exportSmokeRoot, processingService);
      console.log(`[release-smoke] exports-complete ${output}`);
      app.exit(0);
    } catch (error) {
      console.error("[release-smoke] export failed:", error);
      app.exit(1);
    }
    return;
  }
  ipcMain.handle(IPC_CHANNELS.rollOpen, (_event, mode: unknown) => openRoll(parseOpenMode(mode)));
  ipcMain.handle(IPC_CHANNELS.rollPreview, (_event, id: unknown) => decodeRollPreview(parseFrameId(id)));
  ipcMain.handle(IPC_CHANNELS.rollThumbnail, (_event, id: unknown) => decodeRollThumbnail(parseFrameId(id)));
  ipcMain.handle(IPC_CHANNELS.rollRelease, (_event, id: unknown) => releaseFrame(parseFrameId(id)));
  ipcMain.handle(IPC_CHANNELS.rollExportSingle, (_event, request: unknown) => (
    handleSingleExport(parseSingleExportRequest(request))
  ));
  ipcMain.handle(IPC_CHANNELS.rollExport, (event, request: unknown) => (
    handleRollExport(event, parseRollExportRequest(request))
  ));
  ipcMain.handle(IPC_CHANNELS.rollExportCancel, (event) => {
    exportCancelFlags.set(event.sender.id, true);
  });
  ipcMain.handle(IPC_CHANNELS.sessionSave, (_event, request: unknown) => (
    sessionStore.save(parseSessionSaveRequest(request))
  ));
  ipcMain.handle(IPC_CHANNELS.sessionRestore, () => sessionStore.restore());
  ipcMain.handle(IPC_CHANNELS.appInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
  }));
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.once("before-quit", () => processingService.close());
