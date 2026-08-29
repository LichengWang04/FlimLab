import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { DEFAULT_NEGADOCTOR_56 } from "../src/core/index.ts";
import { parseRecipe } from "../src/main/ipc-validation.ts";
import { renderPositive } from "../src/main/export.ts";

const EXPECTED_VERSION = "5.6.0";
const cli = locateDarktable();
const versionText = execFileSync(cli, ["--version"], { encoding: "utf8" });
const version = /darktable\s+(\d+\.\d+\.\d+)/i.exec(versionText)?.[1];
if (version !== EXPECTED_VERSION) {
  throw new Error(`Negadoctor 验收只接受 darktable ${EXPECTED_VERSION}，当前为 ${version ?? "未知版本"}。`);
}
console.log(`darktable ${version} 版本预检通过: ${cli}`);

const fixturesValue = process.env.FILMLAB_NEGADOCTOR_FIXTURES;
if (!fixturesValue) {
  console.log("SKIP: 未设置 FILMLAB_NEGADOCTOR_FIXTURES；未执行私有样张 SSIM/ΔE00 兼容验收。");
  process.exit(0);
}

const fixturesDir = resolve(fixturesValue);
const manifestPath = join(fixturesDir, "manifest.json");
if (!existsSync(manifestPath)) throw new Error(`私有样张目录缺少 manifest.json: ${manifestPath}`);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!Array.isArray(manifest.cases) || manifest.cases.length < 4 || manifest.cases.length > 6) {
  throw new Error("manifest.json 的 cases 必须包含 4–6 个验收样张。");
}

const template = await readFile(new URL("./negadoctor-5.6-template.xmp", import.meta.url), "utf8");
const scratch = await mkdtemp(join(tmpdir(), "filmlab-negadoctor-"));
const reportDir = resolve(process.env.FILMLAB_NEGADOCTOR_REPORT ?? "artifacts/negadoctor-acceptance");
await mkdir(reportDir, { recursive: true });
const results = [];
let failed = false;

try {
  for (const [index, entry] of manifest.cases.entries()) {
    const input = resolveInside(fixturesDir, entry.input);
    if (!/\.tiff?$/i.test(input) || !existsSync(input)) throw new Error(`样张不存在或不是 TIFF: ${entry.input}`);
    const parsed = parseRecipe({ ...DEFAULT_NEGADOCTOR_56, ...(entry.recipe ?? {}), engine: "negadoctor-5.6" });
    if (parsed.engine !== "negadoctor-5.6") throw new Error(`${entry.input} 不是 Negadoctor 配方。`);
    const name = safeName(entry.name ?? basename(input).replace(/\.tiff?$/i, ""), index);
    const caseDir = join(scratch, name);
    const configDir = join(caseDir, "config");
    const cacheDir = join(caseDir, "cache");
    await mkdir(configDir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    const xmp = join(caseDir, `${name}.xmp`);
    const darktableOutput = join(caseDir, `${name}-darktable.tif`);
    const filmlabOutput = join(caseDir, `${name}-filmlab.tif`);
    await writeFile(xmp, template
      .replace("{{COLORIN_PARAMS}}", encodeLinearRec2020ColorIn())
      .replace("{{NEGADOCTOR_PARAMS}}", encodeNegadoctorParams(parsed)), "utf8");

    execFileSync(cli, [
      darktablePath(input),
      darktablePath(xmp),
      darktablePath(darktableOutput),
      "--out-ext", "tif",
      "--icc-type", "SRGB",
      "--apply-custom-presets", "false",
      "--hq", "true",
      "--library", ":memory:",
      "--core",
      "--configdir", darktablePath(configDir),
      "--cachedir", darktablePath(cacheDir),
      "--disable-opencl",
      "--conf", "plugins/darkroom/workflow=none",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    const rendered = await renderPositive(input, parsed, "tiff", filmlabOutput);
    if (!rendered.ok) throw new Error(`FilmLab 导出失败: ${rendered.message ?? "未知错误"}`);
    const compared = await compareImages(filmlabOutput, darktableOutput);
    const pass = compared.ssim >= 0.98 && compared.medianDeltaE00 <= 2 && compared.p95DeltaE00 <= 5;
    failed ||= !pass;
    const diffPath = join(reportDir, `${name}-diff.png`);
    await writeDifferenceThumbnail(compared, diffPath);
    const result = {
      name,
      input: basename(input),
      eligiblePixels: compared.eligible,
      totalPixels: compared.width * compared.height,
      luminanceSsim: compared.ssim,
      medianDeltaE00: compared.medianDeltaE00,
      p95DeltaE00: compared.p95DeltaE00,
      pass,
      differenceThumbnail: basename(diffPath),
    };
    results.push(result);
    console.log(`${pass ? "PASS" : "FAIL"} ${name}: 全局SSIM=${result.luminanceSsim.toFixed(5)}, ΔE00 median=${result.medianDeltaE00.toFixed(3)}, P95=${result.p95DeltaE00.toFixed(3)}`);
  }
  await writeFile(join(reportDir, "metrics.json"), `${JSON.stringify({ darktableVersion: version, results }, null, 2)}\n`, "utf8");
} finally {
  await rm(scratch, { recursive: true, force: true });
}

if (failed) throw new Error(`Negadoctor 兼容验收未达标；报告见 ${reportDir}`);
console.log(`Negadoctor 兼容验收通过；报告见 ${reportDir}`);

function locateDarktable() {
  const candidates = [
    process.env.DARKTABLE_CLI,
    process.platform === "win32" ? "C:\\Program Files\\darktable\\bin\\darktable-cli.exe" : undefined,
    "darktable-cli",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch { /* try next candidate */ }
  }
  throw new Error("找不到 darktable-cli；请将 darktable 5.6.0 路径写入 DARKTABLE_CLI。");
}

function darktablePath(path) {
  return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}

function resolveInside(root, relative) {
  if (typeof relative !== "string" || relative.length === 0) throw new Error("manifest 样张路径无效。");
  const candidate = resolve(root, relative);
  const prefix = `${resolve(root)}${process.platform === "win32" ? "\\" : "/"}`.toLowerCase();
  if (!candidate.toLowerCase().startsWith(prefix)) throw new Error("manifest 样张路径必须位于私有样张目录内。");
  return candidate;
}

function safeName(value, index) {
  const clean = String(value).replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${String(index + 1).padStart(2, "0")}-${clean || "fixture"}`;
}

function encodeNegadoctorParams(recipe) {
  const bytes = Buffer.alloc(76);
  let offset = 0;
  bytes.writeInt32LE(recipe.filmStock === "color" ? 1 : 0, offset);
  offset += 4;
  const values = [
    ...recipe.dminRgb, 1,
    ...recipe.highlightBalanceRgb, 1,
    ...recipe.shadowCastRgb, 1,
    recipe.dmax,
    recipe.scanExposureBias,
    recipe.paperBlack,
    recipe.paperGrade,
    recipe.paperGloss,
    recipe.printExposure,
  ];
  for (const value of values) {
    bytes.writeFloatLE(value, offset);
    offset += 4;
  }
  return bytes.toString("hex");
}

function encodeLinearRec2020ColorIn() {
  // dt_iop_colorin_params_t v7: linear Rec.2020 input, perceptual intent,
  // gamut normalization off, blue mapping off, linear Rec.2020 work profile.
  const bytes = Buffer.alloc(1044);
  bytes.writeInt32LE(4, 0);
  bytes.writeInt32LE(0, 516);
  bytes.writeInt32LE(0, 520);
  bytes.writeInt32LE(0, 524);
  bytes.writeInt32LE(4, 528);
  return bytes.toString("hex");
}

async function compareImages(filmlabPath, darktablePath) {
  const left = await decodeSrgb(filmlabPath);
  const right = await decodeSrgb(darktablePath);
  if (left.width !== right.width || left.height !== right.height) throw new Error("darktable 与 FilmLab 输出尺寸不同（验收不允许裁切）。");
  const leftY = [];
  const rightY = [];
  const delta = [];
  const difference = Buffer.alloc(left.data.length);
  let eligible = 0;
  for (let offset = 0; offset < left.data.length; offset += 3) {
    let clipped = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const a = left.data[offset + channel] / 255;
      const b = right.data[offset + channel] / 255;
      clipped ||= a <= 2 / 255 || a >= 253 / 255 || b <= 2 / 255 || b >= 253 / 255;
      difference[offset + channel] = Math.min(255, Math.abs(left.data[offset + channel] - right.data[offset + channel]) * 4);
    }
    if (clipped) continue;
    const a = [left.data[offset] / 255, left.data[offset + 1] / 255, left.data[offset + 2] / 255];
    const b = [right.data[offset] / 255, right.data[offset + 1] / 255, right.data[offset + 2] / 255];
    leftY.push(luminance(a));
    rightY.push(luminance(b));
    delta.push(deltaE00(rgbToLab(a), rgbToLab(b)));
    eligible += 1;
  }
  if (eligible < Math.max(64, left.width * left.height * 0.1)) throw new Error("非剪裁有效像素不足 10%，无法计算兼容指标。");
  delta.sort((a, b) => a - b);
  return {
    width: left.width,
    height: left.height,
    difference,
    eligible,
    ssim: globalSsim(leftY, rightY),
    medianDeltaE00: percentile(delta, 0.5),
    p95DeltaE00: percentile(delta, 0.95),
  };
}

async function decodeSrgb(path) {
  const { data, info } = await sharp(path).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`无法把输出解码为 RGB: ${path}`);
  return { data, width: info.width, height: info.height };
}

async function writeDifferenceThumbnail(compared, path) {
  await sharp(compared.difference, { raw: { width: compared.width, height: compared.height, channels: 3 } })
    .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
    .png()
    .toFile(path);
}

// Global (non-windowed) SSIM over the whole luminance plane: one mean/
// variance/covariance estimate per image, not the standard local-window
// SSIM. Docs and gates must keep calling it 全局 SSIM to avoid confusion.
function globalSsim(a, b) {
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let varianceA = 0;
  let varianceB = 0;
  let covariance = 0;
  for (let index = 0; index < a.length; index += 1) {
    const da = a[index] - meanA;
    const db = b[index] - meanB;
    varianceA += da * da;
    varianceB += db * db;
    covariance += da * db;
  }
  varianceA /= Math.max(1, a.length - 1);
  varianceB /= Math.max(1, a.length - 1);
  covariance /= Math.max(1, a.length - 1);
  const c1 = 0.01 ** 2;
  const c2 = 0.03 ** 2;
  return (2 * meanA * meanB + c1) * (2 * covariance + c2)
    / ((meanA ** 2 + meanB ** 2 + c1) * (varianceA + varianceB + c2));
}

function luminance(rgb) {
  const linear = rgb.map(srgbLinear);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function rgbToLab(rgb) {
  const [r, g, b] = rgb.map(srgbLinear);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (value) => value > 216 / 24389 ? Math.cbrt(value) : (24389 / 27 * value + 16) / 116;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function srgbLinear(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function deltaE00(lab1, lab2) {
  const [l1, a1, b1] = lab1;
  const [l2, a2, b2] = lab2;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const ap1 = (1 + g) * a1;
  const ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1);
  const cp2 = Math.hypot(ap2, b2);
  const hp = (a, b) => {
    if (a === 0 && b === 0) return 0;
    const degrees = Math.atan2(b, a) * 180 / Math.PI;
    return degrees < 0 ? degrees + 360 : degrees;
  };
  const hp1 = hp(ap1, b1);
  const hp2 = hp(ap2, b2);
  const dl = l2 - l1;
  const dc = cp2 - cp1;
  let dh = hp2 - hp1;
  if (cp1 * cp2 === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin(dh * Math.PI / 360);
  const lBar = (l1 + l2) / 2;
  const cpBar = (cp1 + cp2) / 2;
  let hBar = hp1 + hp2;
  if (cp1 * cp2 === 0) hBar = hp1 + hp2;
  else if (Math.abs(hp1 - hp2) <= 180) hBar /= 2;
  else if (hBar < 360) hBar = (hBar + 360) / 2;
  else hBar = (hBar - 360) / 2;
  const t = 1 - 0.17 * Math.cos((hBar - 30) * Math.PI / 180)
    + 0.24 * Math.cos(2 * hBar * Math.PI / 180)
    + 0.32 * Math.cos((3 * hBar + 6) * Math.PI / 180)
    - 0.2 * Math.cos((4 * hBar - 63) * Math.PI / 180);
  const sl = 1 + 0.015 * (lBar - 50) ** 2 / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cpBar;
  const sh = 1 + 0.015 * cpBar * t;
  const rt = -2 * Math.sqrt(cpBar ** 7 / (cpBar ** 7 + 25 ** 7))
    * Math.sin(60 * Math.exp(-(((hBar - 275) / 25) ** 2)) * Math.PI / 180);
  const x = dl / sl;
  const y = dc / sc;
  const z = dH / sh;
  return Math.sqrt(x * x + y * y + z * z + rt * y * z);
}

function percentile(sorted, p) {
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
