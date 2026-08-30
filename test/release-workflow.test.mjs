import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";

describe("Unsigned public-beta release contract", () => {
  it("builds an explicitly unsigned installer and publishes only allowlisted assets", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    assert.equal(pkg.scripts["dist:win"], "npm run build && electron-builder --win --x64 --publish never");
    assert.doesNotMatch(workflow, /CSC_LINK|WINDOWS_CSC|signed-windows-release|release\/\*\.yml/);
    assert.match(workflow, /signature = 'NotSigned'/);
    assert.match(workflow, /docs\/PUBLIC_BETA\.md/);
    assert.match(workflow, /docs\/RAW_ACCEPTANCE\.md/);
    assert.match(workflow, /docs\/NEGADOCTOR_ACCEPTANCE_RESULTS\.json/);
    assert.match(workflow, /FilmLab-Setup-\*-x64\.exe/);
  });

  it("warns users before they run the unsigned public beta", async () => {
    const notes = await readFile(new URL("../docs/PUBLIC_BETA.md", import.meta.url), "utf8");
    assert.match(notes, /未签名安装包/);
    assert.match(notes, /SmartScreen/);
    assert.match(notes, /SHA256SUMS\.txt/);
    assert.match(notes, /CR2、NEF、RW2.*实验性支持/);
  });
});
