import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DEFAULT_RECIPE } from "../src/core/index.ts";
import type { Recipe } from "../src/core/index.ts";
import { readTiff } from "../src/main/tiff-decode.ts";
import { writeTiff16 } from "../src/main/tiff-write.ts";
import {
  decodeRollPreview,
  decodeRollThumbnail,
  exportRoll,
  registerFrames,
  scanFolder,
} from "../src/main/roll-service.ts";

let tempDir: string;
after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

/** 16-bit linear negative: unexposed border, then a neutral density ramp. */
function makeNegative(width: number, height: number, border: number): Uint16Array {
  const base = [0.8, 0.5, 0.3] as const;
  const raw = new Uint16Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const s = x < border ? 0 : (x - border) / (width - border);
      const transmission = 1 / (1 + 9 * s);
      const offset = (y * width + x) * 3;
      raw[offset] = Math.round(base[0] * transmission * 65535);
      raw[offset + 1] = Math.round(base[1] * transmission * 65535);
      raw[offset + 2] = Math.round(base[2] * transmission * 65535);
    }
  }
  return raw;
}

describe("Roll service", () => {
  it("registers frames and decodes previews and thumbnails", async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "filmlab-roll-"));
    await writeTiff16(join(tempDir, "a.tiff"), 64, 32, makeNegative(64, 32, 6));
    await writeTiff16(join(tempDir, "b.tiff"), 100, 40, makeNegative(100, 40, 8));
    const infos = registerFrames([join(tempDir, "a.tiff"), join(tempDir, "b.tiff")]);
    assert.equal(infos.length, 2);
    assert.equal(infos[0]!.fileName, "a.tiff");

    const preview = await decodeRollPreview(infos[0]!.id);
    assert.equal(preview.width, 64);
    assert.equal(preview.height, 32);
    assert.equal(preview.depth, 16);
    assert.equal(preview.raster.length, 64 * 32 * 3);
    assert.ok(preview.raster.buffer instanceof ArrayBuffer);

    const thumb = await decodeRollThumbnail(infos[1]!.id);
    assert.ok(thumb.width <= 256 && thumb.height <= 256);
    assert.equal(thumb.raster.length, thumb.width * thumb.height * 3);
  });

  it("rejects unknown frame ids", async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "filmlab-roll-"));
    registerFrames([]);
    await assert.rejects(decodeRollPreview("no-such-id"), /帧不存在/);
    await assert.rejects(decodeRollThumbnail("no-such-id"), /帧不存在/);
  });

  it("scans a folder for supported images, sorted by name", async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "filmlab-roll-"));
    await fs.writeFile(join(tempDir, "notes.txt"), "x");
    await fs.mkdir(join(tempDir, "sub"));
    await writeTiff16(join(tempDir, "2.tiff"), 8, 8, makeNegative(8, 8, 1));
    await writeTiff16(join(tempDir, "10.tiff"), 8, 8, makeNegative(8, 8, 1));
    await writeTiff16(join(tempDir, "1.tiff"), 8, 8, makeNegative(8, 8, 1));
    for (const name of ["3.CR2", "4.nef", "5.RW2", "6.arw"]) await fs.writeFile(join(tempDir, name), "raw");
    const paths = await scanFolder(tempDir);
    assert.deepEqual(paths.map((path) => path.split(/[\\/]/).pop()), [
      "1.tiff", "2.tiff", "3.CR2", "4.nef", "5.RW2", "6.arw", "10.tiff",
    ]);
  });

  it("exports every frame with its own recipe and reports failures", async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "filmlab-roll-"));
    const outDir = join(tempDir, "out");
    await fs.mkdir(outDir);
    await writeTiff16(join(tempDir, "f1.tiff"), 64, 32, makeNegative(64, 32, 6));
    await writeTiff16(join(tempDir, "f2.tiff"), 100, 40, makeNegative(100, 40, 8));
    await fs.writeFile(join(tempDir, "broken.tiff"), "this is not a tiff");
    const infos = registerFrames([
      join(tempDir, "f1.tiff"),
      join(tempDir, "broken.tiff"),
      join(tempDir, "f2.tiff"),
    ]);

    const progress: string[] = [];
    const result = await exportRoll(
      {
        frames: [
          { id: infos[0]!.id, recipe: DEFAULT_RECIPE },
          { id: infos[1]!.id, recipe: DEFAULT_RECIPE },
          { id: infos[2]!.id, recipe: { ...DEFAULT_RECIPE, rotate: 90 } as Recipe },
        ],
        format: "tiff",
        outDir,
      },
      (update) => progress.push(`${update.done}/${update.total}:${update.fileName}`),
      () => false,
    );

    assert.equal(result.cancelled, false);
    assert.equal(result.succeeded.length, 2);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]!.fileName, "broken.tiff");
    assert.ok(result.failed[0]!.message.length > 0);

    // The rotated frame exports with swapped dimensions.
    const rotated = await readTiff(result.succeeded[1]!.path);
    assert.equal(rotated.width, 40);
    assert.equal(rotated.height, 100);
    assert.equal(rotated.depth, 16);

    assert.deepEqual(progress, [
      "0/3:f1.tiff",
      "1/3:broken.tiff",
      "2/3:f2.tiff",
    ]);
  });

  it("cancels between frames and keeps completed files", async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "filmlab-roll-"));
    const outDir = join(tempDir, "out");
    await fs.mkdir(outDir);
    await writeTiff16(join(tempDir, "c1.tiff"), 32, 16, makeNegative(32, 16, 3));
    await writeTiff16(join(tempDir, "c2.tiff"), 32, 16, makeNegative(32, 16, 3));
    const infos = registerFrames([join(tempDir, "c1.tiff"), join(tempDir, "c2.tiff")]);

    let checks = 0;
    const result = await exportRoll(
      {
        frames: infos.map((info) => ({ id: info.id, recipe: DEFAULT_RECIPE })),
        format: "tiff",
        outDir,
      },
      () => {},
      () => {
        checks += 1;
        return checks > 1; // cancel once the first frame finished
      },
    );
    assert.equal(result.cancelled, true);
    assert.equal(result.succeeded.length, 1);
    const exported = await fs.readdir(outDir);
    assert.equal(exported.length, 1);
  });

  it("deduplicates output names instead of overwriting", async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "filmlab-roll-"));
    const firstDir = join(tempDir, "one");
    const secondDir = join(tempDir, "two");
    const outDir = join(tempDir, "out");
    await fs.mkdir(firstDir);
    await fs.mkdir(secondDir);
    await fs.mkdir(outDir);
    await writeTiff16(join(firstDir, "same.tiff"), 32, 16, makeNegative(32, 16, 3));
    await writeTiff16(join(secondDir, "same.tiff"), 32, 16, makeNegative(32, 16, 3));
    const infos = registerFrames([join(firstDir, "same.tiff"), join(secondDir, "same.tiff")]);

    const result = await exportRoll(
      {
        frames: infos.map((info) => ({ id: info.id, recipe: DEFAULT_RECIPE })),
        format: "tiff",
        outDir,
      },
      () => {},
      () => false,
    );
    assert.equal(result.succeeded.length, 2);
    const exported = (await fs.readdir(outDir)).sort();
    assert.deepEqual(exported, ["same-positive-2.tiff", "same-positive.tiff"]);
  });
});
