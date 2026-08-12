#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { mkdir, writeFile } = require("node:fs/promises");
const { basename, dirname, join, resolve } = require("node:path");
const sharp = require("sharp");

const options = parseArgs(process.argv.slice(2));
const root = resolve(options.root ?? "artifacts/a7rv-e2e-work/masters");
const reportPath = resolve(options.report ?? "artifacts/a7rv-e2e/master-compatibility.json");
const requiredTools = new Set(String(options["require-tools"] ?? "").split(",").filter(Boolean));
const requireNative = options["require-native"] === true;
const artifacts = [
  ["tiff", join(root, "a7rv-positive.tiff")],
  ["jpeg", join(root, "a7rv-positive.jpg")],
  ["heif", join(root, "a7rv-positive.avif")],
  ["dng", join(root, "a7rv-positive.dng")],
].filter(([, path]) => existsSync(path));

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

async function main() {
  if (artifacts.length === 0) throw new Error(`No FilmLab masters found below ${root}.`);
  const results = [];
  for (const [format, path] of artifacts) {
    const metadata = await sharp(path, { failOn: "error", limitInputPixels: false }).metadata();
    if (!metadata.width || !metadata.height) throw new Error(`libvips could not decode dimensions for ${path}.`);
    results.push({ format, fileName: basename(path), tool: "sharp/libvips", status: "passed", width: metadata.width, height: metadata.height });
  }
  for (const tool of ["exiftool", "magick"]) {
    const available = commandAvailable(tool);
    if (!available && requiredTools.has(tool)) throw new Error(`Required compatibility tool is unavailable: ${tool}.`);
    for (const [format, path] of artifacts) {
      if (!available) {
        results.push({ format, fileName: basename(path), tool, status: "skipped", reason: "not installed" });
        continue;
      }
      const args = tool === "exiftool"
        ? ["-j", "-ImageWidth", "-ImageHeight", "-BitsPerSample", "-ICC_Profile:ProfileDescription", "-XMP:All", path]
        : ["identify", path];
      const run = spawnSync(tool, args, { encoding: "utf8", windowsHide: true });
      if (run.status !== 0) throw new Error(`${tool} rejected ${format}: ${run.stderr || run.stdout}`);
      results.push({ format, fileName: basename(path), tool, status: "passed", output: sanitizeOutput(run.stdout) });
    }
  }
  if (process.platform === "darwin" && commandAvailable("sips")) {
    for (const [format, path] of artifacts) {
      const run = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { encoding: "utf8" });
      if (requireNative && run.status !== 0) throw new Error(`macOS ImageIO rejected ${format}: ${run.stderr || run.stdout}`);
      results.push({
        format,
        fileName: basename(path),
        tool: "macOS sips/ImageIO",
        status: run.status === 0 ? "passed" : "unsupported",
        output: sanitizeOutput(run.stdout || run.stderr),
      });
    }
  } else if (process.platform === "win32") {
    for (const [format, path] of artifacts) {
      const escaped = path.replace(/'/g, "''");
      const script = `Add-Type -AssemblyName PresentationCore; $u=[Uri]'${escaped}'; $d=[System.Windows.Media.Imaging.BitmapDecoder]::Create($u,[System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat,[System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad); $f=$d.Frames[0]; Write-Output ($f.PixelWidth.ToString()+'x'+$f.PixelHeight.ToString())`;
      const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
      if (requireNative && run.status !== 0) throw new Error(`Windows WIC rejected ${format}: ${run.stderr || run.stdout}`);
      results.push({
        format,
        fileName: basename(path),
        tool: "Windows WIC",
        status: run.status === 0 ? "passed" : "unsupported",
        output: sanitizeOutput(run.stdout || run.stderr),
      });
    }
  } else if (requireNative) {
    throw new Error(`No required native compatibility probe is configured for ${process.platform}.`);
  }
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ schemaVersion: 1, platform: process.platform, arch: process.arch, results }, null, 2) + "\n");
  console.log(`Master compatibility checks passed: ${reportPath}`);
}

function commandAvailable(command) {
  const probe = spawnSync(command, command === "magick" ? ["-version"] : ["-ver"], { encoding: "utf8", windowsHide: true });
  return !probe.error && probe.status === 0;
}

function sanitizeOutput(value) {
  return String(value).split(root).join("<master-root>").trim().slice(0, 4_000);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current.startsWith("--")) throw new Error(`Unexpected argument: ${current}`);
    const key = current.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
