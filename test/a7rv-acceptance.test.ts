import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("A7R V acceptance uses Electron/native ARW rather than the retired Sharp TIFF benchmark", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.match(packageJson.scripts["acceptance:a7rv"] ?? "", /run-a7rv-acceptance\.cjs/);
  assert.match(packageJson.scripts["benchmark:raw"] ?? "", /run-a7rv-acceptance\.cjs/);
  await assert.rejects(readFile("scripts/benchmark-real-source.ts", "utf8"), /ENOENT/);
  const runner = await readFile("scripts/run-a7rv-acceptance.cjs", "utf8");
  assert.match(runner, /FILMLAB_A7RV_ACCEPTANCE_SPEC/);
  assert.match(runner, /source-changed/);
  assert.match(runner, /--disable-gpu/);
  assert.match(runner, /app-executable/);
});

test("real-camera workflow covers Windows x64 and both macOS architectures", async () => {
  const workflow = await readFile(".github/workflows/a7rv-acceptance.yml", "utf8");
  assert.match(workflow, /platform: win32[\s\S]*arch: x64/);
  assert.match(workflow, /platform: darwin[\s\S]*arch: x64/);
  assert.match(workflow, /platform: darwin[\s\S]*arch: arm64/);
  assert.match(workflow, /stability-cycles 10/);
  assert.match(workflow, /require-tools exiftool,magick/);
  assert.match(workflow, /require-native/);
  assert.match(workflow, /require-gpu/);
  assert.match(workflow, /verify-installed-release\.cjs/);
  assert.match(workflow, /--fixture-root "\$FILMLAB_A7RV_FIXTURE_ROOT"/);
});

test("A7R V performance baseline pins full dimensions, PTC identity and memory limits", async () => {
  const baseline = JSON.parse(await readFile("test-data/a7rv-acceptance-baseline.json", "utf8")) as {
    expectedFullDimensions: number[];
    photonTransferProfileId: string;
    limits: { observedPeakRssBytes: number; stabilityCycles: number };
  };
  assert.deepEqual(baseline.expectedFullDimensions, [9564, 6376]);
  assert.equal(baseline.photonTransferProfileId, "photons-to-photos:sony-ilce-7rm5:iso100:2026-06-24");
  assert.equal(baseline.limits.observedPeakRssBytes, 4 * 1024 * 1024 * 1024);
  assert.equal(baseline.limits.stabilityCycles, 10);
});
