import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { Raster } from "../core/raster.ts";
import type { DecodedSourceSummary } from "../shared/processing-contracts.ts";

// v4 persists an exact camera/ISO photon-transfer match so cache hits use the
// same low-signal density regularization as a fresh RAW decode.
const cacheFormatVersion = "filmlab-linear-preview-v4";
const maximumCacheEntries = 64;
const maximumCacheBytes = 512 * 1024 * 1024;

export interface DecodedPreviewCacheEntry {
  readonly key: string;
  readonly metadataPath: string;
  readonly pixelsPath: string;
  readonly previewMaxEdge: number;
}

export interface CachedDecodedPreview {
  readonly source: Raster;
  readonly summary: Omit<DecodedSourceSummary, "assetId">;
}

export interface CachedBayerPreview {
  readonly width: number;
  readonly height: number;
  readonly data: Uint16Array;
  readonly pattern: readonly [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2];
  readonly summary: Omit<DecodedSourceSummary, "assetId">;
}

interface CacheMetadata {
  readonly format: typeof cacheFormatVersion;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly previewMaxEdge: number;
  readonly sourceDomain:
    | "camera-linear-rgb"
    | "camera-linear-bayer"
    | "transmission-linear-rgb";
  readonly bitDepth: 16;
  readonly decoder: "sharp-raster" | "libraw-sidecar";
  readonly decoderFingerprint?: string;
  readonly camera?: DecodedSourceSummary["camera"];
  readonly photonTransfer?: DecodedSourceSummary["photonTransfer"];
  readonly bayerPattern?: readonly [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2];
  readonly warnings: readonly string[];
}

export async function readDecodedBayerCache(
  entry: DecodedPreviewCacheEntry,
): Promise<CachedBayerPreview | undefined> {
  try {
    const [metadataBytes, pixelBytes] = await Promise.all([
      readFile(entry.metadataPath),
      readFile(entry.pixelsPath),
    ]);
    const metadata = parseMetadata(JSON.parse(metadataBytes.toString("utf8")), entry.previewMaxEdge);
    if (
      metadata.sourceDomain !== "camera-linear-bayer"
      || metadata.bayerPattern === undefined
      || pixelBytes.byteLength !== metadata.byteLength
    ) {
      return undefined;
    }
    const data = new Uint16Array(metadata.width * metadata.height);
    const values = new DataView(pixelBytes.buffer, pixelBytes.byteOffset, pixelBytes.byteLength);
    for (let index = 0; index < data.length; index += 1) {
      data[index] = values.getUint16(index * 2, true);
    }
    touchEntry(entry);
    return {
      width: metadata.width,
      height: metadata.height,
      data,
      pattern: metadata.bayerPattern,
      summary: {
        width: metadata.width,
        height: metadata.height,
        bitDepth: 16,
        sourceDomain: "camera-linear-bayer",
        decoder: metadata.decoder,
        decoderFingerprint: metadata.decoderFingerprint,
        camera: metadata.camera,
        photonTransfer: metadata.photonTransfer,
        warnings: metadata.warnings,
      },
    };
  } catch {
    return undefined;
  }
}

export async function createDecodedPreviewCacheEntry(
  cacheDirectory: string,
  sourcePath: string,
  previewMaxEdge: number,
  decoderIdentity: string,
): Promise<DecodedPreviewCacheEntry> {
  const source = await stat(sourcePath);
  const key = createHash("sha256")
    .update(cacheFormatVersion)
    .update("\0")
    .update(sourcePath)
    .update("\0")
    .update(String(source.size))
    .update("\0")
    .update(String(source.mtimeMs))
    .update("\0")
    .update(String(previewMaxEdge))
    .update("\0")
    .update(decoderIdentity)
    .digest("hex");
  return {
    key,
    metadataPath: join(cacheDirectory, key + ".json"),
    pixelsPath: join(cacheDirectory, key + ".rgb16le"),
    previewMaxEdge,
  };
}

export async function readDecodedPreviewCache(
  entry: DecodedPreviewCacheEntry,
): Promise<CachedDecodedPreview | undefined> {
  try {
    const [metadataBytes, pixelBytes] = await Promise.all([
      readFile(entry.metadataPath),
      readFile(entry.pixelsPath),
    ]);
    const metadata = parseMetadata(JSON.parse(metadataBytes.toString("utf8")), entry.previewMaxEdge);
    if (
      metadata.sourceDomain === "camera-linear-bayer"
      || pixelBytes.byteLength !== metadata.byteLength
    ) {
      return undefined;
    }
    const source = rgb16BufferToRaster(
      pixelBytes,
      metadata.width,
      metadata.height,
      metadata.sourceDomain,
    );
    touchEntry(entry);
    return {
      source,
      summary: {
        width: metadata.width,
        height: metadata.height,
        bitDepth: metadata.bitDepth,
        sourceDomain: metadata.sourceDomain,
        decoder: metadata.decoder,
        decoderFingerprint: metadata.decoderFingerprint,
        camera: metadata.camera,
        photonTransfer: metadata.photonTransfer,
        warnings: metadata.warnings,
      },
    };
  } catch {
    return undefined;
  }
}

export async function writeDecodedPreviewCache(
  cacheDirectory: string,
  entry: DecodedPreviewCacheEntry,
  decoded: CachedDecodedPreview,
  encodedPixels?: Uint8Array,
): Promise<void> {
  await mkdir(cacheDirectory, { recursive: true });
  const pixels = encodedPixels ?? rasterToRgb16Buffer(decoded.source);
  if (pixels.byteLength !== decoded.source.width * decoded.source.height * 3 * 2) {
    throw new Error("Decoded preview cache pixel length is invalid.");
  }
  await writeFile(entry.pixelsPath, pixels);
  await writeDecodedPreviewCacheMetadata(cacheDirectory, entry, decoded, pixels.byteLength);
}

export async function writeDecodedPreviewCacheMetadata(
  cacheDirectory: string,
  entry: DecodedPreviewCacheEntry,
  decoded: CachedDecodedPreview,
  byteLength = decoded.source.width * decoded.source.height * 3 * 2,
): Promise<void> {
  await mkdir(cacheDirectory, { recursive: true });
  const metadata: CacheMetadata = {
    format: cacheFormatVersion,
    width: decoded.source.width,
    height: decoded.source.height,
    byteLength,
    previewMaxEdge: entry.previewMaxEdge,
    sourceDomain: decoded.source.domain as CacheMetadata["sourceDomain"],
    bitDepth: 16,
    decoder: decoded.summary.decoder,
    decoderFingerprint: decoded.summary.decoderFingerprint,
    camera: decoded.summary.camera,
    photonTransfer: decoded.summary.photonTransfer,
    warnings: decoded.summary.warnings,
  };
  await publishMetadata(cacheDirectory, entry, metadata);
}

export async function writeDecodedBayerCacheMetadata(
  cacheDirectory: string,
  entry: DecodedPreviewCacheEntry,
  decoded: CachedBayerPreview,
): Promise<void> {
  await mkdir(cacheDirectory, { recursive: true });
  const metadata: CacheMetadata = {
    format: cacheFormatVersion,
    width: decoded.width,
    height: decoded.height,
    byteLength: decoded.data.byteLength,
    previewMaxEdge: entry.previewMaxEdge,
    sourceDomain: "camera-linear-bayer",
    bitDepth: 16,
    decoder: decoded.summary.decoder,
    decoderFingerprint: decoded.summary.decoderFingerprint,
    camera: decoded.summary.camera,
    photonTransfer: decoded.summary.photonTransfer,
    bayerPattern: decoded.pattern,
    warnings: decoded.summary.warnings,
  };
  await publishMetadata(cacheDirectory, entry, metadata);
}

async function publishMetadata(
  cacheDirectory: string,
  entry: DecodedPreviewCacheEntry,
  metadata: CacheMetadata,
): Promise<void> {
  const temporaryMetadataPath = entry.metadataPath + ".tmp-" + randomUUID();
  // Metadata is published last, so a partial pixel write is never accepted as
  // a valid cache hit. Concurrent workers write identical content for a key.
  await writeFile(temporaryMetadataPath, JSON.stringify(metadata), "utf8");
  await rm(entry.metadataPath, { force: true });
  await rename(temporaryMetadataPath, entry.metadataPath);
  void pruneDecodedPreviewCache(cacheDirectory, entry.key).catch(() => undefined);
}

function touchEntry(entry: DecodedPreviewCacheEntry): void {
  const now = new Date();
  void Promise.all([
    utimes(entry.metadataPath, now, now),
    utimes(entry.pixelsPath, now, now),
  ]).catch(() => undefined);
}

async function pruneDecodedPreviewCache(cacheDirectory: string, keepKey: string): Promise<void> {
  const names = (await readdir(cacheDirectory))
    .filter((name) => name.endsWith(".json"));
  const records = await Promise.all(names.map(async (name) => {
    const path = join(cacheDirectory, name);
    const details = await stat(path);
    let byteLength = 0;
    try {
      const parsed = JSON.parse((await readFile(path)).toString("utf8")) as { readonly byteLength?: unknown };
      byteLength = typeof parsed.byteLength === "number" && Number.isFinite(parsed.byteLength)
        ? parsed.byteLength
        : 0;
    } catch {
      // Invalid metadata is treated as the oldest removable entry.
    }
    return {
      key: name.slice(0, -".json".length),
      modified: details.mtimeMs,
      byteLength,
    };
  }));
  records.sort((left, right) => right.modified - left.modified);
  let retainedBytes = 0;
  let retainedEntries = 0;
  for (const record of records) {
    const keep = record.key === keepKey
      || (
        retainedEntries < maximumCacheEntries
        && retainedBytes + record.byteLength <= maximumCacheBytes
      );
    if (keep) {
      retainedEntries += 1;
      retainedBytes += record.byteLength;
      continue;
    }
    await Promise.all([
      rm(join(cacheDirectory, record.key + ".json"), { force: true }),
      rm(join(cacheDirectory, record.key + ".rgb16le"), { force: true }),
    ]);
  }
}

function parseMetadata(value: unknown, expectedMaxEdge: number): CacheMetadata {
  if (typeof value !== "object" || value === null) throw new Error("Invalid preview cache metadata.");
  const record = value as Record<string, unknown>;
  const width = record.width;
  const height = record.height;
  const byteLength = record.byteLength;
  const sourceDomain = record.sourceDomain;
  const decoder = record.decoder;
  const bayerPattern = record.bayerPattern;
  const warnings = record.warnings;
  if (
    record.format !== cacheFormatVersion
    || record.previewMaxEdge !== expectedMaxEdge
    || !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || (width as number) <= 0
    || (height as number) <= 0
    || !Number.isSafeInteger(byteLength)
    || byteLength !== (width as number) * (height as number)
      * (sourceDomain === "camera-linear-bayer" ? 1 : 3) * 2
    || !["camera-linear-rgb", "camera-linear-bayer", "transmission-linear-rgb"].includes(sourceDomain as string)
    || !["sharp-raster", "libraw-sidecar"].includes(decoder as string)
    || !Array.isArray(warnings)
    || !warnings.every((warning) => typeof warning === "string")
    || (
      sourceDomain === "camera-linear-bayer"
      && (
        !Array.isArray(bayerPattern)
        || bayerPattern.length !== 4
        || !bayerPattern.every((channel) => channel === 0 || channel === 1 || channel === 2)
      )
    )
  ) {
    throw new Error("Invalid preview cache metadata.");
  }
  return {
    format: cacheFormatVersion,
    width: width as number,
    height: height as number,
    byteLength: byteLength as number,
    previewMaxEdge: expectedMaxEdge,
    sourceDomain: sourceDomain as CacheMetadata["sourceDomain"],
    bitDepth: 16,
    decoder: decoder as CacheMetadata["decoder"],
    decoderFingerprint: typeof record.decoderFingerprint === "string"
      ? record.decoderFingerprint
      : undefined,
    camera: parseCachedCamera(record.camera),
    photonTransfer: parseCachedPhotonTransfer(record.photonTransfer),
    bayerPattern: sourceDomain === "camera-linear-bayer"
      ? bayerPattern as CacheMetadata["bayerPattern"]
      : undefined,
    warnings: warnings as readonly string[],
  };
}

function parseCachedCamera(value: unknown): DecodedSourceSummary["camera"] {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid cached camera metadata.");
  }
  const record = value as Record<string, unknown>;
  const make = parseCachedCameraField(record.make);
  const model = parseCachedCameraField(record.model);
  if (make === undefined && model === undefined) throw new Error("Invalid cached camera metadata.");
  return { make, model };
}

function parseCachedPhotonTransfer(value: unknown): DecodedSourceSummary["photonTransfer"] {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid cached photon-transfer metadata.");
  }
  const record = value as Record<string, unknown>;
  const ranges = record.normalizationRangeDn;
  if (
    typeof record.profileId !== "string" || record.profileId.length === 0 || record.profileId.length > 256
    || typeof record.cameraModel !== "string" || record.cameraModel.length === 0 || record.cameraModel.length > 128
    || ![record.iso, record.bitDepth, record.readNoiseDn, record.electronsPerDn, record.prnu]
      .every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)
    || (record.electronsPerDn as number) <= 0
    || !Array.isArray(ranges) || ranges.length !== 3
    || !ranges.every((item) => typeof item === "number" && Number.isFinite(item) && item > 0)
  ) {
    throw new Error("Invalid cached photon-transfer metadata.");
  }
  return {
    profileId: record.profileId,
    cameraModel: record.cameraModel,
    iso: record.iso as number,
    bitDepth: record.bitDepth as number,
    readNoiseDn: record.readNoiseDn as number,
    electronsPerDn: record.electronsPerDn as number,
    prnu: record.prnu as number,
    normalizationRangeDn: ranges as unknown as readonly [number, number, number],
  };
}

function parseCachedCameraField(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new Error("Invalid cached camera metadata.");
  }
  return value;
}

function rasterToRgb16Buffer(source: Raster): Uint8Array {
  source.assertDomain(["camera-linear-rgb", "transmission-linear-rgb"]);
  const values = new Uint16Array(source.data.length);
  for (let index = 0; index < source.data.length; index += 1) {
    values[index] = Math.round(Math.max(0, Math.min(1, source.data[index])) * 65_535);
  }
  return new Uint8Array(values.buffer);
}

function rgb16BufferToRaster(
  buffer: Uint8Array,
  width: number,
  height: number,
  domain: "camera-linear-rgb" | "transmission-linear-rgb",
): Raster {
  const values = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pixels = new Float32Array(width * height * 3);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = values.getUint16(index * 2, true) / 65_535;
  }
  return new Raster(width, height, domain, pixels);
}
