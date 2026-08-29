import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateReleaseAudit, parseAuditReport } from "../scripts/audit-release.mjs";

const clean = { vulnerabilities: {} };

describe("Release audit policy", () => {
  it("blocks high/critical Electron advisories", () => {
    assert.throws(
      () => evaluateReleaseAudit(clean, { vulnerabilities: { electron: { severity: "high" } } }, "43.1.0"),
      /Electron 43\.1\.0 has a high severity advisory/,
    );
  });

  it("warns for non-runtime development findings without blocking", () => {
    const result = evaluateReleaseAudit(
      clean,
      { vulnerabilities: { vite: { severity: "moderate" }, typescript: { severity: "low" } } },
      "43.1.0",
    );
    assert.deepEqual(result.developmentWarnings, [
      { name: "vite", severity: "moderate" },
      { name: "typescript", severity: "low" },
    ]);
  });

  it("fails closed for invalid or unavailable audit JSON", () => {
    assert.throws(() => parseAuditReport("service unavailable", "Complete audit"), /fails closed/);
    assert.throws(() => parseAuditReport("{}", "Complete audit"), /fails closed/);
  });

  it("blocks every production dependency finding", () => {
    assert.throws(
      () => evaluateReleaseAudit({ vulnerabilities: { sharp: { severity: "low" } } }, clean, "43.1.0"),
      /Production dependency audit/,
    );
  });
});
