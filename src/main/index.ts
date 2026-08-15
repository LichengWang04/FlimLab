import { basename } from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import type { Recipe } from "../core/index.ts";
import { IPC_CHANNELS } from "../shared/ipc.ts";
import type { ExportRequest, OpenedSource } from "../shared/ipc.ts";
import { decodeSource } from "./decode.ts";
import { exportPositive } from "./export.ts";

const PREVIEW_MAX_SIDE = 1600;
const smokeMode = process.argv.includes("--smoke") || process.env["FILMLAB_SMOKE"] === "1";

let mainWindow: BrowserWindow | null = null;
let currentSourcePath: string | null = null;

async function openNegative(): Promise<OpenedSource | null> {
  const selection = await dialog.showOpenDialog(mainWindow!, {
    title: "打开负片扫描/翻拍图像",
    properties: ["openFile"],
    filters: [
      { name: "支持的图像", extensions: ["tif", "tiff", "jpg", "jpeg", "png"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  if (selection.canceled || selection.filePaths.length === 0) return null;
  const path = selection.filePaths[0]!;
  const { raster, meta } = await decodeSource(path, PREVIEW_MAX_SIDE);
  currentSourcePath = path;
  return {
    fileName: basename(path),
    width: raster.width,
    height: raster.height,
    depth: meta.depth,
    hasIcc: meta.hasIcc,
    raster: raster.data,
  };
}

async function handleExport(request: ExportRequest) {
  if (currentSourcePath === null) {
    return { ok: false, message: "还没有打开负片图像。" };
  }
  if (request.format !== "tiff" && request.format !== "jpeg") {
    return { ok: false, message: `不支持的导出格式:${request.format}` };
  }
  const extension = request.format === "tiff" ? "tiff" : "jpg";
  const stem = basename(currentSourcePath).replace(/\.[^.]+$/, "");
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
  return exportPositive(currentSourcePath, request.recipe as Recipe, request.format, selection.filePath);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1020,
    minHeight: 680,
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
  ipcMain.handle(IPC_CHANNELS.openNegative, () => openNegative());
  ipcMain.handle(IPC_CHANNELS.exportPositive, (_event, request: ExportRequest) => handleExport(request));
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
