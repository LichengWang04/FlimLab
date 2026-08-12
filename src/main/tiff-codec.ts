import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { deflate } from "node:zlib";

import sharp from "sharp";

/**
 * RGB samples produced by FilmLab's tone stage. Values are linear-light,
 * relative sRGB primaries and are deliberately not yet gamma encoded.
 */
export interface DisplayLinearTiffSource {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

export interface Srgb16TiffSource {
  readonly width: number;
  readonly height: number;
  readonly data: Uint16Array;
}

export interface DisplayLinearTiffOptions extends DisplayLinearTiffSource {
  /** Absolute destination selected by the main process. */
  readonly outputPath: string;
  /** Optional complete XMP packet. A deterministic FilmLab packet is used by default. */
  readonly xmp?: string;
  /** TIFF resolution metadata. Defaults to 300 DPI. */
  readonly densityDpi?: number;
  /** Force BigTIFF. When omitted, it is selected near the classic TIFF limit. */
  readonly bigtiff?: boolean;
  /** Extra provenance included in the default XMP packet. */
  readonly processingMetadata?: Readonly<Record<string, string | number | boolean>>;
}

export type DisplayLinearTiffBufferOptions = Omit<DisplayLinearTiffOptions, "outputPath">;
export type Srgb16TiffOptions = Omit<DisplayLinearTiffOptions, "data"> & Srgb16TiffSource;
export type Srgb16TiffBufferOptions = Omit<Srgb16TiffOptions, "outputPath">;

export interface DisplayLinearTiffWriteResult {
  readonly outputPath: string;
  readonly byteLength: number;
  readonly bitDepth: 16;
  readonly colorSpace: "sRGB";
  readonly hasEmbeddedIcc: true;
}

const SRGB_LINEAR_THRESHOLD = 0.0031308;
const CLASSIC_TIFF_SOFT_LIMIT = 3_500_000_000;
const deflateAsync = promisify(deflate);

let sRgbProfilePromise: Promise<Buffer> | undefined;

/**
 * Convert display-linear RGB to gamma-encoded 16-bit sRGB samples.
 *
 * The conversion happens before TIFF encoding so that the embedded sRGB ICC
 * profile accurately describes the stored samples. Values outside the display
 * range are clipped at this final delivery boundary only.
 */
export function displayLinearToSrgb16(data: Float32Array): Uint16Array {
  const output = new Uint16Array(data.length);

  for (let index = 0; index < data.length; index += 1) {
    const linear = normalizeDisplaySample(data[index]);
    const encoded = linear <= SRGB_LINEAR_THRESHOLD
      ? 12.92 * linear
      : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
    output[index] = Math.round(clamp(encoded, 0, 1) * 65_535);
  }

  return output;
}

/** Preserve display-linear values for a LinearRaw DNG IFD. */
export function displayLinearToLinear16(data: Float32Array): Uint16Array {
  const output = new Uint16Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    output[index] = Math.round(normalizeDisplaySample(data[index]) * 65_535);
  }
  return output;
}

/**
 * Encode a 16-bit, losslessly compressed TIFF with embedded sRGB ICC and XMP.
 * This function has no filesystem side effects and is suitable for a utility
 * process that owns the full-resolution raster.
 */
export async function encodeDisplayLinearTiff(
  options: DisplayLinearTiffBufferOptions,
): Promise<Buffer> {
  assertDisplayLinearSource(options);
  const encodedPixels = displayLinearToSrgb16(options.data);
  return encodeSrgb16Tiff({ ...options, data: encodedPixels });
}

/**
 * Encode GPU-quantized 16-bit sRGB samples without another full-raster
 * transfer-function pass on the CPU.
 */
export async function encodeSrgb16Tiff(
  options: Srgb16TiffBufferOptions,
): Promise<Buffer> {
  assertSrgb16Source(options);
  const densityDpi = options.densityDpi ?? 300;
  assertDensity(densityDpi);

  const encodedPixels = options.data;
  const estimatedUncompressedBytes = encodedPixels.byteLength;
  const bigtiff = options.bigtiff ?? estimatedUncompressedBytes >= CLASSIC_TIFF_SOFT_LIMIT;

  // Sharp preserves the Uint16 source samples when the output is explicitly
  // rgb16. Do not call withMetadata()/withIccProfile() here: libvips would
  // colour-transform an untagged RGB16 raster. We attach the ICC/XMP tags
  // below without changing the gamma-encoded samples.
  const tiff = await sharp(encodedPixels, {
    raw: {
      width: options.width,
      height: options.height,
      channels: 3,
    },
    limitInputPixels: false,
  })
    .toColourspace("rgb16")
    .withDensity(densityDpi)
    .tiff({
      compression: "deflate",
      predictor: "horizontal",
      bigtiff,
    })
    .toBuffer();

  return injectTiffMetadata(tiff, {
    icc: await getSrgbIccProfile(),
    xmp: options.xmp ?? createDefaultXmp(options.processingMetadata),
  });
}

/**
 * Atomically write a 16-bit sRGB TIFF. The target is replaced only after the
 * complete encoded file has been written in the same directory.
 */
export async function writeDisplayLinearTiff(
  options: DisplayLinearTiffOptions,
): Promise<DisplayLinearTiffWriteResult> {
  if (options.outputPath.trim().length === 0) {
    throw new Error("A non-empty TIFF output path is required.");
  }

  const encoded = await encodeDisplayLinearTiff(options);
  const outputDirectory = dirname(options.outputPath);
  const temporaryPath = join(
    outputDirectory,
    "." + basename(options.outputPath) + "." + randomUUID() + ".tmp",
  );

  await mkdir(outputDirectory, { recursive: true });
  try {
    await writeFile(temporaryPath, encoded, { flag: "wx" });
    await rename(temporaryPath, options.outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }

  return {
    outputPath: options.outputPath,
    byteLength: encoded.byteLength,
    bitDepth: 16,
    colorSpace: "sRGB",
    hasEmbeddedIcc: true,
  };
}

export async function writeSrgb16Tiff(
  options: Srgb16TiffOptions,
): Promise<DisplayLinearTiffWriteResult> {
  if (options.outputPath.trim().length === 0) {
    throw new Error("A non-empty TIFF output path is required.");
  }
  const encoded = await encodeSrgb16Tiff(options);
  const outputDirectory = dirname(options.outputPath);
  const temporaryPath = join(
    outputDirectory,
    "." + basename(options.outputPath) + "." + randomUUID() + ".tmp",
  );
  await mkdir(outputDirectory, { recursive: true });
  try {
    await writeFile(temporaryPath, encoded, { flag: "wx" });
    await rename(temporaryPath, options.outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return {
    outputPath: options.outputPath,
    byteLength: encoded.byteLength,
    bitDepth: 16,
    colorSpace: "sRGB",
    hasEmbeddedIcc: true,
  };
}

export interface StreamingSrgb16TiffOptions {
  readonly outputPath: string;
  readonly width: number;
  readonly height: number;
  readonly rowsPerStrip: number;
  /** DNG stores display-linear samples in a LinearRaw IFD; TIFF stores sRGB. */
  readonly container?: "tiff" | "dng";
  readonly densityDpi?: number;
  readonly xmp?: string;
  readonly processingMetadata?: Readonly<Record<string, string | number | boolean>>;
}

// This product includes DNG technology under license by Adobe.

/**
 * Incremental classic-TIFF writer used by GPU export. Each GPU tile becomes a
 * deflated TIFF strip immediately, so neither renderer nor main process needs
 * to retain the full 16-bit raster.
 */
export class StreamingSrgb16TiffWriter {
  private readonly options: StreamingSrgb16TiffOptions;
  private readonly handle: FileHandle;
  private readonly temporaryPath: string;
  private readonly icc: Buffer;
  private readonly xmp: Buffer;
  private readonly stripOffsets: number[] = [];
  private readonly stripByteCounts: number[] = [];
  private position = 8;
  private nextOutputY = 0;
  private closed = false;

  private constructor(
    options: StreamingSrgb16TiffOptions,
    handle: FileHandle,
    temporaryPath: string,
    icc: Buffer,
    xmp: Buffer,
  ) {
    this.options = options;
    this.handle = handle;
    this.temporaryPath = temporaryPath;
    this.icc = icc;
    this.xmp = xmp;
  }

  public static async create(options: StreamingSrgb16TiffOptions): Promise<StreamingSrgb16TiffWriter> {
    assertTiffDimensions(options.width, options.height);
    if (!Number.isSafeInteger(options.rowsPerStrip) || options.rowsPerStrip <= 0) {
      throw new Error("TIFF rowsPerStrip must be a positive safe integer.");
    }
    if (options.outputPath.trim().length === 0) {
      throw new Error("A non-empty TIFF output path is required.");
    }
    const densityDpi = options.densityDpi ?? 300;
    assertDensity(densityDpi);
    const outputDirectory = dirname(options.outputPath);
    const temporaryPath = join(
      outputDirectory,
      "." + basename(options.outputPath) + "." + randomUUID() + ".tmp",
    );
    await mkdir(outputDirectory, { recursive: true });
    const handle = await open(temporaryPath, "wx");
    try {
      const header = Buffer.alloc(8);
      header.write("II", 0, 2, "ascii");
      header.writeUInt16LE(42, 2);
      header.writeUInt32LE(0, 4);
      await handle.write(header, 0, header.length, 0);
      return new StreamingSrgb16TiffWriter(
        { ...options, densityDpi },
        handle,
        temporaryPath,
        options.container === "dng" ? Buffer.alloc(0) : await getSrgbIccProfile(),
        Buffer.from(options.xmp ?? createDefaultXmp(
          options.processingMetadata,
          options.container === "dng"
            ? { colorSpace: "linear sRGB", transfer: "linear", bitDepth: 16 }
            : undefined,
        ), "utf8"),
      );
    } catch (error) {
      await handle.close();
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  public async appendStrip(outputY: number, height: number, data: Uint16Array): Promise<void> {
    this.assertOpen();
    if (
      outputY !== this.nextOutputY
      || !Number.isSafeInteger(height)
      || height <= 0
      || height > this.options.rowsPerStrip
      || outputY + height > this.options.height
      || data.length !== this.options.width * height * 3
    ) {
      throw new Error("GPU TIFF strips must be complete, ordered, and match the declared dimensions.");
    }
    const predicted = encodeHorizontalPredictor(data, this.options.width, height);
    const compressed = await deflateAsync(predicted);
    this.assertClassicOffset(this.position + compressed.length);
    await this.handle.write(compressed, 0, compressed.length, this.position);
    this.stripOffsets.push(this.position);
    this.stripByteCounts.push(compressed.length);
    this.position += compressed.length;
    this.nextOutputY += height;
  }

  public async finish(): Promise<DisplayLinearTiffWriteResult> {
    this.assertOpen();
    try {
      if (this.nextOutputY !== this.options.height) {
        throw new Error("Cannot finish TIFF before every image row has been appended.");
      }
      const bitsPerSample = Buffer.alloc(6);
      bitsPerSample.writeUInt16LE(16, 0);
      bitsPerSample.writeUInt16LE(16, 2);
      bitsPerSample.writeUInt16LE(16, 4);
      const resolution = createRational(this.options.densityDpi ?? 300);
      const extraValues: Buffer[] = [];
      const addExtra = (value: Buffer): number => {
        const index = extraValues.length;
        extraValues.push(value);
        return index;
      };
      const bitsPerSampleIndex = addExtra(bitsPerSample);
      const stripOffsetsIndex = addExtra(uint32ArrayBuffer(this.stripOffsets));
      const stripByteCountsIndex = addExtra(uint32ArrayBuffer(this.stripByteCounts));
      const xResolutionIndex = addExtra(resolution);
      const yResolutionIndex = addExtra(resolution);
      const xmpIndex = addExtra(this.xmp);
      const isDng = this.options.container === "dng";
      const iccIndex = isDng ? undefined : addExtra(this.icc);
      const dngCameraModelIndex = isDng
        ? addExtra(Buffer.from("FilmLab Linear Positive\0", "ascii"))
        : undefined;
      const dngColorMatrixIndex = isDng
        ? addExtra(signedRationalArrayBuffer([
            3.2404542, -1.5371385, -0.4985314,
            -0.969266, 1.8760108, 0.041556,
            0.0556434, -0.2040259, 1.0572252,
          ]))
        : undefined;
      const dngAsShotNeutralIndex = isDng
        ? addExtra(rationalArrayBuffer([1, 1, 1]))
        : undefined;
      const dngBlackLevelIndex = isDng ? addExtra(uint32ArrayBuffer([0, 0, 0])) : undefined;
      const dngWhiteLevelIndex = isDng ? addExtra(uint32ArrayBuffer([65_535, 65_535, 65_535])) : undefined;
      const dngCropOriginIndex = isDng ? addExtra(uint32ArrayBuffer([0, 0])) : undefined;
      const dngCropSizeIndex = isDng
        ? addExtra(uint32ArrayBuffer([this.options.width, this.options.height]))
        : undefined;
      const dngActiveAreaIndex = isDng
        ? addExtra(uint32ArrayBuffer([0, 0, this.options.height, this.options.width]))
        : undefined;
      const extraOffsets: number[] = [];
      for (const value of extraValues) {
        await this.alignPosition(2);
        extraOffsets.push(this.position);
        await this.handle.write(value, 0, value.length, this.position);
        this.position += value.length;
      }
      await this.alignPosition(2);
      const ifdOffset = this.position;
      const entries = [
        createTiffEntry(256, 4, 1, this.options.width),
        createTiffEntry(257, 4, 1, this.options.height),
        createTiffEntry(258, 3, 3, extraOffsets[bitsPerSampleIndex]),
        createTiffEntry(259, 3, 1, 8),
        createTiffEntry(262, 3, 1, isDng ? 34_892 : 2),
        createTiffEntry(274, 3, 1, 1),
        createTiffEntry(
          273,
          4,
          this.stripOffsets.length,
          this.stripOffsets.length === 1 ? this.stripOffsets[0] : extraOffsets[stripOffsetsIndex],
        ),
        createTiffEntry(277, 3, 1, 3),
        createTiffEntry(278, 4, 1, this.options.rowsPerStrip),
        createTiffEntry(
          279,
          4,
          this.stripByteCounts.length,
          this.stripByteCounts.length === 1 ? this.stripByteCounts[0] : extraOffsets[stripByteCountsIndex],
        ),
        createTiffEntry(282, 5, 1, extraOffsets[xResolutionIndex]),
        createTiffEntry(283, 5, 1, extraOffsets[yResolutionIndex]),
        createTiffEntry(284, 3, 1, 1),
        createTiffEntry(296, 3, 1, 2),
        createTiffEntry(317, 3, 1, 2),
        createTiffEntry(339, 3, 1, 1),
        createTiffEntry(700, 1, this.xmp.length, extraOffsets[xmpIndex]),
        ...(isDng ? [
          createTiffEntry(50706, 1, 4, inlineByteValue([1, 4, 0, 0])),
          createTiffEntry(50707, 1, 4, inlineByteValue([1, 4, 0, 0])),
          createTiffEntry(50708, 2, "FilmLab Linear Positive\0".length, extraOffsets[dngCameraModelIndex!]),
          createTiffEntry(50714, 4, 3, extraOffsets[dngBlackLevelIndex!]),
          createTiffEntry(50717, 4, 3, extraOffsets[dngWhiteLevelIndex!]),
          createTiffEntry(50719, 4, 2, extraOffsets[dngCropOriginIndex!]),
          createTiffEntry(50720, 4, 2, extraOffsets[dngCropSizeIndex!]),
          createTiffEntry(50721, 10, 9, extraOffsets[dngColorMatrixIndex!]),
          createTiffEntry(50728, 5, 3, extraOffsets[dngAsShotNeutralIndex!]),
          createTiffEntry(50778, 3, 1, 21),
          createTiffEntry(50829, 4, 4, extraOffsets[dngActiveAreaIndex!]),
        ] : [
          createTiffEntry(34675, 7, this.icc.length, extraOffsets[iccIndex!]),
        ]),
      ].sort((left, right) => left.readUInt16LE(0) - right.readUInt16LE(0));
      const ifd = Buffer.alloc(2 + entries.length * 12 + 4);
      ifd.writeUInt16LE(entries.length, 0);
      entries.forEach((entry, index) => entry.copy(ifd, 2 + index * 12));
      ifd.writeUInt32LE(0, ifd.length - 4);
      this.assertClassicOffset(ifdOffset + ifd.length);
      await this.handle.write(ifd, 0, ifd.length, ifdOffset);
      this.position += ifd.length;

      const ifdPointer = Buffer.alloc(4);
      ifdPointer.writeUInt32LE(ifdOffset, 0);
      await this.handle.write(ifdPointer, 0, 4, 4);
      await this.handle.sync();
      await this.handle.close();
      this.closed = true;
      await rename(this.temporaryPath, this.options.outputPath);
      return {
        outputPath: this.options.outputPath,
        byteLength: this.position,
        bitDepth: 16,
        colorSpace: "sRGB",
        hasEmbeddedIcc: true,
      };
    } catch (error) {
      await this.cancel();
      throw error;
    }
  }

  public async cancel(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      await this.handle.close().catch(() => undefined);
    }
    await rm(this.temporaryPath, { force: true });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("The TIFF streaming session is already closed.");
  }

  private assertClassicOffset(value: number): void {
    if (!Number.isSafeInteger(value) || value > 0xffff_ffff) {
      throw new Error("Streaming TIFF exceeded the classic 4 GiB offset limit.");
    }
  }

  private async alignPosition(alignment: number): Promise<void> {
    const aligned = align(this.position, alignment);
    if (aligned === this.position) return;
    const padding = Buffer.alloc(aligned - this.position);
    await this.handle.write(padding, 0, padding.length, this.position);
    this.position = aligned;
  }
}

function encodeHorizontalPredictor(data: Uint16Array, width: number, height: number): Buffer {
  const output = Buffer.allocUnsafe(data.length * 2);
  const rowSamples = width * 3;
  for (let row = 0; row < height; row += 1) {
    const rowStart = row * rowSamples;
    for (let channel = 0; channel < 3; channel += 1) {
      let previous = 0;
      for (let x = 0; x < width; x += 1) {
        const index = rowStart + x * 3 + channel;
        const current = data[index];
        output.writeUInt16LE((current - previous) & 0xffff, index * 2);
        previous = current;
      }
    }
  }
  return output;
}

function createRational(value: number): Buffer {
  const denominator = 10_000;
  const numerator = Math.round(value * denominator);
  const result = Buffer.alloc(8);
  result.writeUInt32LE(numerator, 0);
  result.writeUInt32LE(denominator, 4);
  return result;
}

function rationalArrayBuffer(values: readonly number[]): Buffer {
  const denominator = 1_000_000;
  const output = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => {
    output.writeUInt32LE(Math.max(0, Math.round(value * denominator)), index * 8);
    output.writeUInt32LE(denominator, index * 8 + 4);
  });
  return output;
}

function signedRationalArrayBuffer(values: readonly number[]): Buffer {
  const denominator = 1_000_000;
  const output = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => {
    output.writeInt32LE(Math.round(value * denominator), index * 8);
    output.writeInt32LE(denominator, index * 8 + 4);
  });
  return output;
}

function inlineByteValue(values: readonly [number, number, number, number]): number {
  return values[0] | (values[1] << 8) | (values[2] << 16) | (values[3] << 24);
}

function uint32ArrayBuffer(values: readonly number[]): Buffer {
  const output = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => output.writeUInt32LE(value, index * 4));
  return output;
}

function createTiffEntry(tag: number, type: number, count: number, value: number): Buffer {
  const output = Buffer.alloc(12);
  output.writeUInt16LE(tag, 0);
  output.writeUInt16LE(type, 2);
  output.writeUInt32LE(count, 4);
  if (type === 3 && count === 1) {
    output.writeUInt16LE(value, 8);
  } else {
    output.writeUInt32LE(value, 8);
  }
  return output;
}

function normalizeDisplaySample(value: number): number {
  if (Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) {
    return 0;
  }
  if (value === Number.POSITIVE_INFINITY) {
    return 1;
  }
  return clamp(value, 0, 1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function assertDisplayLinearSource(source: DisplayLinearTiffSource): void {
  assertTiffDimensions(source.width, source.height);

  const expectedLength = source.width * source.height * 3;
  if (!Number.isSafeInteger(expectedLength) || source.data.length !== expectedLength) {
    throw new Error("Display-linear TIFF data must contain exactly width × height × 3 samples.");
  }
}

function assertSrgb16Source(source: Srgb16TiffSource): void {
  assertTiffDimensions(source.width, source.height);
  const expectedLength = source.width * source.height * 3;
  if (!Number.isSafeInteger(expectedLength) || source.data.length !== expectedLength) {
    throw new Error("16-bit TIFF data must contain exactly width × height × 3 samples.");
  }
}

function assertTiffDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error("TIFF dimensions must be positive safe integers.");
  }
  if (!Number.isSafeInteger(width * height * 3)) {
    throw new Error("TIFF dimensions exceed JavaScript's safe sample range.");
  }
}

function assertDensity(densityDpi: number): void {
  if (!Number.isFinite(densityDpi) || densityDpi <= 0 || densityDpi > 1_000_000) {
    throw new Error("TIFF density must be a finite value between 0 and 1,000,000 DPI.");
  }
}

async function getSrgbIccProfile(): Promise<Buffer> {
  if (sRgbProfilePromise === undefined) {
    sRgbProfilePromise = (async () => {
      const taggedReference = await sharp({
        create: {
          width: 1,
          height: 1,
          channels: 3,
          background: { r: 0, g: 0, b: 0 },
        },
      })
        .withIccProfile("srgb")
        .png()
        .toBuffer();
      const profile = (await sharp(taggedReference).metadata()).icc;

      if (profile === undefined || profile.length === 0) {
        throw new Error("Sharp could not provide its built-in sRGB ICC profile.");
      }
      return Buffer.from(profile);
    })();
  }
  return sRgbProfilePromise;
}

export function createDefaultXmp(
  processingMetadata: Readonly<Record<string, string | number | boolean>> | undefined,
  delivery: {
    readonly colorSpace: string;
    readonly transfer: string;
    readonly bitDepth: number;
  } = { colorSpace: "sRGB", transfer: "sRGB IEC 61966-2-1", bitDepth: 16 },
): string {
  const provenance = processingMetadata === undefined
    ? "{}"
    : JSON.stringify(Object.fromEntries(Object.entries(processingMetadata).sort(([left], [right]) => left.localeCompare(right))));

  return [
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description xmlns:filmlab="https://filmlab.app/ns/1.0/"',
    ' filmlab:ColorSpace="' + escapeXmlAttribute(delivery.colorSpace) + '"',
    ' filmlab:Transfer="' + escapeXmlAttribute(delivery.transfer) + '"',
    ' filmlab:BitDepth="' + delivery.bitDepth + '"',
    ' filmlab:Processing="' + escapeXmlAttribute(provenance) + '"/>',
    '</rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join("");
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

interface TiffMetadata {
  readonly icc: Buffer;
  readonly xmp: string;
}

interface ParsedTiffDirectory {
  readonly bigtiff: boolean;
  readonly littleEndian: boolean;
  readonly entries: readonly Buffer[];
  readonly nextIfdOffset: bigint;
}

interface NewTiffEntry {
  readonly tag: number;
  readonly type: number;
  readonly count: bigint;
  readonly data: Buffer;
}

/**
 * Add ICC (34675) and XMP (700) tags by appending a replacement first IFD.
 * The compressed image data emitted by Sharp is left untouched, so inserting a
 * profile cannot alter the 16-bit samples or defeat lossless compression.
 */
function injectTiffMetadata(source: Buffer, metadata: TiffMetadata): Buffer {
  const directory = parseFirstTiffDirectory(source);
  const replaceableTags = new Set([34675, 700]);
  const retainedEntries = directory.entries.filter((entry) => !replaceableTags.has(readUnsigned16(entry, 0, directory.littleEndian)));
  const addedEntries: NewTiffEntry[] = [
    { tag: 700, type: 1, count: BigInt(Buffer.byteLength(metadata.xmp, "utf8")), data: Buffer.from(metadata.xmp, "utf8") },
    { tag: 34675, type: 7, count: BigInt(metadata.icc.length), data: metadata.icc },
  ];
  const entrySize = directory.bigtiff ? 20 : 12;
  const countFieldSize = directory.bigtiff ? 8 : 2;
  const offsetFieldSize = directory.bigtiff ? 8 : 4;
  const alignment = directory.bigtiff ? 8 : 2;
  const totalEntryCount = retainedEntries.length + addedEntries.length;

  if (!directory.bigtiff && totalEntryCount > 65_535) {
    throw new Error("Classic TIFF cannot represent this many IFD entries.");
  }

  const directoryOffset = align(source.length, alignment);
  const directoryByteLength = countFieldSize + (totalEntryCount * entrySize) + offsetFieldSize;
  let valueOffset = align(directoryOffset + directoryByteLength, alignment);
  const generatedEntries = addedEntries.map((entry) => {
    const offset = valueOffset;
    valueOffset = align(valueOffset + entry.data.length, alignment);
    return { ...entry, offset };
  });

  if (!directory.bigtiff && valueOffset > 0xffff_ffff) {
    throw new Error("Classic TIFF metadata offsets exceed 4 GiB; request BigTIFF explicitly.");
  }

  const output = Buffer.alloc(valueOffset);
  source.copy(output);
  writeFirstIfdOffset(output, directoryOffset, directory.bigtiff, directory.littleEndian);

  writeUnsigned(output, BigInt(totalEntryCount), directoryOffset, countFieldSize, directory.littleEndian);
  let cursor = directoryOffset + countFieldSize;
  const sortedEntries = [
    ...retainedEntries.map((raw) => ({ raw, tag: readUnsigned16(raw, 0, directory.littleEndian) })),
    ...generatedEntries.map((entry) => ({ entry, tag: entry.tag })),
  ].sort((left, right) => left.tag - right.tag);

  for (const item of sortedEntries) {
    if ("raw" in item) {
      item.raw.copy(output, cursor);
    } else {
      writeUnsigned16(output, item.entry.tag, cursor, directory.littleEndian);
      writeUnsigned16(output, item.entry.type, cursor + 2, directory.littleEndian);
      writeUnsigned(output, item.entry.count, cursor + 4, directory.bigtiff ? 8 : 4, directory.littleEndian);
      writeUnsigned(output, BigInt(item.entry.offset), cursor + 4 + (directory.bigtiff ? 8 : 4), offsetFieldSize, directory.littleEndian);
    }
    cursor += entrySize;
  }
  writeUnsigned(output, directory.nextIfdOffset, cursor, offsetFieldSize, directory.littleEndian);

  for (const entry of generatedEntries) {
    entry.data.copy(output, entry.offset);
  }

  return output;
}

function parseFirstTiffDirectory(source: Buffer): ParsedTiffDirectory {
  if (source.length < 8) {
    throw new Error("Expected a TIFF buffer, received fewer than eight bytes.");
  }

  const byteOrder = source.toString("ascii", 0, 2);
  const littleEndian = byteOrder === "II";
  if (!littleEndian && byteOrder !== "MM") {
    throw new Error("TIFF byte order marker is invalid.");
  }

  const magic = readUnsigned16(source, 2, littleEndian);
  if (magic !== 42 && magic !== 43) {
    throw new Error("Expected a classic TIFF or BigTIFF stream.");
  }

  const bigtiff = magic === 43;
  let ifdOffset: number;
  let countFieldSize: 2 | 4 | 8;
  let entrySize: number;
  let offsetFieldSize: 2 | 4 | 8;

  if (bigtiff) {
    if (source.length < 16 || readUnsigned16(source, 4, littleEndian) !== 8 || readUnsigned16(source, 6, littleEndian) !== 0) {
      throw new Error("BigTIFF header is invalid or uses an unsupported offset size.");
    }
    ifdOffset = bigIntToSafeNumber(readUnsigned(source, 8, 8, littleEndian), "BigTIFF first IFD offset");
    countFieldSize = 8;
    entrySize = 20;
    offsetFieldSize = 8;
  } else {
    ifdOffset = Number(readUnsigned(source, 4, 4, littleEndian));
    countFieldSize = 2;
    entrySize = 12;
    offsetFieldSize = 4;
  }

  ensureRange(source, ifdOffset, countFieldSize);
  const entryCount = bigIntToSafeNumber(readUnsigned(source, ifdOffset, countFieldSize, littleEndian), "TIFF IFD entry count");
  const entriesStart = ifdOffset + countFieldSize;
  const entriesByteLength = entryCount * entrySize;
  ensureRange(source, entriesStart, entriesByteLength + offsetFieldSize);

  const entries: Buffer[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    const offset = entriesStart + (index * entrySize);
    entries.push(Buffer.from(source.subarray(offset, offset + entrySize)));
  }

  return {
    bigtiff,
    littleEndian,
    entries,
    nextIfdOffset: readUnsigned(source, entriesStart + entriesByteLength, offsetFieldSize, littleEndian),
  };
}

function writeFirstIfdOffset(
  buffer: Buffer,
  offset: number,
  bigtiff: boolean,
  littleEndian: boolean,
): void {
  writeUnsigned(buffer, BigInt(offset), bigtiff ? 8 : 4, bigtiff ? 8 : 4, littleEndian);
}

function readUnsigned16(buffer: Buffer, offset: number, littleEndian: boolean): number {
  ensureRange(buffer, offset, 2);
  return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
}

function writeUnsigned16(buffer: Buffer, value: number, offset: number, littleEndian: boolean): void {
  if (littleEndian) {
    buffer.writeUInt16LE(value, offset);
  } else {
    buffer.writeUInt16BE(value, offset);
  }
}

function readUnsigned(buffer: Buffer, offset: number, bytes: 2 | 4 | 8, littleEndian: boolean): bigint {
  ensureRange(buffer, offset, bytes);
  if (bytes === 2) {
    return BigInt(readUnsigned16(buffer, offset, littleEndian));
  }
  if (bytes === 4) {
    return BigInt(littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
  }
  return littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
}

function writeUnsigned(
  buffer: Buffer,
  value: bigint,
  offset: number,
  bytes: 2 | 4 | 8,
  littleEndian: boolean,
): void {
  ensureRange(buffer, offset, bytes);
  if (bytes === 2) {
    writeUnsigned16(buffer, Number(value), offset, littleEndian);
    return;
  }
  if (bytes === 4) {
    if (value > 0xffff_ffffn) {
      throw new Error("Value exceeds the classic TIFF unsigned 32-bit range.");
    }
    if (littleEndian) {
      buffer.writeUInt32LE(Number(value), offset);
    } else {
      buffer.writeUInt32BE(Number(value), offset);
    }
    return;
  }
  if (littleEndian) {
    buffer.writeBigUInt64LE(value, offset);
  } else {
    buffer.writeBigUInt64BE(value, offset);
  }
}

function bigIntToSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(label + " exceeds JavaScript's safe integer range.");
  }
  return Number(value);
}

function ensureRange(buffer: Buffer, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error("TIFF directory points outside the encoded buffer.");
  }
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
