import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import type { ProjectRelinkResult, SourceAsset } from "../shared/contracts.ts";
import type { SourceIdentity } from "../shared/project.ts";

const fingerprintReadSize = 4 * 1024 * 1024;
const maximumScannedFiles = 20_000;
const maximumLocationRecords = 5_000;
const supportedExtensions = new Set([
  "DNG", "NEF", "CR2", "CR3", "ARW", "RAF", "RW2", "ORF", "IIQ", "PEF", "SRW", "TIF", "TIFF",
]);

interface SourceLocationRecord {
  readonly fingerprint: string;
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly lastModifiedAt: string;
  readonly lastSeenAt: string;
}

interface Candidate {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly lastModifiedAt: string;
}

/**
 * Main-process mapping between renderer-safe identities and filesystem paths.
 * Project documents never contain absolute paths. A separate machine-private
 * location index permits restart-time relinking without leaking paths when a
 * project directory is copied to another computer.
 */
export class SourceRegistry {
  private readonly paths = new Map<string, string>();
  private readonly locationIndexPath: string | undefined;

  public constructor(locationIndexPath?: string) {
    this.locationIndexPath = locationIndexPath;
  }

  public async register(filePaths: readonly string[]): Promise<readonly SourceAsset[]> {
    const assets: SourceAsset[] = [];
    const locations = await this.readLocations();
    for (const filePath of filePaths) {
      const identity = await describeSource(filePath);
      const asset: SourceAsset = {
        id: randomUUID(),
        name: basename(filePath),
        extension: sourceExtension(filePath),
        identity,
      };
      this.paths.set(asset.id, filePath);
      assets.push(asset);
      upsertLocation(locations, filePath, identity);
    }
    await this.writeLocations(locations);
    return assets;
  }

  public getPath(assetId: string): string | undefined {
    return this.paths.get(assetId);
  }

  public has(assetId: string): boolean {
    return this.paths.has(assetId);
  }

  public forget(assetId: string): void {
    this.paths.delete(assetId);
  }

  /** Validates previously seen machine-local paths against project identities. */
  public async restore(assets: readonly SourceAsset[]): Promise<ProjectRelinkResult> {
    const locations = await this.readLocations();
    const relinkedAssetIds: string[] = [];
    const relinkedAssets: SourceAsset[] = [];
    const missingAssets: SourceAsset[] = [];
    let changed = false;

    for (const asset of assets) {
      if (asset.identity === undefined) {
        missingAssets.push(asset);
        continue;
      }
      const matches = locations
        .filter((entry) => entry.fingerprint === asset.identity?.fingerprint.value)
        .sort((left, right) => Number(right.name === asset.name) - Number(left.name === asset.name));
      let restoredPath: string | undefined;
      for (const entry of matches) {
        if (await pathMatchesIdentity(entry.path, asset.identity)) {
          restoredPath = entry.path;
          upsertLocation(locations, entry.path, asset.identity);
          changed = true;
          break;
        }
      }
      if (restoredPath === undefined) {
        missingAssets.push(asset);
        continue;
      }
      this.paths.set(asset.id, restoredPath);
      relinkedAssetIds.push(asset.id);
      relinkedAssets.push(asset);
    }
    if (changed) await this.writeLocations(locations);
    return { relinkedAssetIds, relinkedAssets, missingAssets };
  }

  /** Scans selected roots recursively and matches by content identity. */
  public async relinkDirectories(
    assets: readonly SourceAsset[],
    directories: readonly string[],
  ): Promise<ProjectRelinkResult> {
    const filePaths = await collectCandidateFiles(directories);
    return this.relink(assets, filePaths);
  }

  /**
   * Matches durable projects by size + content fingerprint. Legacy projects
   * without identities fall back to filename once, then receive an identity.
   */
  public async relink(
    assets: readonly SourceAsset[],
    filePaths: readonly string[],
  ): Promise<ProjectRelinkResult> {
    const candidates = (await Promise.all(filePaths.map(createCandidate)))
      .filter((candidate): candidate is Candidate => candidate !== undefined);
    const fingerprintCache = new Map<string, Promise<SourceIdentity>>();
    const usedPaths = new Set<string>();
    const locations = await this.readLocations();
    const relinkedAssetIds: string[] = [];
    const relinkedAssets: SourceAsset[] = [];
    const missingAssets: SourceAsset[] = [];

    for (const asset of assets) {
      const possible = asset.identity === undefined
        ? candidates.filter((candidate) => candidate.name.toLocaleLowerCase() === asset.name.toLocaleLowerCase())
        : candidates
          .filter((candidate) => candidate.size === asset.identity?.size)
          .sort((left, right) => Number(right.name === asset.name) - Number(left.name === asset.name));
      let match: { readonly candidate: Candidate; readonly identity: SourceIdentity } | undefined;
      for (const candidate of possible) {
        if (usedPaths.has(candidate.path)) continue;
        const identityPromise = fingerprintCache.get(candidate.path) ?? describeSource(candidate.path);
        fingerprintCache.set(candidate.path, identityPromise);
        const identity = await identityPromise;
        if (
          asset.identity === undefined
          || identity.fingerprint.value === asset.identity.fingerprint.value
        ) {
          match = { candidate, identity };
          break;
        }
      }
      if (match === undefined) {
        missingAssets.push(asset);
        continue;
      }
      const relinkedAsset: SourceAsset = { ...asset, identity: match.identity };
      usedPaths.add(match.candidate.path);
      this.paths.set(asset.id, match.candidate.path);
      upsertLocation(locations, match.candidate.path, match.identity);
      relinkedAssetIds.push(asset.id);
      relinkedAssets.push(relinkedAsset);
    }
    await this.writeLocations(locations);
    return { relinkedAssetIds, relinkedAssets, missingAssets };
  }

  private async readLocations(): Promise<SourceLocationRecord[]> {
    if (this.locationIndexPath === undefined) return [];
    try {
      const value = JSON.parse(await readFile(this.locationIndexPath, "utf8")) as unknown;
      if (!Array.isArray(value)) return [];
      return value.flatMap((item) => parseLocation(item));
    } catch {
      return [];
    }
  }

  private async writeLocations(locations: SourceLocationRecord[]): Promise<void> {
    if (this.locationIndexPath === undefined) return;
    const retained = [...locations]
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, maximumLocationRecords);
    await mkdir(dirname(this.locationIndexPath), { recursive: true });
    const temporaryPath = this.locationIndexPath + ".tmp-" + randomUUID();
    try {
      await writeFile(temporaryPath, JSON.stringify(retained, null, 2), "utf8");
      await rename(temporaryPath, this.locationIndexPath);
    } catch (error: unknown) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export async function describeSource(filePath: string): Promise<SourceIdentity> {
  const details = await stat(filePath);
  if (!details.isFile() || !Number.isSafeInteger(details.size) || details.size < 0) {
    throw new Error("源文件不是可读取的普通文件。");
  }
  const handle = await open(filePath, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(fingerprintReadSize, Math.max(1, details.size)));
    let position = 0;
    while (position < details.size) {
      const requested = Math.min(buffer.length, details.size - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead <= 0) throw new Error("读取源文件内容指纹时提前到达文件末尾。");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== details.size || after.mtimeMs !== details.mtimeMs) {
      throw new Error("源文件在导入期间发生变化，请在写入完成后重试。");
    }
    return {
      size: details.size,
      lastModifiedAt: details.mtime.toISOString(),
      fingerprint: { algorithm: "sha256-full-v1", value: hash.digest("hex") },
    };
  } finally {
    await handle.close();
  }
}

async function pathMatchesIdentity(filePath: string, identity: SourceIdentity): Promise<boolean> {
  try {
    const details = await stat(filePath);
    if (!details.isFile() || details.size !== identity.size) return false;
    if (details.mtime.toISOString() === identity.lastModifiedAt) return true;
    return (await describeSource(filePath)).fingerprint.value === identity.fingerprint.value;
  } catch {
    return false;
  }
}

async function createCandidate(filePath: string): Promise<Candidate | undefined> {
  try {
    const details = await stat(filePath);
    if (!details.isFile()) return undefined;
    return {
      path: filePath,
      name: basename(filePath),
      size: details.size,
      lastModifiedAt: details.mtime.toISOString(),
    };
  } catch {
    return undefined;
  }
}

async function collectCandidateFiles(directories: readonly string[]): Promise<readonly string[]> {
  const files: string[] = [];
  const pending = [...directories];
  while (pending.length > 0) {
    const directory = pending.shift();
    if (directory === undefined) break;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= maximumScannedFiles) {
        throw new Error("所选目录中的候选源文件过多，请选择更具体的目录。");
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && supportedExtensions.has(sourceExtension(path))) files.push(path);
    }
  }
  return files;
}

function sourceExtension(filePath: string): string {
  return extname(filePath).replace(".", "").toUpperCase() || "FILE";
}

function upsertLocation(
  locations: SourceLocationRecord[],
  filePath: string,
  identity: SourceIdentity,
): void {
  const existingIndex = locations.findIndex((entry) => entry.path === filePath);
  const record: SourceLocationRecord = {
    fingerprint: identity.fingerprint.value,
    path: filePath,
    name: basename(filePath),
    size: identity.size,
    lastModifiedAt: identity.lastModifiedAt,
    lastSeenAt: new Date().toISOString(),
  };
  if (existingIndex < 0) locations.push(record);
  else locations[existingIndex] = record;
}

function parseLocation(value: unknown): readonly SourceLocationRecord[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (
    typeof record.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(record.fingerprint)
    || typeof record.path !== "string" || record.path.length === 0
    || typeof record.name !== "string" || record.name.length === 0
    || typeof record.size !== "number" || !Number.isSafeInteger(record.size) || record.size < 0
    || typeof record.lastModifiedAt !== "string" || Number.isNaN(Date.parse(record.lastModifiedAt))
    || typeof record.lastSeenAt !== "string" || Number.isNaN(Date.parse(record.lastSeenAt))
  ) return [];
  return [record as unknown as SourceLocationRecord];
}
