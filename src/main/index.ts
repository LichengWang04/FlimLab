import { app, BrowserWindow, ipcMain, session, type IpcMainEvent } from "electron";
import { join } from "node:path";

import { CalibrationProfileService } from "./calibration-profile-service.ts";
import { registerIpcHandlers } from "./ipc.ts";
import { ProcessingService } from "./processing-service.ts";
import { ProjectLifecycleService } from "./project-lifecycle-service.ts";
import { SourceRegistry } from "./source-registry.ts";
import { runA7rvAcceptanceFromEnvironment } from "./a7rv-e2e-runner.ts";

installBrokenPipeGuards();

let mainWindow: BrowserWindow | null = null;
let processingService: ProcessingService | null = null;
let backgroundProcessingService: ProcessingService | null = null;
let gpuSelfCheckWindow: BrowserWindow | null = null;
let cleanupIpcHandlers: (() => Promise<void>) | undefined;

/**
 * electron-vite can outlive the terminal/launcher that owns its stdio pipes.
 * Windows reports subsequent console writes as EPIPE; without listeners Node
 * treats that stream error as an uncaught main-process exception. Ignore only
 * this expected transport shutdown and preserve normal failure behavior for
 * every other stream error.
 */
function installBrokenPipeGuards(): void {
  const handleStreamError = (error: NodeJS.ErrnoException): void => {
    if (error.code === "EPIPE") return;
    process.nextTick(() => {
      throw error;
    });
  };
  process.stdout.on("error", handleStreamError);
  process.stderr.on("error", handleStreamError);
}

function createMainWindow(): void {
  let allowClose = false;
  let closeRequested = false;
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: "#101114",
    show: false,
    title: "FilmLab",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });

  mainWindow = window;
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const confirmClose = (event: IpcMainEvent): void => {
    if (event.sender.id !== window.webContents.id) return;
    allowClose = true;
    window.close();
  };
  ipcMain.on("app:confirm-close", confirmClose);
  window.on("close", (event) => {
    if (allowClose || window.webContents.isDestroyed()) return;
    event.preventDefault();
    if (closeRequested) return;
    closeRequested = true;
    window.webContents.send("app:request-close");
    // A crashed/unresponsive renderer must not make the application
    // impossible to close. Normal paths acknowledge after the save queue and
    // one final immediate project save have completed.
    setTimeout(() => {
      if (!window.isDestroyed() && !allowClose) {
        console.warn("[FilmLab] renderer did not acknowledge close; forcing shutdown after save timeout");
        allowClose = true;
        window.close();
      }
    }, 8_000);
  });

  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    runDevelopmentGpuSelfCheck(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("closed", () => {
    ipcMain.removeListener("app:confirm-close", confirmClose);
    if (mainWindow === window) {
      mainWindow = null;
    }
    // The renderer can no longer finish or cancel its streaming GPU TIFF
    // sessions; abandon every live writer so handles and .tmp files are
    // released instead of leaking for the lifetime of the app.
    void cleanupIpcHandlers?.();
  });
}

function runDevelopmentGpuSelfCheck(rendererUrl: string): void {
  if (gpuSelfCheckWindow !== null) return;
  const url = new URL(rendererUrl);
  url.searchParams.set("web-demo", "");
  const checkWindow = new BrowserWindow({
    width: 960,
    height: 640,
    show: false,
    backgroundColor: "#101114",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  gpuSelfCheckWindow = checkWindow;
  checkWindow.once("closed", () => {
    if (gpuSelfCheckWindow === checkWindow) gpuSelfCheckWindow = null;
  });
  checkWindow.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      void checkWindow.webContents.executeJavaScript(`new Promise((resolve) => {
        const canvas = document.querySelector("canvas.preview-canvas");
        if (canvas instanceof HTMLCanvasElement && canvas.parentElement !== null) {
          canvas.parentElement.style.width = (canvas.parentElement.clientWidth - 1) + "px";
        }
        setTimeout(() => {
          const current = document.querySelector("canvas.preview-canvas");
          resolve(current instanceof HTMLCanvasElement
            ? {
                backend: current.dataset.renderBackend ?? null,
                gpuError: current.dataset.gpuPipelineError ?? null,
                gpuMilliseconds: current.dataset.gpuMilliseconds ?? null,
                webgpuCompute: current.dataset.webgpuCompute ?? null,
                workspaceThumbnails: document.querySelectorAll(".frame-image img").length,
                filmstripThumbnails: document.querySelectorAll(".strip-preview img").length,
                thumbnailStatus: document.documentElement.dataset.thumbnailStatus ?? null,
                workspaceFrames: document.querySelectorAll(".frame-image").length
              }
            : { backend: null, gpuError: "preview canvas was not mounted" });
        }, 2_500);
      })`).then((diagnostics: unknown) => {
        console.log("[FilmLab hidden GPU self-check]", diagnostics);
      }).catch((error: unknown) => {
        console.warn("[FilmLab hidden GPU self-check failed]", error);
      }).finally(() => {
        if (!checkWindow.isDestroyed()) checkWindow.close();
      });
    }, 2_000);
  });
  void checkWindow.loadURL(url.toString());
}

app.whenReady().then(() => {
  const acceptanceSpec = process.env.FILMLAB_A7RV_ACCEPTANCE_SPEC;
  if (acceptanceSpec !== undefined) {
    void runA7rvAcceptanceFromEnvironment(acceptanceSpec)
      .then(() => app.exit(0))
      .catch((error: unknown) => {
        console.error("[FilmLab A7R V acceptance failed]", error);
        app.exit(1);
      });
    return;
  }
  app.setAppUserModelId("com.filmlab.desktop");
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const sourceRegistry = new SourceRegistry(join(app.getPath("userData"), "source-locations-v1.json"));
  const calibrationProfiles = new CalibrationProfileService(join(app.getPath("userData"), "calibration-profiles"));
  const projectService = new ProjectLifecycleService(
    join(app.getPath("userData"), "projects"),
    join(app.getPath("userData"), "project-sessions-v1.json"),
    calibrationProfiles,
  );
  const previewCacheDirectory = join(app.getPath("sessionData"), "linear-preview-v1");
  processingService = new ProcessingService(
    "FilmLab Image Worker",
    false,
    1_280,
    previewCacheDirectory,
  );
  backgroundProcessingService = new ProcessingService(
    "FilmLab Background Precompute Worker",
    true,
    0,
    previewCacheDirectory,
  );
  cleanupIpcHandlers = registerIpcHandlers(
    () => mainWindow,
    projectService,
    sourceRegistry,
    processingService,
    backgroundProcessingService,
    calibrationProfiles,
  );
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  void cleanupIpcHandlers?.();
  processingService?.shutdown();
  backgroundProcessingService?.shutdown();
  processingService = null;
  backgroundProcessingService = null;
});
