import { promises as fs } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RECIPE } from "../core/index.ts";
import type { ProcessingServiceCore } from "./processing-service-core.ts";
import { clearFrames, exportRoll, registerFrames } from "./roll-service.ts";
import { writeTiff16 } from "./tiff-write.ts";

/** Exercises the installed coordinator/pixel Workers and both encoders without a dialog. */
export async function runReleaseExportSmoke(root: string, service: ProcessingServiceCore): Promise<string> {
  const output = join(root, `filmlab-release-smoke-${Date.now()}`);
  await fs.mkdir(output, { recursive: true });
  const sources = [join(output, "一号 negative.tiff"), join(output, "second negative.tiff")];
  for (let index = 0; index < sources.length; index += 1) {
    await writeTiff16(sources[index]!, 96, 64, makeNegative(index * 0.03));
  }

  const singleTiff = await service.renderPositive(sources[0]!, DEFAULT_RECIPE, "tiff", join(output, "single positive.tiff"));
  if (!singleTiff.ok) throw new Error(singleTiff.message);
  const singleJpeg = await service.renderPositive(sources[0]!, DEFAULT_RECIPE, "jpeg", join(output, "single positive.jpg"));
  if (!singleJpeg.ok) throw new Error(singleJpeg.message);

  const frames = registerFrames(sources);
  try {
    for (const format of ["tiff", "jpeg"] as const) {
      const outDir = join(output, `roll-${format}`);
      await fs.mkdir(outDir, { recursive: true });
      const result = await exportRoll({
        frames: frames.map((frame) => ({ id: frame.id, recipe: DEFAULT_RECIPE })),
        format,
        outDir,
      }, () => {}, () => false, (sourcePath, recipe, targetFormat, outPath) => (
        service.renderPositive(sourcePath, recipe, targetFormat, outPath)
      ));
      if (!result.ok || result.succeeded.length !== sources.length) {
        throw new Error(result.message ?? `整卷 ${format} smoke 未完成。`);
      }
    }
  } finally {
    clearFrames();
  }

  const expected = [
    "single positive.tiff",
    "single positive.jpg",
    join("roll-tiff", "一号 negative-positive.tiff"),
    join("roll-tiff", "second negative-positive.tiff"),
    join("roll-jpeg", "一号 negative-positive.jpg"),
    join("roll-jpeg", "second negative-positive.jpg"),
  ];
  for (const relative of expected) {
    const stat = await fs.stat(join(output, relative));
    if (!stat.isFile() || stat.size < 1) throw new Error(`发布导出 smoke 缺少 ${relative}`);
  }
  return output;
}

function makeNegative(offset: number): Uint16Array {
  const width = 96;
  const height = 64;
  const pixels = new Uint16Array(width * height * 3);
  const base = [0.84, 0.61, 0.39];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const position = (y * width + x) * 3;
      const border = x < 8 || y < 4;
      const density = border ? 0 : 0.15 + offset + 1.8 * (x / (width - 1));
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[position + channel] = Math.round(base[channel]! * 10 ** (-density) * 65_535);
      }
    }
  }
  return pixels;
}
