import { readdir, mkdir, writeFile } from "node:fs/promises";
import { extname, join, parse, resolve } from "node:path";
import { convertRasterPrimaries } from "../src/core/index.ts";
import { decodeRawSource } from "../src/main/raw-decode.ts";
import { writeTiff16 } from "../src/main/tiff-write.ts";

const sourceValue = process.env.FILMLAB_RAW_FIXTURES;
if (!sourceValue) throw new Error("请设置 FILMLAB_RAW_FIXTURES 指向包含私有 RAW 样张的目录。");
const sourceDir = resolve(sourceValue);
const outputDir = resolve(process.env.FILMLAB_NEGADOCTOR_FIXTURES ?? join(sourceDir, "negadoctor-fixtures"));
const supported = new Set([".cr2", ".nef", ".rw2", ".arw"]);
const names = (await readdir(sourceDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && supported.has(extname(entry.name).toLowerCase()))
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right, "en"))
  .slice(0, 6);
if (names.length < 4) throw new Error("Negadoctor 验收至少需要 4 张 RAW 样张。");
await mkdir(outputDir, { recursive: true });

const cases = [];
for (const [index, name] of names.entries()) {
  const sourcePath = join(sourceDir, name);
  const decoded = await decodeRawSource(sourcePath, 1600);
  const rec2020 = convertRasterPrimaries(decoded.raster, "srgb", "rec2020");
  const pixels = new Uint16Array(rec2020.data.length);
  for (let offset = 0; offset < rec2020.data.length; offset += 1) {
    pixels[offset] = Math.round(Math.min(1, Math.max(0, rec2020.data[offset])) * 65_535);
  }
  const stem = parse(name).name.replace(/[^a-z0-9_-]+/gi, "-");
  const outputName = `${String(index + 1).padStart(2, "0")}-${stem}.tiff`;
  await writeTiff16(join(outputDir, outputName), rec2020.width, rec2020.height, pixels);
  cases.push({
    name: `raw-${String(index + 1).padStart(2, "0")}-${stem}`,
    input: outputName,
    recipe: { inputPrimaries: "rec2020", workingSpace: "linear-rec2020" },
  });
  console.log(`prepared ${name}: ${decoded.meta.width}x${decoded.meta.height} -> ${rec2020.width}x${rec2020.height}`);
}
await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify({ cases }, null, 2)}\n`, "utf8");
console.log(`Negadoctor fixtures prepared: ${outputDir}`);
