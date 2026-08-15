import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production renderer cannot initiate network connections while updates stay main-process-only", async () => {
  const html = await readFile("src/renderer/index.html", "utf8");
  assert.match(html, /default-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /base-uri 'none'/);
  assert.match(html, /object-src 'none'/);
  assert.doesNotMatch(html, /connect-src[^;]*(?:https?:|\bws:)/);

  const vite = await readFile("electron.vite.config.ts", "utf8");
  assert.match(vite, /context\.server === undefined/);
  assert.match(vite, /ws:\/\/localhost:\*/);
  assert.doesNotMatch(vite, /https:\/\//);

  const [updater, preload] = await Promise.all([
    readFile("src/main/update-service.ts", "utf8"),
    readFile("src/preload/index.ts", "utf8"),
  ]);
  assert.match(updater, /electron-updater/);
  assert.match(updater, /autoInstallOnAppQuit = false/);
  assert.match(updater, /lastKnownGoodVersion/);
  assert.doesNotMatch(preload, /https?:\/\//);
});

test("Electron keeps renderer permissions, navigation and Node access closed", async () => {
  const main = await readFile("src/main/index.ts", "utf8");
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /setPermissionRequestHandler[\s\S]*callback\(false\)/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(main, /will-navigate[^\n]*preventDefault/);
});

test("distribution includes proprietary and complete third-party legal material", async () => {
  const [license, notice, thirdParty, builder, native] = await Promise.all([
    readFile("LICENSE", "utf8"),
    readFile("NOTICE", "utf8"),
    readFile("THIRD_PARTY_NOTICES.md", "utf8"),
    readFile("electron-builder.yml", "utf8"),
    readFile("third-party/native-components.json", "utf8"),
  ]);
  assert.match(license, /All rights reserved/);
  assert.match(notice, /elects the COMMON DEVELOPMENT AND DISTRIBUTION LICENSE \(CDDL\) 1\.0/);
  assert.match(thirdParty, /`LibRaw` \| `0\.22\.1` \| CDDL-1\.0/);
  assert.match(native, /"license": "CDDL-1\.0"/);
  assert.match(builder, /from: build\/generated\/legal[\s\S]*to: legal/);
  for (const file of ["LibRaw-0.22.1.CDDL.txt", "LibRaw-0.22.1.COPYRIGHT.txt", "LibRaw-0.22.1.SOURCE.txt"]) {
    assert.match(await readFile(`third-party/native-licenses/${file}`, "utf8"), /\S/);
  }
});

test("LGPL platform packages receive complete standard license fallbacks", async () => {
  const generator = await readFile(new URL("../scripts/generate-compliance-assets.cjs", import.meta.url), "utf8");
  const gpl = await readFile(new URL("../third-party/npm-license-fallbacks/GPL-3.0-only.LICENSE.txt", import.meta.url), "utf8");
  const lgpl = await readFile(new URL("../third-party/npm-license-fallbacks/LGPL-3.0-or-later.LICENSE.txt", import.meta.url), "utf8");
  assert.match(generator, /"LGPL-3\.0-or-later"[\s\S]*GPL-3\.0-only\.LICENSE\.txt[\s\S]*LGPL-3\.0-or-later\.LICENSE\.txt/);
  assert.match(gpl, /GNU GENERAL PUBLIC LICENSE[\s\S]*Version 3, 29 June 2007/);
  assert.match(lgpl, /GNU LESSER GENERAL PUBLIC LICENSE[\s\S]*Version 3, 29 June 2007/);
});

test("security workflow audits dependencies, emits SBOM and configures CodeQL", async () => {
  const workflow = await readFile(".github/workflows/security.yml", "utf8");
  assert.match(workflow, /npm audit --audit-level=high/);
  assert.match(workflow, /FilmLab-\*-sbom\.cdx\.json/);
  // Third-party actions are pinned to immutable commit SHAs.
  assert.match(workflow, /actions\/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294/);
  assert.match(workflow, /github\/codeql-action\/init@ff2f1c621b7f889edc0d3c761ac2e6a3f8cdb0dd/);
  assert.match(workflow, /languages: javascript-typescript,c-cpp/);
  assert.match(workflow, /build-mode: manual/);
  assert.match(workflow, /queries: security-extended/);
});

test("privacy, diagnostic, migration, support and vulnerability policies exist", async () => {
  const documents = await Promise.all([
    readFile("PRIVACY.md", "utf8"),
    readFile("SECURITY.md", "utf8"),
    readFile("SUPPORT.md", "utf8"),
    readFile("docs/diagnostics.md", "utf8"),
    readFile("docs/migration.md", "utf8"),
  ]);
  for (const document of documents) assert.ok(document.length > 500);
  assert.match(documents[0], /no\s+account system, advertising, analytics, telemetry/);
  assert.match(documents[0], /main\s+process performs one narrow network function/);
  assert.match(documents[1], /Report a vulnerability/);
  assert.match(documents[3], /不要收集 RAW/);
  assert.match(documents[4], /当前项目 schema 为 v8/);
});
