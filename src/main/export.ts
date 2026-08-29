import sharp from "sharp";
import { createGeometryPlan, encode16, encode8, negadoctorInputPrimaries, processNegative } from "../core/index.ts";
import type { Recipe } from "../core/index.ts";
import type { SingleExportResult } from "../shared/ipc.ts";
import { decodeSource, probeSource } from "./decode.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { writeTiff16 } from "./tiff-write.ts";
import { assertExportCapacity, friendlyProcessingError } from "./resource-limits.ts";
import { assertProcessingMemory } from "./processing-memory.ts";

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
    const meta = await probeSource(sourcePath);
    const plan = createGeometryPlan(meta.width, meta.height, recipe.rotate, recipe.crop);
    await assertExportCapacity(outPath, plan.width, plan.height, format);
    assertProcessingMemory({
      sourceWidth: meta.width,
      sourceHeight: meta.height,
      targetWidth: plan.width,
      targetHeight: plan.height,
      sourceDepth: meta.depth,
      sourceFormat: meta.format,
      format,
      identityGeometry: isIdentityGeometry(plan),
    });
    const { raster } = await decodeSource(sourcePath);
    const effectiveRecipe: Recipe = recipe.engine === "negadoctor-5.6"
      ? { ...recipe, inputPrimaries: negadoctorInputPrimaries(recipe, meta.format) }
      : recipe;
    const { display } = processNegative(raster, effectiveRecipe);
    if (format === "tiff") {
      await writeTiff16(outPath, display.width, display.height, encode16(display));
    } else {
      const pixels = encode8(display);
      const encoded = await sharp(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength), {
        raw: { width: display.width, height: display.height, channels: 3 },
      })
        .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
        .toBuffer();
      await writeFileAtomic(outPath, encoded);
    }
    return { ok: true, path: outPath };
  } catch (error) {
    return { ok: false, message: friendlyProcessingError(error) };
  }
}

function isIdentityGeometry(plan: ReturnType<typeof createGeometryPlan>): boolean {
  return plan.quarter === 0 && plan.residualRadians === 0
    && plan.cropX === 0 && plan.cropY === 0
    && plan.width === plan.sourceWidth && plan.height === plan.sourceHeight;
}
