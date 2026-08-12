import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

import sharp from "sharp";

import type { MasterExportFormat } from "../shared/contracts.ts";

export interface MasterArtifactExpectation {
  readonly width: number;
  readonly height: number;
  readonly xmpIncludes?: readonly string[];
}

export interface MasterArtifactValidation {
  readonly format: MasterExportFormat;
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly byteLength: number;
  readonly hasIcc: boolean;
  readonly hasXmp: boolean;
  readonly dngTags?: readonly number[];
  readonly decoder: "sharp-libvips" | "filmlab-tiff-parser";
}

/** Re-open a published master independently of FilmLab's writer path. */
export async function validateMasterArtifact(
  path: string,
  format: MasterExportFormat,
  expectation: MasterArtifactExpectation,
): Promise<MasterArtifactValidation> {
  const byteLength = (await stat(path)).size;
  if (byteLength <= 0) throw new Error(`Master is empty: ${path}`);
  if (format === "tiff" || format === "dng") {
    return validateTiffFamily(await readFile(path), byteLength, format, expectation);
  }
  const metadata = await sharp(path, { failOn: "error", limitInputPixels: false }).metadata();
  const expectedContainer = format === "jpeg" ? "jpeg" : "heif";
  if (metadata.format !== expectedContainer) {
    throw new Error(`Expected ${expectedContainer}, decoded ${String(metadata.format)} (${extname(path)}).`);
  }
  assertDimensions(metadata.width, metadata.height, expectation);
  const xmp = metadata.xmpAsString ?? "";
  assertXmp(xmp, expectation.xmpIncludes);
  if (!metadata.hasProfile || metadata.icc === undefined || metadata.icc.length === 0) {
    throw new Error(`${format.toUpperCase()} master has no embedded ICC profile.`);
  }
  const bitDepth = format === "heif" ? metadata.bitsPerSample ?? 0 : 8;
  if (format === "heif" && bitDepth !== 10) throw new Error(`HEIF bit depth is ${bitDepth}, expected 10.`);
  return {
    format,
    width: metadata.width!,
    height: metadata.height!,
    bitDepth,
    byteLength,
    hasIcc: true,
    hasXmp: xmp.length > 0,
    decoder: "sharp-libvips",
  };
}

function validateTiffFamily(
  bytes: Buffer,
  byteLength: number,
  format: "tiff" | "dng",
  expectation: MasterArtifactExpectation,
): MasterArtifactValidation {
  const tags = readClassicTiffTags(bytes);
  const width = scalarTag(bytes, tags.get(256));
  const height = scalarTag(bytes, tags.get(257));
  assertDimensions(width, height, expectation);
  const bits = scalarTag(bytes, tags.get(258));
  if (bits !== 16) throw new Error(`${format.toUpperCase()} bit depth is ${bits}, expected 16.`);
  const xmp = tagBytes(bytes, tags.get(700)).toString("utf8").replace(/\0+$/g, "");
  assertXmp(xmp, expectation.xmpIncludes);
  const hasIcc = tags.has(34675) && tagBytes(bytes, tags.get(34675)).length > 0;
  if (format === "tiff" && !hasIcc) throw new Error("TIFF master has no embedded ICC profile.");
  const dngRequired = [50706, 50707, 50708, 50721];
  if (format === "dng") {
    for (const tag of dngRequired) {
      if (!tags.has(tag)) throw new Error(`DNG master is missing required tag ${tag}.`);
    }
    if (scalarTag(bytes, tags.get(262)) !== 34_892) {
      throw new Error("DNG PhotometricInterpretation is not LinearRaw.");
    }
  }
  return {
    format,
    width,
    height,
    bitDepth: bits,
    byteLength,
    hasIcc,
    hasXmp: xmp.length > 0,
    ...(format === "dng" ? { dngTags: dngRequired } : {}),
    decoder: "filmlab-tiff-parser",
  };
}

interface TiffTag {
  readonly type: number;
  readonly count: number;
  readonly valueOffset: number;
  readonly inlineOffset: number;
}

function readClassicTiffTags(bytes: Buffer): ReadonlyMap<number, TiffTag> {
  if (bytes.length < 8 || bytes.toString("ascii", 0, 2) !== "II" || bytes.readUInt16LE(2) !== 42) {
    throw new Error("Expected a little-endian classic TIFF/DNG container.");
  }
  const ifdOffset = bytes.readUInt32LE(4);
  const count = bytes.readUInt16LE(ifdOffset);
  const tags = new Map<number, TiffTag>();
  for (let index = 0; index < count; index += 1) {
    const offset = ifdOffset + 2 + index * 12;
    if (offset + 12 > bytes.length) throw new Error("TIFF IFD extends beyond the file.");
    tags.set(bytes.readUInt16LE(offset), {
      type: bytes.readUInt16LE(offset + 2),
      count: bytes.readUInt32LE(offset + 4),
      valueOffset: bytes.readUInt32LE(offset + 8),
      inlineOffset: offset + 8,
    });
  }
  return tags;
}

function scalarTag(bytes: Buffer, tag: TiffTag | undefined): number {
  if (tag === undefined || tag.count < 1) throw new Error("Required scalar TIFF tag is missing.");
  const offset = tagBytesOffset(tag);
  if (offset < 0 || offset + typeSize(tag.type) > bytes.length) throw new Error("TIFF scalar tag is out of range.");
  if (tag.type === 3) return bytes.readUInt16LE(offset);
  if (tag.type === 4) return bytes.readUInt32LE(offset);
  throw new Error(`Unsupported scalar TIFF type ${tag.type}.`);
}

function tagBytes(bytes: Buffer, tag: TiffTag | undefined): Buffer {
  if (tag === undefined) return Buffer.alloc(0);
  const length = typeSize(tag.type) * tag.count;
  const offset = length <= 4 ? tag.inlineOffset : tag.valueOffset;
  if (offset < 0 || offset + length > bytes.length) throw new Error("TIFF tag payload is out of range.");
  return bytes.subarray(offset, offset + length);
}

function tagBytesOffset(tag: TiffTag): number {
  return typeSize(tag.type) * tag.count <= 4 ? tag.inlineOffset : tag.valueOffset;
}

function typeSize(type: number): number {
  if (type === 1 || type === 2 || type === 7) return 1;
  if (type === 3) return 2;
  if (type === 4 || type === 9 || type === 11) return 4;
  if (type === 5 || type === 10 || type === 12) return 8;
  throw new Error(`Unsupported TIFF field type ${type}.`);
}

function assertDimensions(
  width: number | undefined,
  height: number | undefined,
  expectation: MasterArtifactExpectation,
): void {
  if (width !== expectation.width || height !== expectation.height) {
    throw new Error(`Master dimensions ${String(width)}x${String(height)} do not match ${expectation.width}x${expectation.height}.`);
  }
}

function assertXmp(xmp: string, required: readonly string[] | undefined): void {
  if (xmp.length === 0) throw new Error("Master has no XMP packet.");
  for (const value of required ?? []) {
    if (!xmp.includes(value)) throw new Error(`Master XMP does not contain ${JSON.stringify(value)}.`);
  }
}
