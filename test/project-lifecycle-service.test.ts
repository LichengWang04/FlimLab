import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CalibrationProfileService } from "../src/main/calibration-profile-service.ts";
import { ProjectLifecycleService } from "../src/main/project-lifecycle-service.ts";
import { createDefaultProject } from "../src/main/project-service.ts";
import { projectSchemaVersion, type WorkspaceProjectDraft } from "../src/shared/project.ts";

test("project lifecycle reopens arbitrary bundles and supports read-only save-as", async (context) => {
  const root = await temporaryRoot(context);
  const lifecycle = createLifecycle(root, "profiles-a");
  const created = await lifecycle.create(join(root, "archive.filmlab"));
  const edited = withExposure(created.project, 0.75);
  await lifecycle.save(created.session.id, edited);

  const restarted = createLifecycle(root, "profiles-a");
  const loaded = await restarted.loadStartup();
  assert.equal(loaded.session.name, "archive");
  assert.equal(loaded.project.recipe.tone.exposureStops, 0.75);
  assert.equal(loaded.recentProjects[0]?.available, true);

  const readOnly = await restarted.open(join(root, "archive.filmlab"), true);
  assert.equal(readOnly.session.readOnly, true);
  await assert.rejects(
    restarted.save(readOnly.session.id, withExposure(readOnly.project, 1)),
    /只读/,
  );
  await assert.rejects(restarted.createBackup(readOnly.session.id), /只读/);

  const copied = await restarted.saveAs(
    readOnly.session.id,
    withExposure(readOnly.project, 1.25),
    join(root, "archive-copy"),
  );
  assert.equal(copied.session.name, "archive-copy");
  assert.equal(copied.session.readOnly, false);
  assert.equal(copied.project.recipe.tone.exposureStops, 1.25);
});

test("reopening the same directory invalidates delayed writes from its older session", async (context) => {
  const root = await temporaryRoot(context);
  const lifecycle = createLifecycle(root, "profiles-a");
  const first = await lifecycle.create(join(root, "session.filmlab"));
  const other = await lifecycle.create(join(root, "other.filmlab"));
  assert.notEqual(other.session.id, first.session.id);
  const reopened = await lifecycle.open(join(root, "session.filmlab"), false);
  assert.equal(reopened.session.projectId, first.session.projectId);
  assert.notEqual(reopened.session.id, first.session.id);
  await assert.rejects(
    lifecycle.save(first.session.id, withExposure(first.project, 2)),
    /会话已切换/,
  );
});

test("project migration requires confirmation and preserves the original document", async (context) => {
  const root = await temporaryRoot(context);
  const bundle = join(root, "legacy.filmlab");
  await mkdir(bundle);
  await writeFile(join(bundle, "project.json"), JSON.stringify(legacyV2Project()), "utf8");

  const lifecycle = createLifecycle(root, "profiles-a");
  const loaded = await lifecycle.open(bundle, false);
  assert.equal(loaded.session.pendingAction, "migration");
  assert.equal(loaded.session.migratedFromVersion, 2);
  assert.equal(loaded.session.readOnly, true);
  await assert.rejects(lifecycle.save(loaded.session.id, loaded.project), /确认项目迁移/);

  const confirmed = await lifecycle.confirmPending(loaded.session.id, loaded.project);
  assert.equal(confirmed.session.pendingAction, undefined);
  assert.equal(confirmed.session.readOnly, false);
  assert.equal(confirmed.session.backupCount, 1);
  const stored = JSON.parse(await readFile(join(bundle, "project.json"), "utf8")) as { schemaVersion: number };
  assert.equal(stored.schemaVersion, projectSchemaVersion);
  const backupDirectory = (await readdir(join(bundle, "backups")))[0];
  const original = JSON.parse(await readFile(join(bundle, "backups", backupDirectory!, "project.json"), "utf8")) as {
    schemaVersion: number;
  };
  assert.equal(original.schemaVersion, 2);
});

test("corrupt projects recover read-only from the newest valid backup", async (context) => {
  const root = await temporaryRoot(context);
  const bundle = join(root, "recovery.filmlab");
  const lifecycle = createLifecycle(root, "profiles-a");
  const created = await lifecycle.create(bundle);
  const quarter = (await lifecycle.save(created.session.id, withExposure(created.project, 0.25))).project;
  await lifecycle.createBackup(created.session.id);
  const half = (await lifecycle.save(created.session.id, withExposure(quarter, 0.5))).project;
  for (const name of await readdir(join(bundle, "backups"))) {
    await writeFile(
      join(bundle, "backups", name, "backup.json"),
      JSON.stringify({ schemaVersion: 1, kind: "manual", createdAt: "2000-01-01T00:00:00.000Z" }),
      "utf8",
    );
  }
  await lifecycle.save(created.session.id, withExposure(half, 0.75));
  await writeFile(join(bundle, "project.json"), "{not-json", "utf8");

  const restarted = createLifecycle(root, "profiles-a");
  const recovered = await restarted.open(bundle, false);
  assert.equal(recovered.session.pendingAction, "recovery");
  assert.equal(recovered.session.readOnly, true);
  assert.equal(recovered.project.recipe.tone.exposureStops, 0.5);

  const confirmed = await restarted.confirmPending(recovered.session.id, recovered.project);
  assert.equal(confirmed.session.pendingAction, undefined);
  assert.equal(confirmed.session.readOnly, false);
  const stored = JSON.parse(await readFile(join(bundle, "project.json"), "utf8")) as { schemaVersion: number };
  assert.equal(stored.schemaVersion, projectSchemaVersion);
});

test("project bundles carry calibration snapshots that restore on another machine", async (context) => {
  const root = await temporaryRoot(context);
  const sourceProfiles = new CalibrationProfileService(join(root, "profiles-a"));
  await sourceProfiles.importSerialized(JSON.stringify(validProfile()));
  const lifecycle = new ProjectLifecycleService(
    join(root, "projects"),
    join(root, "state-a.json"),
    sourceProfiles,
  );
  const bundle = join(root, "calibrated.filmlab");
  const created = await lifecycle.create(bundle);
  await lifecycle.save(created.session.id, {
    ...draftOf(created.project),
    recipe: {
      ...created.project.recipe,
      mode: "calibrated",
      calibrationProfileId: "a7rv-studio",
    },
  });
  assert.equal((await readdir(join(bundle, "calibration-profiles"))).length, 1);

  const destinationProfiles = new CalibrationProfileService(join(root, "profiles-b"));
  const destinationLifecycle = new ProjectLifecycleService(
    join(root, "projects"),
    join(root, "state-b.json"),
    destinationProfiles,
  );
  const opened = await destinationLifecycle.open(bundle, false);
  assert.deepEqual(opened.restoredCalibrationProfileIds, ["a7rv-studio"]);
  assert.equal((await destinationProfiles.list())[0]?.id, "a7rv-studio");
});

function createLifecycle(root: string, profileDirectory: string): ProjectLifecycleService {
  return new ProjectLifecycleService(
    join(root, "projects"),
    join(root, "state.json"),
    new CalibrationProfileService(join(root, profileDirectory)),
  );
}

async function temporaryRoot(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "filmlab-lifecycle-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

function draftOf(project = createDefaultProject()): WorkspaceProjectDraft {
  return {
    rolls: project.rolls,
    activeRollId: project.activeRollId,
    recipe: project.recipe,
    presets: project.presets,
  };
}

function withExposure(project: ReturnType<typeof createDefaultProject>, exposureStops: number): WorkspaceProjectDraft {
  return {
    ...draftOf(project),
    recipe: {
      ...project.recipe,
      tone: { ...project.recipe.tone, exposureStops },
    },
  };
}

function legacyV2Project(): object {
  return {
    schemaVersion: 2,
    title: "旧胶卷",
    assets: [],
    recipe: {
      mode: "generic",
      view: "positive",
      tone: { exposureStops: 0, contrast: 1, highlightCompression: 0, saturation: 1 },
    },
    presets: [],
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function validProfile(): object {
  const curve = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  return {
    schema: "filmlab.calibration-profile",
    schemaVersion: 1,
    id: "a7rv-studio",
    name: "Sony A7R V Studio",
    version: "1.0.0",
    calibrationId: "studio-2026-08",
    createdAt: "2026-08-01T00:00:00.000Z",
    captureFingerprint: "a7rv|macro|light-a|c41",
    capture: {
      cameraModel: "Sony ILCE-7RM5",
      lens: "90mm Macro",
      filmStock: "Portra 400",
      process: "C-41",
      illuminationId: "light-a",
      decoderFingerprint: "libraw-test",
      demosaic: "bilinear-bayer-v1",
    },
    transform: {
      sourceDomain: "relative-density-log10",
      targetColorSpace: "linear-srgb-d65",
      curves: [curve, curve, curve],
      matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    },
    fit: { algorithm: "weighted-ridge-3x3-no-intercept-v1", patchCount: 24 },
  };
}
