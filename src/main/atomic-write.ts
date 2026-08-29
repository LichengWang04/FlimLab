import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_RENAME_DELAYS_MS = [25, 50, 100, 200, 400, 800] as const;
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EEXIST"]);

export interface AtomicFileSystem {
  writeFile(path: string, data: Uint8Array): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options: { force: boolean }): Promise<void>;
}

export interface AtomicPublishOptions {
  fileSystem?: AtomicFileSystem;
  retryDelaysMs?: readonly number[];
  wait?: (milliseconds: number) => Promise<void>;
}

const nativeFileSystem: AtomicFileSystem = {
  writeFile: (path, data) => fs.writeFile(path, data),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  rm: (path, options) => fs.rm(path, options),
};

/**
 * Writes a complete sibling temporary file and publishes it without deleting
 * an existing target first. A locked Windows target is retried briefly; if it
 * stays locked, the old file survives and the temporary file is removed.
 */
export async function publishFileAtomic(
  path: string,
  writeTemporary: (temporaryPath: string) => Promise<void>,
  options: AtomicPublishOptions = {},
): Promise<void> {
  const fileSystem = options.fileSystem ?? nativeFileSystem;
  const temporary = atomicTemporaryPath(path);
  let published = false;
  try {
    await writeTemporary(temporary);
    await renameWithRetry(
      () => fileSystem.rename(temporary, path),
      options.retryDelaysMs ?? DEFAULT_RENAME_DELAYS_MS,
      options.wait,
    );
    published = true;
  } finally {
    if (!published) await fileSystem.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Publishes an in-memory payload through the shared atomic publisher. */
export async function writeFileAtomic(
  path: string,
  data: Uint8Array,
  options: AtomicPublishOptions = {},
): Promise<void> {
  const fileSystem = options.fileSystem ?? nativeFileSystem;
  await publishFileAtomic(path, (temporary) => fileSystem.writeFile(temporary, data), {
    ...options,
    fileSystem,
  });
}

export async function renameWithRetry(
  rename: () => Promise<void>,
  delaysMs: readonly number[] = DEFAULT_RENAME_DELAYS_MS,
  wait: (milliseconds: number) => Promise<void> = delay,
): Promise<void> {
  for (let attempt = 0;; attempt += 1) {
    try {
      await rename();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !RETRYABLE_RENAME_CODES.has(code) || attempt >= delaysMs.length) {
        if (code !== undefined && RETRYABLE_RENAME_CODES.has(code)) throw atomicReplaceError();
        throw error;
      }
      await wait(delaysMs[attempt]!);
    }
  }
}

function atomicTemporaryPath(path: string): string {
  return join(
    dirname(path),
    `.${path.split(/[\\/]/).pop() ?? "export"}.${randomBytes(6).toString("hex")}.part`,
  );
}

function atomicReplaceError(): Error {
  return Object.assign(new Error("目标文件正在使用或无法安全替换，请关闭占用它的程序后重试。"), { code: "EPERM" });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
