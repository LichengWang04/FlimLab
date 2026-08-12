#!/usr/bin/env node

const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { createReadStream } = require("node:fs");
const { cp, mkdir, open, readFile, rename, rm, writeFile } = require("node:fs/promises");
const { basename, dirname, join, resolve } = require("node:path");

const repositoryRoot = resolve(__dirname, "..");
const options = parseArgs(process.argv.slice(2));
const fixtureRoot = resolve(options["fixture-root"] ?? join(repositoryRoot, "A7R5_RAW"));
const workRoot = resolve(options["work-root"] ?? join(repositoryRoot, "artifacts", "a7rv-e2e-work"));
const reportRoot = resolve(options["report-dir"] ?? join(repositoryRoot, "artifacts", "a7rv-e2e"));
const formats = (options.formats ?? "tiff,jpeg,heif,dng").split(",").filter(Boolean);
const requireGpu = options["require-gpu"] === true;
let acceptanceBaseline;

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

async function main() {
  acceptanceBaseline = JSON.parse(await readFile(join(repositoryRoot, "test-data", "a7rv-acceptance-baseline.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "test-data", "a7rv-local-manifest.json"), "utf8"));
  for (const expected of manifest.files) await verifyFixture(join(fixtureRoot, expected.name), expected);
  const fixture = manifest.files[0];
  if (!fixture) throw new Error("A7R V fixture manifest is empty.");
  const fixturePath = join(fixtureRoot, fixture.name);
  await verifyFixture(fixturePath, fixture);
  await rm(workRoot, { recursive: true, force: true });
  await mkdir(reportRoot, { recursive: true });
  const sourceOriginal = join(workRoot, "source-original", fixture.name);
  await mkdir(join(workRoot, "source-original"), { recursive: true });
  await cp(fixturePath, sourceOriginal);

  const projectA = join(workRoot, "project-a", "a7rv-acceptance.filmlab");
  const prepareSpec = join(workRoot, "prepare-spec.json");
  const prepareReport = join(reportRoot, `${process.platform}-${process.arch}-prepare.json`);
  await writeSpec(prepareSpec, {
    phase: "prepare",
    machineRoot: join(workRoot, "machine-a"),
    reportPath: prepareReport,
    sourcePath: sourceOriginal,
    projectPath: projectA,
    performanceLimits: performanceLimits(),
  });
  await runElectron(prepareSpec, []);

  const projectB = join(workRoot, "project-b", "a7rv-acceptance-copy.filmlab");
  await mkdir(join(workRoot, "project-b"), { recursive: true });
  await cp(projectA, projectB, { recursive: true });
  const movedRoot = join(workRoot, "source-moved", "nested");
  await mkdir(movedRoot, { recursive: true });
  const renamedSource = join(movedRoot, "renamed-a7rv-negative.ARW");
  await rename(sourceOriginal, renamedSource);
  const changedRoot = join(workRoot, "source-changed");
  await mkdir(changedRoot, { recursive: true });
  const changedSource = join(changedRoot, fixture.name);
  await cp(renamedSource, changedSource);
  const changedHandle = await open(changedSource, "r+");
  try {
    const byte = Buffer.alloc(1);
    await changedHandle.read(byte, 0, 1, 1024);
    byte[0] ^= 0xff;
    await changedHandle.write(byte, 0, 1, 1024);
  } finally {
    await changedHandle.close();
  }

  const resumeSpec = join(workRoot, "resume-spec.json");
  const resumeReport = join(reportRoot, `${process.platform}-${process.arch}-resume.json`);
  await writeSpec(resumeSpec, {
    phase: "resume",
    machineRoot: join(workRoot, "machine-b"),
    reportPath: resumeReport,
    projectPath: projectB,
    sourceSearchRoot: movedRoot,
    changedSourceRoot: changedRoot,
    outputDirectory: join(workRoot, "masters"),
    formats,
    expectedFullDimensions: acceptanceBaseline.expectedFullDimensions,
    performanceLimits: performanceLimits(),
  });
  await runElectron(resumeSpec, []);

  const stabilitySpec = join(workRoot, "stability-spec.json");
  const stabilityReport = join(reportRoot, `${process.platform}-${process.arch}-stability.json`);
  await writeSpec(stabilitySpec, {
    phase: "stability",
    machineRoot: join(workRoot, "machine-stability"),
    reportPath: stabilityReport,
    stabilitySourcePaths: manifest.files.map((entry) => join(fixtureRoot, entry.name)),
    stabilityCycles: Number(options["stability-cycles"] ?? acceptanceBaseline.limits.stabilityCycles),
    performanceLimits: performanceLimits(),
  });
  await runElectron(stabilitySpec, []);

  const rendererPath = join(repositoryRoot, "out", "renderer", "index.html");
  const gpuSpec = join(workRoot, "renderer-gpu-spec.json");
  const gpuReport = join(reportRoot, `${process.platform}-${process.arch}-renderer-gpu.json`);
  await writeSpec(gpuSpec, {
    phase: "renderer",
    machineRoot: join(workRoot, "renderer-gpu"),
    reportPath: gpuReport,
    rendererPath,
    expectedRendererBackend: requireGpu ? "webgl2" : "any",
  });
  await runElectron(gpuSpec, []);

  const cpuSpec = join(workRoot, "renderer-cpu-spec.json");
  const cpuReport = join(reportRoot, `${process.platform}-${process.arch}-renderer-no-gpu.json`);
  await writeSpec(cpuSpec, {
    phase: "renderer",
    machineRoot: join(workRoot, "renderer-cpu"),
    reportPath: cpuReport,
    rendererPath,
    expectedRendererBackend: "2d",
  });
  await runElectron(cpuSpec, ["--disable-gpu"]);

  const reports = await Promise.all([prepareReport, resumeReport, stabilityReport, gpuReport, cpuReport]
    .map(async (path) => JSON.parse(await readFile(path, "utf8"))));
  const summaryPath = join(reportRoot, `${process.platform}-${process.arch}-summary.json`);
  await writeFile(summaryPath, JSON.stringify({
    schemaVersion: 1,
    fixture: { name: fixture.name, size: fixture.size, sha256: fixture.sha256 },
    reports,
  }, null, 2) + "\n", "utf8");
  console.log(`A7R V acceptance passed: ${summaryPath}`);
}

function performanceLimits() {
  if (!acceptanceBaseline?.limits) throw new Error("A7R V acceptance baseline is unavailable.");
  return {
    previewMs: Number(options["preview-ms"] ?? acceptanceBaseline.limits.previewMs),
    exportMsPerFormat: Number(options["export-ms"] ?? acceptanceBaseline.limits.exportMsPerFormat),
    observedPeakRssBytes: Number(options["peak-rss-bytes"] ?? acceptanceBaseline.limits.observedPeakRssBytes),
    stabilityRssGrowthBytes: Number(options["rss-growth-bytes"] ?? acceptanceBaseline.limits.stabilityRssGrowthBytes),
  };
}

async function runElectron(specPath, extraArgs) {
  const electron = require("electron");
  await new Promise((resolvePromise, reject) => {
    const child = spawn(electron, [...extraArgs, repositoryRoot], {
      cwd: repositoryRoot,
      env: { ...process.env, FILMLAB_A7RV_ACCEPTANCE_SPEC: specPath },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Electron acceptance phase ${basename(specPath)} exited ${String(code)} (${String(signal)}).`));
    });
  });
}

async function writeSpec(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function verifyFixture(path, expected) {
  const digest = await new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
  if (digest !== expected.sha256) throw new Error(`${expected.name} does not match the approved SHA-256.`);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current.startsWith("--")) throw new Error(`Unexpected argument: ${current}`);
    const key = current.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
