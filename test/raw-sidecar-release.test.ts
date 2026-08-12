import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const rawSidecar = require("../scripts/verify-raw-sidecar.cjs") as {
  normaliseArch(arch: string | number): string;
  platformArch(platform: string, arch: string | number): string;
  relativeWorkerPath(platform: string, arch: string | number): string;
  resolveCliTarget(
    options: { platform?: string; arch?: string },
    host: { platform: string; arch: string },
  ): { platform: string; arch: string };
  sourceWorkerPath(root: string, platform: string, arch: string | number): string;
};

test("RAW release paths match the runtime resolver's platform-arch layout", () => {
  assert.equal(rawSidecar.platformArch("win32", 1), "win32-x64");
  assert.equal(rawSidecar.platformArch("darwin", "arm64"), "darwin-arm64");
  assert.equal(rawSidecar.relativeWorkerPath("win32", "x64"), join("raw-worker", "win32-x64", "filmlab-raw-worker.exe"));
  assert.equal(rawSidecar.relativeWorkerPath("linux", "x64"), join("raw-worker", "linux-x64", "filmlab-raw-worker"));
  assert.equal(
    rawSidecar.sourceWorkerPath("C:/FilmLab", "darwin", "x64"),
    join("C:/FilmLab", "native", "raw-worker", "out", "darwin-x64", "filmlab-raw-worker"),
  );
});

test("RAW release path guard rejects architectures without a sidecar build", () => {
  assert.equal(rawSidecar.normaliseArch(3), "arm64");
  assert.throws(() => rawSidecar.platformArch("linux", "ia32"), /not built for architecture/);
  assert.throws(() => rawSidecar.platformArch("freebsd", "x64"), /not configured/);
});

test("RAW sidecar CLI defaults to the current host target", () => {
  assert.deepEqual(
    rawSidecar.resolveCliTarget({}, { platform: "win32", arch: "x64" }),
    { platform: "win32", arch: "x64" },
  );
  assert.deepEqual(
    rawSidecar.resolveCliTarget(
      { platform: "darwin", arch: "arm64" },
      { platform: "win32", arch: "x64" },
    ),
    { platform: "darwin", arch: "arm64" },
  );
});

test("electron-builder validates the RAW sidecar before and after package copy", async () => {
  const configuration = await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.match(configuration, /^beforePack: \.\/scripts\/verify-raw-sidecar\.cjs$/m);
  assert.match(configuration, /^afterPack: \.\/scripts\/verify-raw-sidecar\.cjs$/m);
  assert.match(configuration, /from: native\/raw-worker\/out/);
  assert.match(configuration, /to: raw-worker/);
});

test("release configuration produces native installers with explicit lifecycle metadata", async () => {
  const configuration = await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.match(configuration, /^productName: FilmLab$/m);
  assert.match(configuration, /^copyright: /m);
  assert.match(configuration, /win:[\s\S]*target:\n\s+- nsis/);
  assert.match(configuration, /mac:[\s\S]*notarize: true[\s\S]*target:\n\s+- dmg/);
  assert.match(configuration, /linux:[\s\S]*target:\n\s+- AppImage/);
  assert.match(configuration, /allowToChangeInstallationDirectory: true/);
  assert.match(configuration, /deleteAppDataOnUninstall: false/);
  assert.match(configuration, /build\/generated\/icon\.(?:ico|icns|png)/);
});

test("release CI installs packages and gates tagged publication on signatures", async () => {
  const workflow = await readFile(new URL("../.github/workflows/raw-sidecar-release.yml", import.meta.url), "utf8");
  assert.match(workflow, /verify-installed-release\.cjs/);
  assert.match(workflow, /Get-AuthenticodeSignature/);
  assert.match(workflow, /codesign --verify --deep --strict/);
  assert.match(workflow, /xcrun stapler validate/);
  assert.match(workflow, /publish-release:/);
  assert.match(workflow, /SHA256SUMS/);
});

test("RAW release manifest pins the LibRaw build input", async () => {
  const manifest = JSON.parse(await readFile(new URL("../native/raw-worker/vcpkg.json", import.meta.url), "utf8")) as {
    "builtin-baseline": string;
    overrides: readonly { name: string; version: string }[];
  };
  assert.match(manifest["builtin-baseline"], /^[0-9a-f]{40}$/);
  assert.deepEqual(manifest.overrides.find((entry) => entry.name === "libraw"), {
    name: "libraw",
    version: "0.22.1",
  });
});

test("RAW sidecar exposes compact Bayer16 output for the GPU demosaic path", async () => {
  const source = await readFile(
    new URL("../native/raw-worker/src/main.cpp", import.meta.url),
    "utf8",
  );
  assert.match(source, /gpu-bayer-v1/);
  assert.match(source, /filmlab-bayer16le-v1/);
  assert.match(source, /"camera-linear-bayer"/);
  assert.match(source, /sampleStride % 2 == 0/);
  assert.match(source, /\{"bayerPattern", gpuBayer \? rgbPattern/);
  assert.match(source, /normalizationRangeDnRgb/);
  assert.match(source, /raw\.imgdata\.other\.iso_speed/);
});
