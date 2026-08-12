import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CalibrationProfileService } from "../src/main/calibration-profile-service.ts";

test("calibration profile import validates, stores and reloads renderer-safe summaries", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "filmlab-calibration-"));
  context.after(async () => rm(root, { force: true, recursive: true }));
  const sourcePath = join(root, "input-profile.json");
  await writeFile(sourcePath, JSON.stringify(validProfile()));

  const service = new CalibrationProfileService(join(root, "profiles"));
  const summary = await service.importFromFile(sourcePath);
  assert.equal(summary.id, "portra-400-studio-a");
  assert.equal(summary.label, "Portra 400 · Studio A");
  assert.equal(summary.hasLut, false);
  assert.equal(summary.version, "1.0.0");

  const reloaded = new CalibrationProfileService(join(root, "profiles"));
  const profiles = await reloaded.list();
  assert.deepEqual(profiles, [summary]);
  assert.equal((await reloaded.get(summary.id))?.capture.cameraModel, "Nikon Z7 II");

  const profileFiles = await readdir(join(root, "profiles"));
  assert.equal(profileFiles.length, 1);
  const stored = await readFile(join(root, "profiles", profileFiles[0]), "utf8");
  assert.doesNotMatch(stored, /input-profile\.json/);
});

test("calibration profiles archive versions, restore them and delete their history", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "filmlab-calibration-history-"));
  context.after(async () => rm(root, { force: true, recursive: true }));
  const service = new CalibrationProfileService(join(root, "profiles"));
  await service.importSerialized(JSON.stringify(validProfile()));
  const version2 = {
    ...validProfile(),
    version: "2.0.0",
    createdAt: "2026-08-13T12:00:00.000Z",
    calibrationId: "studio-a-2026-08",
  };
  await service.importSerialized(JSON.stringify(version2));

  const versions = await service.listVersions("portra-400-studio-a");
  assert.deepEqual(versions.map((entry) => [entry.version, entry.current]), [
    ["2.0.0", true],
    ["1.0.0", false],
  ]);
  const restored = await service.restoreVersion("portra-400-studio-a", "1.0.0");
  assert.equal(restored.version, "1.0.0");
  assert.equal((await service.get(restored.id))?.calibrationId, "studio-a-2026-07");
  assert.deepEqual((await service.listVersions(restored.id)).map((entry) => entry.version), ["2.0.0", "1.0.0"]);

  assert.equal(await service.delete(restored.id), true);
  assert.deepEqual(await service.list(), []);
  assert.deepEqual(await service.listVersions(restored.id), []);
});

test("calibration import rejects changed contents under the same version", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "filmlab-calibration-conflict-"));
  context.after(async () => rm(root, { force: true, recursive: true }));
  const service = new CalibrationProfileService(join(root, "profiles"));
  await service.importSerialized(JSON.stringify(validProfile()));
  await assert.rejects(
    service.importSerialized(JSON.stringify({ ...validProfile(), calibrationId: "different" })),
    /version/,
  );
});

function validProfile(): object {
  const curve = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  return {
    schema: "filmlab.calibration-profile",
    schemaVersion: 1,
    id: "portra-400-studio-a",
    name: "Portra 400 · Studio A",
    version: "1.0.0",
    calibrationId: "studio-a-2026-07",
    createdAt: "2026-07-13T12:00:00.000Z",
    captureFingerprint: "z7ii|105mm|light-a|c41",
    capture: {
      cameraModel: "Nikon Z7 II",
      lens: "Micro 105mm",
      filmStock: "Portra 400",
      process: "C-41",
      illuminationId: "light-a",
      decoderFingerprint: "libraw-0.22.1+edge-aware-bayer-v2",
      demosaic: "edge-aware-bayer-v2",
    },
    transform: {
      sourceDomain: "relative-density-log10",
      targetColorSpace: "linear-srgb-d65",
      curves: [curve, curve, curve],
      matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    },
    fit: {
      algorithm: "weighted-ridge-3x3-no-intercept-v1",
      patchCount: 24,
    },
  };
}
