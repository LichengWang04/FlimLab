import sharp from "sharp";
import { encode16, encode8, processNegative } from "../core/index.ts";
import type { Recipe } from "../core/index.ts";
import type { SingleExportResult } from "../shared/ipc.ts";
import { decodeSource } from "./decode.ts";
import { writeTiff16 } from "./tiff-write.ts";

/**
 * Decodes the source at full resolution, runs the shared core pipeline with
 * the given recipe, quantizes to sRGB and writes the container. TIFF
 * delivers 16-bit sRGB via the internal encoder; JPEG is 8-bit sRGB at
 * quality 95 with 4:4:4 chroma. Neither carries an embedded profile;
 * untagged sRGB is the interoperable delivery convention.
 */
export async function renderPositive(
  sourcePath: string,
  recipe: Recipe,
  format: "tiff" | "jpeg",
  outPath: string,
): Promise<SingleExportResult> {
  try {
    const { raster } = await decodeSource(sourcePath);
    const { display } = processNegative(raster, recipe);
    if (format === "tiff") {
      await writeTiff16(outPath, display.width, display.height, encode16(display));
    } else {
      const pixels = encode8(display);
      await sharp(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength), {
        raw: { width: display.width, height: display.height, channels: 3 },
      })
        .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
        .toFile(outPath);
    }
    return { ok: true, path: outPath };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
