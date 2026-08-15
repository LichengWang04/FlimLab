import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { deflate } from "node:zlib";

const deflateAsync = promisify(deflate);

/**
 * Minimal baseline TIFF writer for packed 16-bit RGB pixels (sRGB-encoded).
 *
 * sharp 0.35 accepts only 8-bit raw buffer input, so the 16-bit delivery
 * format gets its own small encoder instead of a dependency workaround.
 * Layout: little-endian header, one IFD with the tags colour-managed readers
 * expect, then a single deflate-compressed strip. The file carries no ICC
 * profile; untagged sRGB is the documented delivery convention.
 */
export async function writeTiff16(path: string, width: number, height: number, pixels: Uint16Array): Promise<void> {
  if (pixels.length !== width * height * 3) {
    throw new Error("TIFF pixel buffer does not match the declared dimensions.");
  }
  const compressed = await deflateAsync(
    Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
  );

  const entryCount = 11;
  const ifdStart = 8;
  const ifdSize = 2 + entryCount * 12 + 4;
  const dataStart = ifdStart + ifdSize;
  const bitsPerSampleOffset = dataStart;
  const sampleFormatOffset = bitsPerSampleOffset + 6;
  const pixelOffset = sampleFormatOffset + 6;
  const file = Buffer.alloc(pixelOffset + compressed.length);

  // Header: little-endian, classic TIFF, IFD at byte 8.
  file.write("II", 0, "ascii");
  file.writeUInt16LE(42, 2);
  file.writeUInt32LE(ifdStart, 4);

  let cursor = ifdStart;
  file.writeUInt16LE(entryCount, cursor);
  cursor += 2;

  const entry = (tag: number, type: number, count: number, value: number): void => {
    file.writeUInt16LE(tag, cursor);
    file.writeUInt16LE(type, cursor + 2);
    file.writeUInt32LE(count, cursor + 4);
    // Inline 4-byte values; anything longer lives in the data area.
    file.writeUInt32LE(value, cursor + 8);
    cursor += 12;
  };
  const SHORT = 3;
  const LONG = 4;

  entry(256, LONG, 1, width);                       // ImageWidth
  entry(257, LONG, 1, height);                      // ImageLength
  entry(258, SHORT, 3, bitsPerSampleOffset);        // BitsPerSample = 16,16,16
  entry(259, SHORT, 1, 8);                          // Compression = deflate
  entry(262, SHORT, 1, 2);                          // PhotometricInterpretation = RGB
  entry(273, LONG, 1, pixelOffset);                 // StripOffsets
  entry(277, SHORT, 1, 3);                          // SamplesPerPixel
  entry(278, LONG, 1, height);                      // RowsPerStrip
  entry(279, LONG, 1, compressed.length);           // StripByteCounts
  entry(284, SHORT, 1, 1);                          // PlanarConfiguration = chunky
  entry(339, SHORT, 3, sampleFormatOffset);         // SampleFormat = unsigned
  file.writeUInt32LE(0, cursor);                    // Next IFD

  file.writeUInt16LE(16, bitsPerSampleOffset);
  file.writeUInt16LE(16, bitsPerSampleOffset + 2);
  file.writeUInt16LE(16, bitsPerSampleOffset + 4);
  file.writeUInt16LE(1, sampleFormatOffset);
  file.writeUInt16LE(1, sampleFormatOffset + 2);
  file.writeUInt16LE(1, sampleFormatOffset + 4);
  compressed.copy(file, pixelOffset);

  // Write to a sibling temporary file, then publish atomically.
  const temporary = join(
    dirname(path),
    `.${path.split(/[\\/]/).pop() ?? "export"}.${randomBytes(6).toString("hex")}.part`,
  );
  await fs.writeFile(temporary, file);
  try {
    await fs.rename(temporary, path);
  } catch (error) {
    // Windows cannot rename over an existing file; the save dialog has
    // already confirmed the overwrite, so remove the old target and retry.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM") throw error;
    await fs.rm(path, { force: true });
    await fs.rename(temporary, path);
  }
}
