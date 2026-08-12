import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BrowserWindow } from "electron";

import {
  parseCalibrationProfileDocument,
  serializeCalibrationProfileDocument,
  type CalibrationProfileDocument,
} from "../core/calibration.ts";
import type { CalibrationProfileSummary } from "../shared/contracts.ts";

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
