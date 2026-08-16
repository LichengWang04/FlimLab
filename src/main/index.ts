import { basename } from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { IPC_CHANNELS } from "../shared/ipc.ts";
import type { RollExportRequest, RollFrameInfo, RollOpenMode, SingleExportRequest } from "../shared/ipc.ts";
import { renderPositive } from "./export.ts";
import {
  decodeRollPreview,
  decodeRollThumbnail,
  exportRoll,
  framePath,
  registerFrames,
  scanFolder,
} from "./roll-service.ts";

const smokeMode = process.argv.includes("--smoke") || process.env["FILMLAB_SMOKE"] === "1";

let mainWindow: BrowserWindow | null = null;
const exportCancelFlags = new Map<number, boolean>();

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
    title: mode === "single" ? "打开负片扫描/翻拍图像" : "选择整卷胶片图像",
    properties: mode === "single" ? ["openFile"] : ["openFile", "multiSelections"],
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
  return renderPositive(path, request.recipe, request.format, selection.filePath);
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
  return exportRoll(
    { frames: request.frames, format: request.format, outDir: selection.filePaths[0]! },
    (progress) => {
      if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.rollExportProgress, progress);
    },
    () => exportCancelFlags.get(sender.id) === true,
  );
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: "FilmLab",
    backgroundColor: "#14151a",
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
    mainWindow = null;
  });

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

app.whenReady().then(() => {
  ipcMain.handle(IPC_CHANNELS.rollOpen, (_event, mode: RollOpenMode) => openRoll(mode));
  ipcMain.handle(IPC_CHANNELS.rollPreview, (_event, id: string) => decodeRollPreview(id));
  ipcMain.handle(IPC_CHANNELS.rollThumbnail, (_event, id: string) => decodeRollThumbnail(id));
  ipcMain.handle(IPC_CHANNELS.rollExportSingle, (_event, request: SingleExportRequest) => handleSingleExport(request));
  ipcMain.handle(IPC_CHANNELS.rollExport, (event, request: RollExportRequest) => handleRollExport(event, request));
  ipcMain.handle(IPC_CHANNELS.rollExportCancel, (event) => {
    exportCancelFlags.set(event.sender.id, true);
  });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
