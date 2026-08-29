import { promises as fs } from "node:fs";
import { extname } from "node:path";
import type { Recipe } from "../core/index.ts";
import type { RestoredSession, SessionSaveRequest } from "../shared/ipc.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { parseRecipe } from "./ipc-validation.ts";
import { framePath, registerFrames } from "./roll-service.ts";
import { MAX_ROLL_FRAMES } from "./resource-limits.ts";

interface PersistedSession {
  version: 1;
  activePath?: string;
  frames: { path: string; recipe: Recipe; skipped: boolean }[];
}

const SUPPORTED = new Set([
  ".tif", ".tiff", ".jpg", ".jpeg", ".png", ".cr2", ".nef", ".rw2", ".arw",
]);

export class SessionStore {
  private saveChain = Promise.resolve();
  private readonly sessionPath: () => string;

  constructor(sessionPath: () => string) {
    this.sessionPath = sessionPath;
  }

  save(request: SessionSaveRequest): Promise<void> {
    const operation = async (): Promise<void> => {
      const frames = request.frames.flatMap((frame) => {
        const path = framePath(frame.id);
        return path === null ? [] : [{ path, recipe: frame.recipe, skipped: frame.skipped }];
      });
      const activePath = request.activeId === undefined ? undefined : framePath(request.activeId) ?? undefined;
      const persisted: PersistedSession = {
        version: 1,
        frames,
        ...(activePath === undefined ? {} : { activePath }),
      };
      await writeFileAtomic(this.sessionPath(), Buffer.from(JSON.stringify(persisted), "utf8"));
    };
    this.saveChain = this.saveChain.then(operation, operation);
    return this.saveChain;
  }

  async restore(): Promise<RestoredSession | null> {
    let text: string;
    try {
      text = await fs.readFile(this.sessionPath(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const stored = value as Partial<PersistedSession>;
    if (stored.version !== 1 || !Array.isArray(stored.frames) || stored.frames.length > MAX_ROLL_FRAMES) return null;

    const available: PersistedSession["frames"] = [];
    for (const candidate of stored.frames) {
      if (
        typeof candidate !== "object" || candidate === null
        || typeof candidate.path !== "string"
        || typeof candidate.skipped !== "boolean"
        || !SUPPORTED.has(extname(candidate.path).toLowerCase())
      ) continue;
      try {
        const stat = await fs.stat(candidate.path);
        if (!stat.isFile()) continue;
        available.push({ path: candidate.path, recipe: parseRecipe(candidate.recipe), skipped: candidate.skipped });
      } catch {
        // Missing or invalid frames are pruned from the recovered session.
      }
    }
    if (available.length === 0) return null;
    const infos = registerFrames(available.map((frame) => frame.path));
    const restoredFrames = infos.map((info, index) => ({
      info,
      recipe: available[index]!.recipe,
      skipped: available[index]!.skipped,
    }));
    const activeIndex = stored.activePath === undefined
      ? 0
      : Math.max(0, available.findIndex((frame) => frame.path === stored.activePath));
    return { frames: restoredFrames, activeId: restoredFrames[activeIndex]!.info.id };
  }
}
