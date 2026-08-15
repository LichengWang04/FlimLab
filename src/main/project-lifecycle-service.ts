import { createHash, randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type {
  ProjectBackupResult,
  ProjectSaveResult,
  ProjectSessionSummary,
  RecentProjectSummary,
} from "../shared/contracts.ts";
import {
  projectSchemaVersion,
  type ProjectRecipe,
  type WorkspaceProject,
  type WorkspaceProjectDraft,
} from "../shared/project.ts";
import { CalibrationProfileService } from "./calibration-profile-service.ts";
import {
  ProjectService,
  createDefaultProject,
  parseProjectDraft,
  parseStoredProject,
} from "./project-service.ts";

const projectFileName = "project.json";
const calibrationDirectoryName = "calibration-profiles";
const backupsDirectoryName = "backups";
const maximumRecentProjects = 12;
const maximumAutomaticBackups = 10;
const maximumManualBackups = 20;

interface RecentProjectRecord {
  readonly id: string;
  readonly path: string;
  readonly lastOpenedAt: string;
}

interface ProjectSessionStateFile {
  readonly schemaVersion: 1;
  readonly activeId?: string;
  readonly activeReadOnly?: boolean;
  readonly projects: readonly RecentProjectRecord[];
}

interface ActiveSession {
  readonly bundlePath: string;
  readonly summary: ProjectSessionSummary;
}

export interface LifecycleProjectLoad {
  readonly project: WorkspaceProject;
  readonly session: ProjectSessionSummary;
  readonly recentProjects: readonly RecentProjectSummary[];
  readonly restoredCalibrationProfileIds: readonly string[];
}

/**
 * Owns the machine-private project path and recent-project index. Renderer
 * callers see only opaque session/recent IDs; project.json remains portable.
 */
export class ProjectLifecycleService {
  private readonly projectsRoot: string;
  private readonly stateFilePath: string;
  private readonly calibrations: CalibrationProfileService;
  private active: ActiveSession | undefined;
  private records: RecentProjectRecord[] = [];
  private initialized = false;
  // Startup and renderer IPC can both update the recent-project index. Keep
  // those atomic replacements in order so Windows never sees two renames
  // racing for the same destination file.
  private stateWriteTail: Promise<void> = Promise.resolve();

  public constructor(
    projectsRoot: string,
    stateFilePath: string,
    calibrations: CalibrationProfileService,
  ) {
    this.projectsRoot = resolve(projectsRoot);
    this.stateFilePath = resolve(stateFilePath);
    this.calibrations = calibrations;
  }

  public async loadStartup(): Promise<LifecycleProjectLoad> {
    await this.ensureInitialized();
    const state = await this.readState();
    const activeRecord = state.activeId === undefined
      ? undefined
      : this.records.find((record) => record.id === state.activeId);
    const defaultPath = join(this.projectsRoot, "workspace.filmlab");
    const restoreActive = activeRecord !== undefined && await exists(activeRecord.path);
    const bundlePath = restoreActive
      ? activeRecord.path
      : defaultPath;
    return this.openBundle(
      bundlePath,
      restoreActive && state.activeReadOnly === true,
      resolve(bundlePath) === resolve(defaultPath),
    );
  }

  public async create(bundlePath: string): Promise<LifecycleProjectLoad> {
    await this.ensureInitialized();
    const normalized = normalizeBundlePath(bundlePath);
    await assertNewBundleTarget(normalized);
    await mkdir(normalized, { recursive: true });
    const project = createDefaultProject();
    const stored = await this.storeFor(normalized).save(project);
    this.active = { bundlePath: normalized, summary: await this.createSummary(normalized, false) };
    await this.touchRecent(normalized, false);
    return this.result(stored, []);
  }

  public async open(bundlePath: string, readOnly: boolean): Promise<LifecycleProjectLoad> {
    await this.ensureInitialized();
    return this.openBundle(assertOpenBundlePath(bundlePath), readOnly, false);
  }

  public async openRecent(id: string, readOnly: boolean): Promise<LifecycleProjectLoad> {
    await this.ensureInitialized();
    assertOpaqueId(id);
    const record = this.records.find((candidate) => candidate.id === id);
    if (record === undefined) throw new Error("最近项目记录不存在。");
    return this.openBundle(record.path, readOnly, false);
  }

  public async save(sessionId: string, value: unknown): Promise<ProjectSaveResult> {
    const active = this.requireSession(sessionId);
    if (active.summary.pendingAction !== undefined) {
      throw new Error("请先确认项目迁移或备份恢复，再继续保存。");
    }
    if (active.summary.readOnly) throw new Error("当前项目以只读方式打开，请使用“另存为”。");
    const draft = parseProjectDraft(value);
    await this.createBackupInternal(active.bundlePath, "automatic");
    await this.writeCalibrationSnapshots(active.bundlePath, draft);
    const project = await this.storeFor(active.bundlePath).save(draft);
    this.active = {
      ...active,
      summary: await this.createSummary(active.bundlePath, false, undefined, projectSchemaVersion, active.summary.id),
    };
    await this.touchRecent(active.bundlePath, false);
    return { project, backupCount: this.active.summary.backupCount };
  }

  public async saveAs(sessionId: string, value: unknown, bundlePath: string): Promise<LifecycleProjectLoad> {
    this.requireSession(sessionId);
    const draft = parseProjectDraft(value);
    const normalized = normalizeBundlePath(bundlePath);
    await assertNewBundleTarget(normalized);
    await mkdir(normalized, { recursive: true });
    await this.writeCalibrationSnapshots(normalized, draft);
    const project = await this.storeFor(normalized).save(draft);
    this.active = { bundlePath: normalized, summary: await this.createSummary(normalized, false) };
    await this.touchRecent(normalized, false);
    return this.result(project, []);
  }

  public async confirmPending(sessionId: string, value: unknown): Promise<LifecycleProjectLoad> {
    const active = this.requireSession(sessionId);
    if (active.summary.pendingAction === undefined) throw new Error("当前项目没有待确认的迁移或恢复。");
    const draft = parseProjectDraft(value);
    const projectPath = join(active.bundlePath, projectFileName);
    const legacyPath = join(this.projectsRoot, "workspace.filmlab.json");
    const migrationSource = active.summary.pendingAction === "migration"
      && !await exists(projectPath)
      && await exists(legacyPath)
      ? legacyPath
      : projectPath;
    await this.createBackupInternal(active.bundlePath, "manual", migrationSource);
    await this.writeCalibrationSnapshots(active.bundlePath, draft);
    const project = await this.storeFor(active.bundlePath).save(draft);
    this.active = {
      bundlePath: active.bundlePath,
      summary: await this.createSummary(active.bundlePath, false, undefined, projectSchemaVersion, active.summary.id),
    };
    await this.touchRecent(active.bundlePath, false);
    return this.result(project, []);
  }

  public async createBackup(sessionId: string): Promise<ProjectBackupResult> {
    const active = this.requireSession(sessionId);
    if (active.summary.readOnly) throw new Error("只读项目不能修改项目包；请先另存为再创建备份。");
    const createdAt = await this.createBackupInternal(active.bundlePath, "manual");
    const backupCount = await countBackups(active.bundlePath);
    this.active = { ...active, summary: { ...active.summary, backupCount } };
    return { created: createdAt !== undefined, createdAt, backupCount };
  }

  public async recentProjects(): Promise<readonly RecentProjectSummary[]> {
    await this.ensureInitialized();
    return Promise.all(this.records.map(async (record) => ({
      id: record.id,
      name: projectDisplayName(record.path),
      lastOpenedAt: record.lastOpenedAt,
      available: await exists(record.path),
    })));
  }

  private async openBundle(
    bundlePath: string,
    requestedReadOnly: boolean,
    allowMissingDefault: boolean,
  ): Promise<LifecycleProjectLoad> {
    const normalized = resolve(bundlePath);
    if (!normalized.toLocaleLowerCase("en-US").endsWith(".filmlab")) {
      throw new Error("项目目录必须以 .filmlab 结尾。");
    }

    let contents: string | undefined;
    let sourceVersion: number = projectSchemaVersion;
    let snapshotRoot = normalized;
    try {
      contents = await readFile(join(normalized, projectFileName), "utf8");
    } catch (error: unknown) {
      const legacyPath = join(this.projectsRoot, "workspace.filmlab.json");
      if (normalized === join(this.projectsRoot, "workspace.filmlab") && await exists(legacyPath)) {
        contents = await readFile(legacyPath, "utf8");
      } else if (!allowMissingDefault || !hasCode(error, "ENOENT")) {
        throw new Error("所选目录不是可读取的 FilmLab 项目。");
      }
    }

    let project: WorkspaceProject;
    let pendingAction: ProjectSessionSummary["pendingAction"];
    if (contents === undefined) {
      project = createDefaultProject();
    } else {
      try {
        const raw = JSON.parse(contents) as { readonly schemaVersion?: unknown };
        sourceVersion = typeof raw.schemaVersion === "number" ? raw.schemaVersion : projectSchemaVersion;
        project = parseStoredProject(raw);
        if (sourceVersion !== projectSchemaVersion) pendingAction = "migration";
      } catch (error: unknown) {
        const recovered = await this.readLatestValidBackup(normalized);
        if (recovered === undefined) {
          const message = error instanceof Error ? error.message : "格式错误";
          throw new Error("项目文件已损坏且没有可用备份：" + message);
        }
        project = recovered.project;
        snapshotRoot = recovered.directory;
        pendingAction = "recovery";
      }
    }

    const restoredCalibrationProfileIds = await this.restoreCalibrationSnapshots(snapshotRoot);
    const readOnly = requestedReadOnly || pendingAction !== undefined;
    const summary = await this.createSummary(normalized, readOnly, pendingAction, sourceVersion);
    this.active = { bundlePath: normalized, summary };
    await this.touchRecent(normalized, readOnly);
    return this.result(project, restoredCalibrationProfileIds);
  }

  private async result(
    project: WorkspaceProject,
    restoredCalibrationProfileIds: readonly string[],
  ): Promise<LifecycleProjectLoad> {
    if (this.active === undefined) throw new Error("项目会话尚未建立。");
    return {
      project,
      session: this.active.summary,
      recentProjects: await this.recentProjects(),
      restoredCalibrationProfileIds,
    };
  }

  private requireSession(sessionId: string): ActiveSession {
    assertOpaqueId(sessionId);
    if (this.active === undefined || this.active.summary.id !== sessionId) {
      throw new Error("项目会话已切换，已拒绝过期保存请求。");
    }
    return this.active;
  }

  private storeFor(bundlePath: string): ProjectService {
    return new ProjectService(dirname(bundlePath), basename(bundlePath), false);
  }

  private async createSummary(
    bundlePath: string,
    readOnly: boolean,
    pendingAction?: ProjectSessionSummary["pendingAction"],
    sourceVersion: number = projectSchemaVersion,
    sessionId = createSessionId(),
  ): Promise<ProjectSessionSummary> {
    return {
      id: sessionId,
      projectId: projectId(bundlePath),
      name: projectDisplayName(bundlePath),
      readOnly,
      ...(pendingAction === undefined ? {} : { pendingAction }),
      ...(pendingAction === "migration" ? { migratedFromVersion: sourceVersion } : {}),
      backupCount: await countBackups(bundlePath),
    };
  }

  private async touchRecent(bundlePath: string, readOnly: boolean): Promise<void> {
    const id = projectId(bundlePath);
    const record = { id, path: bundlePath, lastOpenedAt: new Date().toISOString() };
    this.records = [record, ...this.records.filter((candidate) => candidate.id !== id)]
      .slice(0, maximumRecentProjects);
    await this.writeState({ schemaVersion: 1, activeId: id, activeReadOnly: readOnly, projects: this.records });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const state = await this.readState();
    this.records = [...state.projects];
    this.initialized = true;
  }

  private async readState(): Promise<ProjectSessionStateFile> {
    try {
      const raw = JSON.parse(await readFile(this.stateFilePath, "utf8")) as Partial<ProjectSessionStateFile>;
      if (raw.schemaVersion !== 1 || !Array.isArray(raw.projects)) throw new Error("invalid state");
      const projects = raw.projects.flatMap((value): readonly RecentProjectRecord[] => {
        if (
          typeof value !== "object" || value === null
          || typeof value.id !== "string" || !/^[a-f0-9]{64}$/.test(value.id)
          || typeof value.path !== "string" || !resolve(value.path).toLocaleLowerCase("en-US").endsWith(".filmlab")
          || typeof value.lastOpenedAt !== "string" || Number.isNaN(Date.parse(value.lastOpenedAt))
        ) return [];
        return [{ id: value.id, path: resolve(value.path), lastOpenedAt: value.lastOpenedAt }];
      }).slice(0, maximumRecentProjects);
      return {
        schemaVersion: 1,
        activeId: typeof raw.activeId === "string" ? raw.activeId : undefined,
        activeReadOnly: raw.activeReadOnly === true,
        projects,
      };
    } catch (error: unknown) {
      if (!hasCode(error, "ENOENT") && !(error instanceof SyntaxError) && !(error instanceof Error && error.message === "invalid state")) {
        throw error;
      }
      return { schemaVersion: 1, projects: [] };
    }
  }

  private async writeState(state: ProjectSessionStateFile): Promise<void> {
    const pending = this.stateWriteTail.then(async () => {
      await mkdir(dirname(this.stateFilePath), { recursive: true });
      const temporary = this.stateFilePath + "." + randomUUID() + ".tmp";
      try {
        await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
        await renameWithRetry(temporary, this.stateFilePath);
      } catch (error: unknown) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    // A failed write must not poison the queue for later saves.
    this.stateWriteTail = pending.catch(() => undefined);
    await pending;
  }

  private async writeCalibrationSnapshots(bundlePath: string, draft: WorkspaceProjectDraft): Promise<void> {
    const ids = referencedCalibrationIds(draft);
    const directory = join(bundlePath, calibrationDirectoryName);
    await mkdir(directory, { recursive: true });
    const expected = new Set(ids.map((id) => id + ".json"));
    for (const id of ids) {
      const contents = await this.calibrations.serialize(id);
      if (contents === undefined) {
        throw new Error("项目引用的标定配置在本机不可用，无法创建可移植快照：" + id);
      }
      const destination = join(directory, id + ".json");
      const temporary = join(directory, "." + randomUUID() + ".tmp");
      await writeFile(temporary, contents, "utf8");
      await rename(temporary, destination);
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json") && !expected.has(entry.name)) {
        await rm(join(directory, entry.name), { force: true });
      }
    }
  }

  private async restoreCalibrationSnapshots(root: string): Promise<readonly string[]> {
    const directory = join(root, calibrationDirectoryName);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) return [];
      throw error;
    }
    const restored: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const summary = await this.calibrations.importSerialized(await readFile(join(directory, entry.name), "utf8"));
      restored.push(summary.id);
    }
    return restored.sort();
  }

  private async createBackupInternal(
    bundlePath: string,
    kind: "automatic" | "manual",
    source = join(bundlePath, projectFileName),
  ): Promise<string | undefined> {
    if (!await exists(source)) return undefined;
    const createdAt = new Date().toISOString();
    const safeTime = createdAt.replace(/[:.]/g, "-");
    const directory = join(bundlePath, backupsDirectoryName, kind + "-" + safeTime + "-" + randomUUID());
    await mkdir(directory, { recursive: true });
    await copyFile(source, join(directory, projectFileName));
    const calibrationSource = join(bundlePath, calibrationDirectoryName);
    if (await exists(calibrationSource)) {
      await cp(calibrationSource, join(directory, calibrationDirectoryName), { recursive: true });
    }
    await writeFile(join(directory, "backup.json"), JSON.stringify({ schemaVersion: 1, kind, createdAt }, null, 2), "utf8");
    await pruneBackups(bundlePath, "automatic", maximumAutomaticBackups);
    await pruneBackups(bundlePath, "manual", maximumManualBackups);
    return createdAt;
  }

  private async readLatestValidBackup(
    bundlePath: string,
  ): Promise<{ readonly project: WorkspaceProject; readonly directory: string } | undefined> {
    const root = join(bundlePath, backupsDirectoryName);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
    const directories = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const directory = join(root, entry.name);
      try {
        const metadata = JSON.parse(await readFile(join(directory, "backup.json"), "utf8")) as {
          readonly createdAt?: unknown;
        };
        const createdAt = typeof metadata.createdAt === "string" ? Date.parse(metadata.createdAt) : Number.NaN;
        if (Number.isFinite(createdAt)) return { directory, createdAt };
      } catch {
        // Older backup directories can fall back to their filesystem time.
      }
      return { directory, createdAt: (await stat(directory)).mtimeMs };
    }));
    directories.sort((left, right) => right.createdAt - left.createdAt);
    for (const candidate of directories) {
      const directory = candidate.directory;
      try {
        const project = parseStoredProject(JSON.parse(await readFile(join(directory, projectFileName), "utf8")));
        return { project, directory };
      } catch {
        // Continue to an older valid backup.
      }
    }
    return undefined;
  }
}

function referencedCalibrationIds(draft: WorkspaceProjectDraft): readonly string[] {
  const ids = new Set<string>();
  const visit = (recipe: ProjectRecipe | undefined): void => {
    if (recipe?.calibrationProfileId !== undefined) ids.add(recipe.calibrationProfileId);
  };
  visit(draft.recipe);
  for (const preset of draft.presets ?? []) visit(preset.recipe);
  for (const roll of draft.rolls) {
    visit(roll.uniformRecipe?.recipe);
    for (const recipe of Object.values(roll.recipesByFrameId ?? {})) visit(recipe);
  }
  return [...ids].sort();
}

async function assertNewBundleTarget(bundlePath: string): Promise<void> {
  try {
    const info = await stat(bundlePath);
    if (!info.isDirectory()) throw new Error("项目目标必须是目录。");
    const entries = await readdir(bundlePath);
    if (entries.length > 0) throw new Error("项目目标目录必须为空，请选择新名称。");
  } catch (error: unknown) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

function assertOpenBundlePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new Error("项目目录无效。");
  const normalized = resolve(value);
  if (!normalized.toLocaleLowerCase("en-US").endsWith(".filmlab")) {
    throw new Error("请选择以 .filmlab 结尾的项目目录。");
  }
  return normalized;
}

function normalizeBundlePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new Error("项目目录无效。");
  const normalized = resolve(value);
  return normalized.toLocaleLowerCase("en-US").endsWith(".filmlab") ? normalized : normalized + ".filmlab";
}

function projectId(path: string): string {
  const normalized = process.platform === "win32" ? resolve(path).toLocaleLowerCase("en-US") : resolve(path);
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function createSessionId(): string {
  return createHash("sha256").update(randomUUID(), "utf8").digest("hex");
}

function projectDisplayName(path: string): string {
  return basename(path).replace(/\.filmlab$/i, "") || "FilmLab 项目";
}

function assertOpaqueId(id: string): void {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("项目会话 ID 无效。");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function countBackups(bundlePath: string): Promise<number> {
  try {
    return (await readdir(join(bundlePath, backupsDirectoryName), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).length;
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return 0;
    throw error;
  }
}

async function pruneBackups(bundlePath: string, kind: "automatic" | "manual", maximum: number): Promise<void> {
  const root = join(bundlePath, backupsDirectoryName);
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(kind + "-"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of entries.slice(maximum)) await rm(join(root, name), { recursive: true, force: true });
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error: unknown) {
      if (!hasCode(error, "EPERM") && !hasCode(error, "EACCES") && !hasCode(error, "EBUSY")) {
        throw error;
      }
      lastError = error;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20 * 2 ** attempt));
    }
  }
  throw lastError;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}
