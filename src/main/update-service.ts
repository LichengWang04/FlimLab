import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { spawn } from "node:child_process";

import { app, ipcMain, type BrowserWindow } from "electron";
import { autoUpdater, type ProgressInfo, type UpdateDownloadedEvent, type UpdateInfo } from "electron-updater";

import type { UpdateStatus } from "../shared/contracts.ts";

const statusChannel = "update:status";
const checkChannel = "update:check";
const installChannel = "update:install";
const rollbackChannel = "update:rollback";
const changedChannel = "update:status-changed";

interface UpdateStateDocument {
  readonly schemaVersion: 1;
  readonly lastKnownGoodVersion?: string;
  readonly pendingVersion?: string;
  readonly previousVersion?: string;
  readonly failedLaunches: number;
  readonly cachedInstallers: Readonly<Record<string, string>>;
}

const emptyState: UpdateStateDocument = {
  schemaVersion: 1,
  failedLaunches: 0,
  cachedInstallers: {},
};

/**
 * Signed-package updater with a last-known-good cache. A downloaded installer
 * is not considered a rollback target until that exact version has reached a
 * visible main window. On Windows, two consecutive pre-window failures trigger
 * the cached NSIS installer automatically; other platforms retain the cache
 * and expose an explicit, honest unsupported message instead of attempting an
 * unsafe application-directory rewrite.
 */
export class UpdateService {
  private readonly root: string;
  private readonly statePath: string;
  private readonly cacheDirectory: string;
  private state: UpdateStateDocument = emptyState;
  private status: UpdateStatus;
  private downloadedVersion: string | undefined;
  private checking = false;

  public constructor(
    private readonly getMainWindow: () => BrowserWindow | null,
    root = join(app.getPath("userData"), "updates"),
  ) {
    this.root = root;
    this.statePath = join(root, "state-v1.json");
    this.cacheDirectory = join(root, "installers");
    this.status = {
      state: app.isPackaged ? "idle" : "disabled",
      currentVersion: app.getVersion(),
      message: app.isPackaged ? undefined : "开发构建不检查发行更新。",
    };
  }

  /** Returns true when automatic rollback has started and normal startup must stop. */
  public async initialize(): Promise<boolean> {
    this.state = await this.loadState();
    this.registerIpc();
    if (!app.isPackaged) return false;
    await mkdir(this.cacheDirectory, { recursive: true });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.disableWebInstaller = true;
    const updateUrl = process.env.FILMLAB_UPDATE_URL?.trim();
    if (updateUrl) autoUpdater.setFeedURL({ provider: "generic", url: updateUrl });
    this.bindUpdaterEvents();
    if (this.state.pendingVersion === app.getVersion()) {
      this.state = { ...this.state, failedLaunches: this.state.failedLaunches + 1 };
      await this.persistState();
      if (this.state.failedLaunches >= 2 && this.rollbackTarget() !== undefined && process.platform === "win32") {
        await this.startRollback(true);
        return true;
      }
    }
    this.publish({
      state: "idle",
      currentVersion: app.getVersion(),
      rollbackVersion: this.rollbackTarget()?.version,
    });
    return false;
  }

  public async markHealthy(): Promise<void> {
    const version = app.getVersion();
    if (this.state.pendingVersion === version || this.state.lastKnownGoodVersion === undefined) {
      this.state = {
        ...this.state,
        lastKnownGoodVersion: version,
        pendingVersion: undefined,
        failedLaunches: 0,
      };
      await this.persistState();
      this.publish({ ...this.status, rollbackVersion: this.rollbackTarget()?.version });
    }
  }

  public currentStatus(): UpdateStatus {
    return { ...this.status };
  }

  public async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) return this.currentStatus();
    if (this.checking) return this.currentStatus();
    this.checking = true;
    this.publish({ state: "checking", currentVersion: app.getVersion(), rollbackVersion: this.rollbackTarget()?.version });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error: unknown) {
      this.publishError(error);
    } finally {
      this.checking = false;
    }
    return this.currentStatus();
  }

  public async install(): Promise<void> {
    if (this.status.state !== "downloaded" || this.downloadedVersion === undefined) {
      throw new Error("更新尚未下载完成。");
    }
    this.state = {
      ...this.state,
      pendingVersion: this.downloadedVersion,
      previousVersion: app.getVersion(),
      failedLaunches: 0,
    };
    await this.persistState();
    autoUpdater.quitAndInstall(true, true);
  }

  public async rollback(): Promise<void> {
    await this.startRollback(false);
  }

  private bindUpdaterEvents(): void {
    autoUpdater.on("checking-for-update", () => this.publish({
      state: "checking",
      currentVersion: app.getVersion(),
      rollbackVersion: this.rollbackTarget()?.version,
    }));
    autoUpdater.on("update-available", (info: UpdateInfo) => this.publish({
      state: "available",
      currentVersion: app.getVersion(),
      availableVersion: info.version,
      rollbackVersion: this.rollbackTarget()?.version,
    }));
    autoUpdater.on("update-not-available", () => this.publish({
      state: "up-to-date",
      currentVersion: app.getVersion(),
      rollbackVersion: this.rollbackTarget()?.version,
    }));
    autoUpdater.on("download-progress", (progress: ProgressInfo) => this.publish({
      state: "downloading",
      currentVersion: app.getVersion(),
      availableVersion: this.status.availableVersion,
      downloadPercent: Math.max(0, Math.min(100, progress.percent)),
      rollbackVersion: this.rollbackTarget()?.version,
    }));
    autoUpdater.on("update-downloaded", (event: UpdateDownloadedEvent) => {
      void this.cacheDownloadedInstaller(event).then(() => {
        this.downloadedVersion = event.version;
        this.publish({
          state: "downloaded",
          currentVersion: app.getVersion(),
          availableVersion: event.version,
          downloadPercent: 100,
          rollbackVersion: this.rollbackTarget()?.version,
        });
      }).catch((error: unknown) => this.publishError(error));
    });
    autoUpdater.on("error", (error: Error) => this.publishError(error));
  }

  private registerIpc(): void {
    for (const channel of [statusChannel, checkChannel, installChannel, rollbackChannel]) ipcMain.removeHandler(channel);
    ipcMain.handle(statusChannel, (event) => {
      this.assertTrusted(event.sender.id);
      return this.currentStatus();
    });
    ipcMain.handle(checkChannel, async (event) => {
      this.assertTrusted(event.sender.id);
      return this.check();
    });
    ipcMain.handle(installChannel, async (event) => {
      this.assertTrusted(event.sender.id);
      await this.install();
    });
    ipcMain.handle(rollbackChannel, async (event) => {
      this.assertTrusted(event.sender.id);
      await this.rollback();
    });
  }

  private assertTrusted(senderId: number): void {
    const window = this.getMainWindow();
    if (window === null || window.webContents.id !== senderId) throw new Error("Rejected update request from an unknown renderer.");
  }

  private async cacheDownloadedInstaller(event: UpdateDownloadedEvent): Promise<void> {
    const extension = extname(event.downloadedFile) || ".package";
    const name = event.version + "-" + createHash("sha256").update(basename(event.downloadedFile)).digest("hex").slice(0, 12) + extension;
    const destination = join(this.cacheDirectory, name);
    await copyFile(event.downloadedFile, destination);
    const details = await stat(destination);
    if (!details.isFile() || details.size === 0) throw new Error("下载的更新安装包为空。");
    this.state = {
      ...this.state,
      cachedInstallers: { ...this.state.cachedInstallers, [event.version]: destination },
    };
    await this.persistState();
  }

  private rollbackTarget(): { readonly version: string; readonly installer: string } | undefined {
    const version = this.state.previousVersion ?? this.state.lastKnownGoodVersion;
    if (version === undefined || version === app.getVersion()) return undefined;
    const installer = this.state.cachedInstallers[version];
    return installer === undefined ? undefined : { version, installer };
  }

  private async startRollback(automatic: boolean): Promise<void> {
    const target = this.rollbackTarget();
    if (target === undefined) throw new Error("没有可验证的已知良好版本安装包可供回滚。");
    if (process.platform !== "win32" || extname(target.installer).toLowerCase() !== ".exe") {
      throw new Error("当前平台不会自动改写应用目录；请从发行页重新安装 v" + target.version + "。");
    }
    const details = await stat(target.installer);
    if (!details.isFile() || details.size === 0) throw new Error("回滚安装包不可用。");
    this.state = {
      ...this.state,
      pendingVersion: target.version,
      // Do not offer the version being escaped from as the next rollback
      // target after the known-good installer starts successfully.
      previousVersion: undefined,
      failedLaunches: 0,
    };
    await this.persistState();
    this.publish({
      state: "downloaded",
      currentVersion: app.getVersion(),
      availableVersion: target.version,
      rollbackVersion: target.version,
      message: automatic ? "连续启动失败，正在自动回滚。" : "正在回滚到已知良好版本。",
    });
    const child = spawn(target.installer, ["/S"], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    app.quit();
  }

  private publish(status: UpdateStatus): void {
    this.status = status;
    const window = this.getMainWindow();
    if (window !== null && !window.isDestroyed()) window.webContents.send(changedChannel, status);
  }

  private publishError(error: unknown): void {
    const message = error instanceof Error ? error.message : "更新检查失败。";
    this.publish({
      state: "error",
      currentVersion: app.getVersion(),
      rollbackVersion: this.rollbackTarget()?.version,
      message,
    });
  }

  private async loadState(): Promise<UpdateStateDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<UpdateStateDocument>;
      if (parsed.schemaVersion !== 1 || typeof parsed.failedLaunches !== "number" || typeof parsed.cachedInstallers !== "object" || parsed.cachedInstallers === null) {
        return emptyState;
      }
      return {
        schemaVersion: 1,
        lastKnownGoodVersion: parsed.lastKnownGoodVersion,
        pendingVersion: parsed.pendingVersion,
        previousVersion: parsed.previousVersion,
        failedLaunches: parsed.failedLaunches,
        cachedInstallers: parsed.cachedInstallers,
      };
    } catch {
      return emptyState;
    }
  }

  private async persistState(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const temporary = this.statePath + ".tmp";
    await writeFile(temporary, JSON.stringify(this.state, null, 2) + "\n", "utf8");
    await rename(temporary, this.statePath);
  }
}
