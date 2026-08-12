import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("desktop exposes complete batch, calibration and update lifecycles", async () => {
  const [contracts, preload, app, calibration, batch, updater] = await Promise.all([
    readFile("src/shared/contracts.ts", "utf8"),
    readFile("src/preload/index.ts", "utf8"),
    readFile("src/renderer/src/App.tsx", "utf8"),
    readFile("src/main/calibration-profile-service.ts", "utf8"),
    readFile("src/main/batch-service.ts", "utf8"),
    readFile("src/main/update-service.ts", "utf8"),
  ]);
  for (const format of ["tiff", "jpeg", "heif", "dng"]) assert.match(contracts, new RegExp(`"${format}"`));
  assert.match(preload, /startBatchExport/);
  assert.match(batch, /format === "jpeg"[\s\S]*format === "heif"/);
  for (const operation of ["exportCalibrationProfile", "deleteCalibrationProfile", "listCalibrationProfileVersions", "restoreCalibrationProfileVersion"]) {
    assert.match(preload, new RegExp(operation));
  }
  assert.match(calibration, /archive\(current\)/);
  assert.match(calibration, /同一标定配置版本的内容不同/);
  assert.match(app, /formatUpdateStatus/);
  assert.match(updater, /failedLaunches >= 2/);
  assert.match(updater, /quitAndInstall\(true, true\)/);
});

test("Electron main entry uses CommonJS interop required by electron-updater", async () => {
  const [packageText, configuration] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("electron.vite.config.ts", "utf8"),
  ]);
  const packageDocument = JSON.parse(packageText) as { readonly main?: string };
  assert.equal(packageDocument.main, "./out/main/index.cjs");
  assert.match(configuration, /main:[\s\S]*format: "cjs"[\s\S]*entryFileNames: "\[name\]\.cjs"/);
});

test("GPU master and edge-aware demosaic are wired as production paths", async () => {
  const [app, ipc, worker, gpu] = await Promise.all([
    readFile("src/renderer/src/App.tsx", "utf8"),
    readFile("src/main/ipc.ts", "utf8"),
    readFile("native/raw-worker/src/main.cpp", "utf8"),
    readFile("src/renderer/src/gpu-film-pipeline.ts", "utf8"),
  ]);
  assert.match(app, /renderGpuMasterInTiles/);
  assert.match(app, /fallbackGpuMasterTiff/);
  assert.match(ipc, /evaluateColorTrust/);
  assert.match(ipc, /session\.writer\.cancel/);
  assert.match(worker, /kDemosaicName = "edge-aware-bayer-v2"/);
  assert.match(worker, /edgeAwareGreen/);
  assert.match(gpu, /float edgeAwareGreen/);
  assert.match(app, /collectPixels: false/);
});

test("keyboard and accessibility contract has in-app and full manual coverage", async () => {
  const [app, styles, manual] = await Promise.all([
    readFile("src/renderer/src/App.tsx", "utf8"),
    readFile("src/renderer/src/styles.css", "utf8"),
    readFile("docs/user-manual.md", "utf8"),
  ]);
  assert.match(app, /className="skip-link"/);
  assert.match(app, /aria-keyshortcuts/);
  assert.match(app, /role="status"/);
  assert.match(app, /ShortcutHelpDialog/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(styles, /focus-visible/);
  assert.match(manual, /Ctrl\+Shift\+E/);
  assert.match(manual, /色彩可信度/);
  assert.match(manual, /自动更新与回滚|更新、回滚与恢复/);
});
