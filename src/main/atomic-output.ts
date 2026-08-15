import { randomUUID } from "node:crypto";
import { open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const legacyStaleAgeMs = 24 * 60 * 60 * 1_000;

/** Flushes a just-written file so a following rename cannot publish an empty
 * or partially written artifact after a power loss. */
export async function syncFile(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r+");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Flushes a directory entry so a completed rename survives a power loss.
 * Some platforms/filesystems reject directory fsync; treat that as
 * best-effort rather than failing the export. */
export async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error: unknown) {
    if (!hasCode(error, "EINVAL") && !hasCode(error, "EPERM") && !hasCode(error, "EACCES") && !hasCode(error, "ENOTSUP") && !hasCode(error, "EBADF")) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Windows rename can transiently fail with EPERM/EACCES/EBUSY while an
 * antivirus scan or indexer holds the destination; retry briefly instead of
 * failing a user-visible save.
 */
export async function renameWithRetry(source: string, destination: string): Promise<void> {
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

/** A PID-bearing same-directory name lets a retry remove files left by a dead process. */
export function atomicTemporaryPath(outputPath: string): string {
  return join(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
}

/**
 * Remove unpublished files for this exact destination when their owning
 * process no longer exists. Pre-PID FilmLab leftovers are removed after one
 * day. Live exports and temporary files for other destinations are untouched.
 */
export async function removeStaleOutputArtifacts(outputPath: string): Promise<readonly string[]> {
  const directory = dirname(outputPath);
  const prefix = `.${basename(outputPath)}.`;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    if (!entry.name.endsWith(".tmp") && !entry.name.endsWith(".tmp.raw")) continue;
    const suffix = entry.name.slice(prefix.length);
    const pidText = suffix.split(".", 1)[0];
    const pid = /^\d+$/.test(pidText) ? Number(pidText) : undefined;
    const path = join(directory, entry.name);
    const stale = pid === undefined
      ? Date.now() - (await stat(path)).mtimeMs >= legacyStaleAgeMs
      : !processIsAlive(pid);
    if (!stale) continue;
    await rm(path, { force: true });
    removed.push(path);
  }
  return removed.sort();
}

export function assertWithinTestWriteLimit(limit: number | undefined, nextSize: number): void {
  if (limit === undefined || nextSize <= limit) return;
  const error = new Error("Injected disk-space exhaustion while writing an acceptance artifact.") as NodeJS.ErrnoException;
  error.code = "ENOSPC";
  throw error;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !hasCode(error, "ESRCH");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}
