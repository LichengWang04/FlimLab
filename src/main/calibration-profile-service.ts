import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { BrowserWindow } from "electron";

import {
  parseCalibrationProfileDocument,
  serializeCalibrationProfileDocument,
  type CalibrationProfileDocument,
} from "../core/calibration.ts";
import type {
  CalibrationProfileExportResult,
  CalibrationProfileSummary,
  CalibrationProfileVersionSummary,
} from "../shared/contracts.ts";

/**
 * Durable, main-process-owned calibration profiles. The renderer receives a
 * summary and an opaque id only; raw profile JSON is validated here before the
 * image worker sees it.
 */
export class CalibrationProfileService {
  private readonly profileDirectory: string;
  private readonly profiles = new Map<string, CalibrationProfileDocument>();
  private initialized = false;

  public constructor(profileDirectory: string) {
    this.profileDirectory = profileDirectory;
  }

  public async importFromDialog(parent: BrowserWindow): Promise<CalibrationProfileSummary | undefined> {
    const { dialog } = await import("electron");
    const selection = await dialog.showOpenDialog(parent, {
      title: "导入色卡标定配置",
      buttonLabel: "导入配置",
      properties: ["openFile"],
      filters: [
        { name: "FilmLab 标定配置", extensions: ["filmlab-calibration.json", "json"] },
      ],
    });
    if (selection.canceled || selection.filePaths[0] === undefined) {
      return undefined;
    }
    return this.importFromFile(selection.filePaths[0]);
  }

  public async importFromFile(filePath: string): Promise<CalibrationProfileSummary> {
    const contents = await readFile(filePath, "utf8");
    let document: CalibrationProfileDocument;
    try {
      document = parseCalibrationProfileDocument(contents);
      assertProfileId(document.id);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "未知格式错误";
      throw new Error("标定配置无法导入：" + message);
    }
    await this.store(document);
    return summarize(document);
  }

  public async exportToDialog(
    parent: BrowserWindow,
    id: string,
  ): Promise<CalibrationProfileExportResult> {
    const document = await this.get(id);
    if (document === undefined) throw new Error("找不到要导出的标定配置。");
    const { dialog } = await import("electron");
    const selection = await dialog.showSaveDialog(parent, {
      title: "导出色卡标定配置",
      buttonLabel: "导出配置",
      defaultPath: safeExportName(document.name, document.version),
      filters: [{ name: "FilmLab 标定配置", extensions: ["json"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    });
    if (selection.canceled || selection.filePath === undefined) return { saved: false };
    const outputPath = selection.filePath.toLowerCase().endsWith(".json")
      ? selection.filePath
      : selection.filePath + ".json";
    await writeFile(outputPath, serializeCalibrationProfileDocument(document), { encoding: "utf8", flag: "wx" })
      .catch(async (error: unknown) => {
        if (!hasCode(error, "EEXIST")) throw error;
        await writeFile(outputPath, serializeCalibrationProfileDocument(document), "utf8");
      });
    return { saved: true, fileName: basename(outputPath) };
  }

  public async list(): Promise<readonly CalibrationProfileSummary[]> {
    await this.ensureLoaded();
    return [...this.profiles.values()]
      .map(summarize)
      .sort((left, right) => left.label.localeCompare(right.label, "zh-Hans-CN"));
  }

  public async get(id: string): Promise<CalibrationProfileDocument | undefined> {
    await this.ensureLoaded();
    return this.profiles.get(id);
  }

  public async listVersions(id: string): Promise<readonly CalibrationProfileVersionSummary[]> {
    assertProfileId(id);
    await this.ensureLoaded();
    const versions: CalibrationProfileVersionSummary[] = [];
    const current = this.profiles.get(id);
    if (current !== undefined) versions.push({ ...summarize(current), current: true });
    const directory = historyDirectory(this.profileDirectory, id);
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const document = parseCalibrationProfileDocument(await readFile(join(directory, entry.name), "utf8"));
        if (document.id !== id || document.version === current?.version) continue;
        versions.push({ ...summarize(document), current: false });
      } catch {
        // One corrupt history entry must not hide the usable current profile.
      }
    }
    return versions.sort((left, right) => compareVersions(right.version, left.version));
  }

  public async restoreVersion(id: string, version: string): Promise<CalibrationProfileSummary> {
    assertProfileId(id);
    assertVersion(version);
    const current = await this.get(id);
    if (current?.version === version) return summarize(current);
    const path = join(historyDirectory(this.profileDirectory, id), versionFileName(version));
    const document = parseCalibrationProfileDocument(await readFile(path, "utf8").catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) throw new Error("找不到该标定配置历史版本。");
      throw error;
    }));
    if (document.id !== id || document.version !== version) throw new Error("标定配置历史版本身份不匹配。");
    await this.store(document);
    return summarize(document);
  }

  public async delete(id: string): Promise<boolean> {
    assertProfileId(id);
    await this.ensureLoaded();
    const existed = this.profiles.delete(id);
    await Promise.all([
      rm(join(this.profileDirectory, profileFileName(id)), { force: true }),
      rm(historyDirectory(this.profileDirectory, id), { force: true, recursive: true }),
    ]);
    return existed;
  }

  /** Returns the canonical validated JSON used for a portable project snapshot. */
  public async serialize(id: string): Promise<string | undefined> {
    const document = await this.get(id);
    return document === undefined ? undefined : serializeCalibrationProfileDocument(document);
  }

  /** Restores a project-owned snapshot into the machine-local profile store. */
  public async importSerialized(contents: string): Promise<CalibrationProfileSummary> {
    const document = parseCalibrationProfileDocument(contents);
    assertProfileId(document.id);
    await this.store(document);
    return summarize(document);
  }

  /** Stores a profile produced by the isolated color-card workflow using the
   * same validation and atomic-write path as an imported profile. */
  public async saveGenerated(document: CalibrationProfileDocument): Promise<CalibrationProfileSummary> {
    const validated = parseCalibrationProfileDocument(document);
    assertProfileId(validated.id);
    await this.store(validated);
    return summarize(validated);
  }

  private async store(document: CalibrationProfileDocument): Promise<void> {
    await this.ensureLoaded();
    await mkdir(this.profileDirectory, { recursive: true });
    assertVersion(document.version);
    const current = this.profiles.get(document.id);
    if (current !== undefined) {
      const currentJson = serializeCalibrationProfileDocument(current);
      const nextJson = serializeCalibrationProfileDocument(document);
      if (current.version === document.version && currentJson !== nextJson) {
        throw new Error("同一标定配置版本的内容不同；请提高 version 后再导入。");
      }
      if (currentJson === nextJson) return;
      await this.archive(current);
    }
    const destination = join(this.profileDirectory, profileFileName(document.id));
    const temporary = join(this.profileDirectory, "." + randomUUID() + ".tmp");
    try {
      await writeFile(temporary, serializeCalibrationProfileDocument(document), "utf8");
      await rename(temporary, destination);
      this.profiles.set(document.id, document);
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async archive(document: CalibrationProfileDocument): Promise<void> {
    const directory = historyDirectory(this.profileDirectory, document.id);
    await mkdir(directory, { recursive: true });
    const destination = join(directory, versionFileName(document.version));
    const temporary = join(directory, "." + randomUUID() + ".tmp");
    try {
      await writeFile(temporary, serializeCalibrationProfileDocument(document), "utf8");
      await rename(temporary, destination).catch(async (error: unknown) => {
        if (!hasCode(error, "EEXIST")) throw error;
        await unlink(temporary).catch(() => undefined);
      });
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await mkdir(this.profileDirectory, { recursive: true });
    const entries = await readdir(this.profileDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      try {
        const contents = await readFile(join(this.profileDirectory, entry.name), "utf8");
        const document = parseCalibrationProfileDocument(contents);
        assertProfileId(document.id);
        this.profiles.set(document.id, document);
      } catch {
        // A malformed manually edited profile must not prevent opening the
        // project. Import still reports detailed errors before it writes.
      }
    }
    this.initialized = true;
  }
}

export function summarize(document: CalibrationProfileDocument): CalibrationProfileSummary {
  return {
    id: document.id,
    version: document.version,
    createdAt: document.createdAt,
    calibrationId: document.calibrationId,
    captureFingerprint: document.captureFingerprint,
    label: document.name,
    hasLut: document.transform.lut !== undefined,
  };
}

function profileFileName(id: string): string {
  // Profile IDs are external data. Hashing avoids interpreting any part of an
  // ID as a path while retaining a stable filename for overwrite semantics.
  return "profile-" + createHash("sha256").update(id, "utf8").digest("hex") + ".json";
}

function assertProfileId(id: string): void {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(id)) {
    throw new Error("标定配置 ID 只能包含字母、数字、点、下划线或连字符，且长度不能超过 128。");
  }
}

function assertVersion(version: string): void {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(version)) {
    throw new Error("标定配置 version 格式无效。");
  }
}

function historyDirectory(root: string, id: string): string {
  return join(root, "history", createHash("sha256").update(id, "utf8").digest("hex"));
}

function versionFileName(version: string): string {
  return "version-" + createHash("sha256").update(version, "utf8").digest("hex") + ".json";
}

function safeExportName(name: string, version: string): string {
  const stem = (name + "-v" + version)
    .replace(/[<>:\"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "filmlab-calibration";
  return stem + ".filmlab-calibration.json";
}

function compareVersions(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}
