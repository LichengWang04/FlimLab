import { BrowserWindow } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type { CalibrationProfileDocument } from "../core/calibration.ts";
import { defaultProcessingRecipe, type MasterExportFormat, type PreviewRequest } from "../shared/contracts.ts";
import type { ProjectRecipe, WorkspaceProjectDraft } from "../shared/project.ts";
import { CalibrationProfileService } from "./calibration-profile-service.ts";
import { validateMasterArtifact } from "./master-artifact-validator.ts";
import { ProcessingService } from "./processing-service.ts";
import { ProjectLifecycleService } from "./project-lifecycle-service.ts";
import { SourceRegistry } from "./source-registry.ts";

interface A7rvAcceptanceSpec {
  readonly phase: "prepare" | "resume" | "renderer" | "stability";
  readonly machineRoot: string;
  readonly reportPath: string;
  readonly sourcePath?: string;
  readonly sourceSearchRoot?: string;
  readonly changedSourceRoot?: string;
  readonly projectPath?: string;
  readonly outputDirectory?: string;
  readonly formats?: readonly MasterExportFormat[];
  readonly expectedFullDimensions?: readonly [number, number];
  readonly expectedRendererBackend?: "webgl2" | "2d" | "any";
  readonly rendererPath?: string;
  readonly stabilitySourcePaths?: readonly string[];
  readonly stabilityCycles?: number;
  readonly performanceLimits?: {
    readonly previewMs?: number;
    readonly exportMsPerFormat?: number;
    readonly observedPeakRssBytes?: number;
    readonly stabilityRssGrowthBytes?: number;
  };
}

export async function runA7rvAcceptanceFromEnvironment(specPath: string): Promise<void> {
  const spec = parseSpec(JSON.parse(await readFile(resolve(specPath), "utf8")));
  await mkdir(dirname(spec.reportPath), { recursive: true });
  const report = spec.phase === "renderer"
    ? await runRendererCheck(spec)
    : await runNativePhase(spec);
  await writeFile(spec.reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
}

async function runNativePhase(spec: A7rvAcceptanceSpec): Promise<object> {
  const sourceRegistry = new SourceRegistry(join(spec.machineRoot, "source-locations-v1.json"));
  const calibrationProfiles = new CalibrationProfileService(join(spec.machineRoot, "calibration-profiles"));
  const projects = new ProjectLifecycleService(
    join(spec.machineRoot, "projects"),
    join(spec.machineRoot, "project-sessions-v1.json"),
    calibrationProfiles,
  );
  const processing = new ProcessingService(
    "FilmLab A7R V acceptance worker",
    false,
    0,
    join(spec.machineRoot, "preview-cache"),
  );
  try {
    if (spec.phase === "prepare") {
      return await prepareProject(spec, sourceRegistry, calibrationProfiles, projects, processing);
    }
    if (spec.phase === "stability") return await runStability(spec, processing);
    return await resumeAndExport(spec, sourceRegistry, calibrationProfiles, projects, processing);
  } finally {
    processing.shutdown();
  }
}

async function runStability(spec: A7rvAcceptanceSpec, processing: ProcessingService): Promise<object> {
  const sourcePaths = spec.stabilitySourcePaths?.map((path) => resolve(path)) ?? [];
  const cycles = spec.stabilityCycles ?? 3;
  if (sourcePaths.length < 2 || !Number.isSafeInteger(cycles) || cycles < 1 || cycles > 100) {
    throw new Error("Stability acceptance requires at least two sources and 1–100 cycles.");
  }
  const cycleReports = [];
  let firstCycleRss: number | undefined;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const started = performance.now();
    for (let index = 0; index < sourcePaths.length; index += 1) {
      const sourcePath = sourcePaths[index]!;
      const assetId = `stability-${index}`;
      const decoded = await processing.inspectSource(assetId, sourcePath, 1_024, false);
      assertA7rvDecode(decoded);
      await processing.render(assetId, sourcePath, {
        revision: cycle * sourcePaths.length + index,
        assetId,
        maxEdge: 1_024,
        mode: "generic",
        view: "positive",
        tone: { exposureStops: 0, contrast: 1, highlightCompression: 0.35, saturation: 1 },
        processing: defaultProcessingRecipe,
      });
      await processing.release(assetId);
    }
    const telemetry = processing.telemetry();
    firstCycleRss ??= telemetry?.rssBytes;
    cycleReports.push({
      cycle: cycle + 1,
      milliseconds: Math.round(performance.now() - started),
      rssBytes: telemetry?.rssBytes,
      observedPeakRssBytes: telemetry?.observedPeakRssBytes,
    });
  }
  const telemetry = processing.telemetry();
  const growth = telemetry === undefined || firstCycleRss === undefined ? undefined : telemetry.rssBytes - firstCycleRss;
  const maximumGrowth = spec.performanceLimits?.stabilityRssGrowthBytes;
  if (growth !== undefined && maximumGrowth !== undefined && growth > maximumGrowth) {
    throw new Error(`Utility RSS grew ${growth} bytes across stability cycles; limit is ${maximumGrowth}.`);
  }
  return {
    schemaVersion: 1,
    phase: "stability",
    platform: process.platform,
    arch: process.arch,
    sourceCount: sourcePaths.length,
    cycles,
    operations: sourcePaths.length * cycles,
    rssGrowthBytes: growth,
    cycleReports,
    telemetry,
  };
}

async function prepareProject(
  spec: A7rvAcceptanceSpec,
  sources: SourceRegistry,
  profiles: CalibrationProfileService,
  projects: ProjectLifecycleService,
  processing: ProcessingService,
): Promise<object> {
  const sourcePath = requirePath(spec.sourcePath, "sourcePath");
  const projectPath = requirePath(spec.projectPath, "projectPath");
  const [asset] = await sources.register([sourcePath]);
  if (asset === undefined) throw new Error("A7R V source registration returned no asset.");
  const bayerStarted = performance.now();
  const bayerDecoded = await processing.inspectSource(asset.id, sourcePath, 1_440, true);
  const bayerDecodeMs = performance.now() - bayerStarted;
  assertA7rvDecode(bayerDecoded);
  if (bayerDecoded.sourceDomain !== "camera-linear-bayer") {
    throw new Error(`GPU acceptance expected Bayer source, received ${bayerDecoded.sourceDomain}.`);
  }
  const provisionalProfile = acceptanceProfile(bayerDecoded.camera?.model!, bayerDecoded.decoderFingerprint!);
  const gpuPayloadPreview = await processing.render(asset.id, sourcePath, {
    ...previewRequest(acceptanceRecipe(provisionalProfile.id)),
    gpuInteractive: true,
  }, provisionalProfile);
  if (gpuPayloadPreview.gpuPipeline?.sourceBayer === undefined) {
    throw new Error("A7R V GPU preview did not receive the native Bayer payload.");
  }
  const decodeStarted = performance.now();
  const decoded = await processing.inspectSource(asset.id, sourcePath, 1_440, false);
  const decodeMs = performance.now() - decodeStarted;
  assertA7rvDecode(decoded);
  const profile = acceptanceProfile(decoded.camera?.model!, decoded.decoderFingerprint!);
  await profiles.saveGenerated(profile);
  const created = await projects.create(projectPath);
  const recipe = acceptanceRecipe(profile.id);
  const draft: WorkspaceProjectDraft = {
    rolls: [{
      id: "a7rv-acceptance-roll",
      title: "A7R V acceptance",
      assets: [asset],
      frameOrder: [asset.id],
      recipesByFrameId: { [asset.id]: recipe },
    }],
    activeRollId: "a7rv-acceptance-roll",
    recipe,
    presets: [],
  };
  const saved = await projects.save(created.session.id, draft);
  const previewStarted = performance.now();
  const preview = await processing.render(asset.id, sourcePath, previewRequest(recipe), profile);
  const previewMs = performance.now() - previewStarted;
  assertPerformance("preview", previewMs, spec.performanceLimits?.previewMs);
  if (preview.colorTrust.level !== "device-matched") throw new Error("Acceptance preview is not device-matched.");
  return {
    schemaVersion: 1,
    phase: "prepare",
    platform: process.platform,
    arch: process.arch,
    source: { name: asset.name, identity: asset.identity },
    decode: {
      decoder: decoded.decoder,
      decoderFingerprint: decoded.decoderFingerprint,
      camera: decoded.camera,
      dimensions: [decoded.width, decoded.height],
      photonTransferProfileId: decoded.photonTransfer?.profileId,
      milliseconds: Math.round(decodeMs),
    },
    gpuBayer: {
      dimensions: [bayerDecoded.width, bayerDecoded.height],
      milliseconds: Math.round(bayerDecodeMs),
      payloadSamples: gpuPayloadPreview.gpuPipeline.sourceBayer.length,
    },
    preview: {
      dimensions: [preview.width, preview.height],
      milliseconds: Math.round(previewMs),
      colorTrust: preview.colorTrust,
      photonTransferProfileId: preview.photonTransfer?.profileId,
    },
    project: {
      name: created.session.name,
      schemaVersion: saved.project.schemaVersion,
      exposureStops: saved.project.recipe.tone.exposureStops,
      calibrationProfileId: saved.project.recipe.calibrationProfileId,
      backupCount: saved.backupCount,
    },
    telemetry: processing.telemetry(),
  };
}

async function resumeAndExport(
  spec: A7rvAcceptanceSpec,
  sources: SourceRegistry,
  profiles: CalibrationProfileService,
  projects: ProjectLifecycleService,
  processing: ProcessingService,
): Promise<object> {
  const projectPath = requirePath(spec.projectPath, "projectPath");
  const searchRoot = requirePath(spec.sourceSearchRoot, "sourceSearchRoot");
  const changedRoot = requirePath(spec.changedSourceRoot, "changedSourceRoot");
  const outputDirectory = requirePath(spec.outputDirectory, "outputDirectory");
  const loaded = await projects.open(projectPath, false);
  const assets = loaded.project.rolls.flatMap((roll) => roll.assets);
  const initiallyRestored = await sources.restore(assets);
  if (initiallyRestored.missingAssets.length !== assets.length) {
    throw new Error("Copied-machine acceptance unexpectedly inherited a private source path.");
  }
  const changedOnly = await sources.relinkDirectories(assets, [changedRoot]);
  if (changedOnly.relinkedAssetIds.length !== 0 || changedOnly.missingAssets.length !== assets.length) {
    throw new Error("Content-changed source was incorrectly accepted as the archived source.");
  }
  const relinked = await sources.relinkDirectories(assets, [searchRoot]);
  if (relinked.missingAssets.length > 0 || relinked.relinkedAssetIds.length !== assets.length) {
    throw new Error("Moved/renamed A7R V source did not reconnect by content identity.");
  }
  const asset = assets[0];
  if (asset === undefined) throw new Error("Copied project has no A7R V source.");
  const sourcePath = sources.getPath(asset.id);
  if (sourcePath === undefined) throw new Error("Relinked source path is unavailable.");
  const recipe = loaded.project.recipe;
  if (recipe.tone.exposureStops !== 0.35 || recipe.calibrationProfileId === undefined) {
    throw new Error("Saved acceptance recipe did not survive project restart/copy.");
  }
  const profile = await profiles.get(recipe.calibrationProfileId);
  if (profile === undefined || !loaded.restoredCalibrationProfileIds.includes(profile.id)) {
    throw new Error("Project-owned calibration snapshot was not restored on the copied machine.");
  }
  const decoded = await processing.inspectSource(asset.id, sourcePath, 1_440, false);
  assertA7rvDecode(decoded);
  const previewStarted = performance.now();
  const preview = await processing.render(asset.id, sourcePath, previewRequest(recipe), profile);
  const previewMs = performance.now() - previewStarted;
  assertPerformance("restart preview", previewMs, spec.performanceLimits?.previewMs);
  await processing.simulateCrashForAcceptance();
  const restartedDecode = await processing.inspectSource(asset.id, sourcePath, 1_440, false);
  assertA7rvDecode(restartedDecode);
  await mkdir(outputDirectory, { recursive: true });
  const artifacts = [];
  for (const format of spec.formats ?? ["tiff", "jpeg", "heif", "dng"]) {
    const extension = format === "jpeg" ? "jpg" : format === "heif" ? "avif" : format;
    const outputPath = join(outputDirectory, `a7rv-positive.${extension}`);
    const started = performance.now();
    const exported = await processing.exportTiff(asset.id, sourcePath, {
      outputPath,
      suggestedFileName: basename(outputPath),
      format,
      mode: recipe.mode,
      tone: recipe.tone,
      processing: recipe.processing,
      calibrationProfile: profile,
    });
    const milliseconds = performance.now() - started;
    const expectedDimensions = spec.expectedFullDimensions;
    if (expectedDimensions !== undefined && (
      exported.width !== expectedDimensions[0] || exported.height !== expectedDimensions[1]
    )) {
      throw new Error(`${format} export dimensions ${exported.width}x${exported.height} do not match the A7R V baseline.`);
    }
    assertPerformance(`${format} export`, milliseconds, spec.performanceLimits?.exportMsPerFormat);
    if (exported.colorTrust.level !== "device-matched") throw new Error(`${format} export is not device-matched.`);
    const validation = await validateMasterArtifact(outputPath, format, {
      width: exported.width,
      height: exported.height,
      xmpIncludes: ["FilmLab", "device-matched"],
    });
    artifacts.push({ format, fileName: basename(outputPath), milliseconds: Math.round(milliseconds), validation });
  }
  const telemetry = processing.telemetry();
  const rssLimit = spec.performanceLimits?.observedPeakRssBytes;
  if (telemetry !== undefined && rssLimit !== undefined && telemetry.observedPeakRssBytes > rssLimit) {
    throw new Error(`Observed utility RSS ${telemetry.observedPeakRssBytes} exceeds ${rssLimit}.`);
  }
  await processing.release(asset.id);
  return {
    schemaVersion: 1,
    phase: "resume",
    platform: process.platform,
    arch: process.arch,
    project: {
      schemaVersion: loaded.project.schemaVersion,
      restoredCalibrationProfileIds: loaded.restoredCalibrationProfileIds,
      sourceWasInitiallyMissing: initiallyRestored.missingAssets.length === assets.length,
      contentChangedSourceRejected: changedOnly.missingAssets.length === assets.length,
      relinkedAfterMoveAndRename: relinked.relinkedAssetIds,
    },
    preview: { dimensions: [preview.width, preview.height], milliseconds: Math.round(previewMs) },
    utilityCrashRecovered: true,
    artifacts,
    telemetry,
  };
}

async function runRendererCheck(spec: A7rvAcceptanceSpec): Promise<object> {
  const rendererPath = spec.rendererPath === undefined
    ? join(__dirname, "../renderer/index.html")
    : requirePath(spec.rendererPath, "rendererPath");
  const window = new BrowserWindow({
    width: 960,
    height: 640,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  await window.loadFile(rendererPath, { query: { "acceptance-web-demo": "" } });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 8_000));
    const diagnostics = await window.webContents.executeJavaScript(`(() => {
      const canvas = document.querySelector("canvas.preview-canvas");
      return canvas instanceof HTMLCanvasElement ? {
        backend: canvas.dataset.renderBackend ?? null,
        gpuError: canvas.dataset.gpuPipelineError ?? null,
        gpuMilliseconds: canvas.dataset.gpuMilliseconds ?? null,
        webgpuCompute: canvas.dataset.webgpuCompute ?? null
      } : { backend: null, gpuError: "preview canvas was not mounted" };
    })()`);
    const backend = (diagnostics as { backend?: unknown }).backend;
    const expected = spec.expectedRendererBackend ?? "any";
    if (typeof backend !== "string" || backend.length === 0) {
      throw new Error(`Renderer did not publish a backend: ${JSON.stringify(diagnostics)}.`);
    }
    const matches = expected === "any"
      || (expected === "webgl2" ? backend.startsWith("webgl2") : backend === expected);
    if (!matches) {
      throw new Error(`Renderer backend ${String(backend)} does not match required ${expected}.`);
    }
  return { schemaVersion: 1, phase: "renderer", platform: process.platform, arch: process.arch, diagnostics };
}

function acceptanceRecipe(profileId: string): ProjectRecipe {
  return {
    mode: "calibrated",
    view: "positive",
    tone: { exposureStops: 0.35, contrast: 1.08, highlightCompression: 0.35, saturation: 1 },
    calibrationProfileId: profileId,
    processing: defaultProcessingRecipe,
  };
}

function previewRequest(recipe: ProjectRecipe): PreviewRequest {
  return {
    revision: 1,
    assetId: "a7rv-e2e",
    maxEdge: 1_440,
    mode: recipe.mode,
    view: recipe.view,
    tone: recipe.tone,
    calibrationProfileId: recipe.calibrationProfileId,
    processing: recipe.processing,
  };
}

function acceptanceProfile(cameraModel: string, decoderFingerprint: string): CalibrationProfileDocument {
  const curve = [{ x: 0, y: 0 }, { x: 2, y: 2 }] as const;
  return {
    schema: "filmlab.calibration-profile",
    schemaVersion: 1,
    id: "a7rv-e2e-identity",
    name: "A7R V E2E identity transform (not a colour calibration)",
    version: "1.0.0",
    calibrationId: "acceptance-only",
    createdAt: new Date().toISOString(),
    captureFingerprint: `acceptance|${cameraModel}|${decoderFingerprint}`,
    capture: {
      cameraModel,
      decoderFingerprint,
      demosaic: decoderFingerprint.split("+").at(-1) ?? "edge-aware-bayer-v2",
    },
    transform: {
      sourceDomain: "relative-density-log10",
      targetColorSpace: "linear-srgb-d65",
      curves: [curve, curve, curve],
      matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    },
    fit: {
      algorithm: "e2e-identity-fixture-not-color-calibration",
      patchCount: 0,
      warnings: ["Acceptance-only profile. It must never be used for colour accuracy evaluation."],
    },
  };
}

function assertA7rvDecode(decoded: Awaited<ReturnType<ProcessingService["inspectSource"]>>): void {
  if (decoded.decoder !== "libraw-sidecar") throw new Error("A7R V acceptance did not use the LibRaw sidecar.");
  if (!/ILCE-7RM5/i.test(decoded.camera?.model ?? "")) throw new Error(`Unexpected camera model: ${decoded.camera?.model ?? "missing"}.`);
  if (decoded.decoderFingerprint === undefined) throw new Error("A7R V decode has no decoder fingerprint.");
  if (decoded.photonTransfer?.profileId !== "photons-to-photos:sony-ilce-7rm5:iso100:2026-06-24") {
    throw new Error(`A7R V ISO 100 PTC did not match: ${decoded.photonTransfer?.profileId ?? "none"}.`);
  }
}

function assertPerformance(label: string, actualMs: number, maximumMs: number | undefined): void {
  if (maximumMs !== undefined && actualMs > maximumMs) {
    throw new Error(`${label} took ${Math.round(actualMs)} ms; limit is ${maximumMs} ms.`);
  }
}

function requirePath(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) throw new Error(`Acceptance spec misses ${label}.`);
  return resolve(value);
}

function parseSpec(value: unknown): A7rvAcceptanceSpec {
  if (typeof value !== "object" || value === null) throw new Error("Acceptance spec must be an object.");
  const spec = value as A7rvAcceptanceSpec;
  if (!(["prepare", "resume", "renderer", "stability"] as const).includes(spec.phase)) throw new Error("Acceptance phase is invalid.");
  requirePath(spec.machineRoot, "machineRoot");
  requirePath(spec.reportPath, "reportPath");
  return spec;
}
