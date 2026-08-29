import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";

export function parseAuditReport(text, label) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new Error(`${label} did not return valid JSON; release audit fails closed.`);
  }
  if (typeof report !== "object" || report === null || Array.isArray(report) || typeof report.vulnerabilities !== "object") {
    throw new Error(`${label} returned an unsupported audit report; release audit fails closed.`);
  }
  return report;
}

export function evaluateReleaseAudit(productionReport, completeReport, electronVersion) {
  const production = Object.entries(productionReport.vulnerabilities ?? {});
  if (production.length > 0) {
    throw new Error(`Production dependency audit found ${production.length} vulnerable package(s).`);
  }
  const all = Object.entries(completeReport.vulnerabilities ?? {});
  const electron = all.find(([name]) => name === "electron")?.[1];
  if (electron !== undefined && (electron.severity === "high" || electron.severity === "critical")) {
    throw new Error(`Electron ${electronVersion} has a ${electron.severity} severity advisory.`);
  }
  return {
    electronVersion,
    developmentWarnings: all
      .filter(([name]) => name !== "electron")
      .map(([name, vulnerability]) => ({ name, severity: vulnerability.severity ?? "unknown" })),
  };
}

async function runAudit(arguments_) {
  const npmCli = process.env.npm_execpath;
  const executable = typeof npmCli === "string" && npmCli.length > 0 ? process.execPath : "npm";
  const commandArguments = typeof npmCli === "string" && npmCli.length > 0
    ? [npmCli, "audit", ...arguments_, "--json"]
    : ["audit", ...arguments_, "--json"];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, commandArguments, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const lock = JSON.parse(await fs.readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const electronVersion = lock.packages?.["node_modules/electron"]?.version;
  if (typeof electronVersion !== "string" || electronVersion.length === 0) {
    throw new Error("package-lock.json does not contain an installed Electron version.");
  }
  const [productionResult, completeResult] = await Promise.all([
    runAudit(["--omit=dev"]),
    runAudit([]),
  ]);
  const production = parseAuditReport(productionResult.stdout, "Production audit");
  const complete = parseAuditReport(completeResult.stdout, "Complete audit");
  const result = evaluateReleaseAudit(production, complete, electronVersion);
  console.log(`Release runtime audit passed; Electron ${result.electronVersion}.`);
  for (const warning of result.developmentWarnings) {
    const message = `Development-only dependency ${warning.name} has ${warning.severity} severity audit findings.`;
    console.warn(process.env["GITHUB_ACTIONS"] === "true" ? `::warning::${message}` : `warning: ${message}`);
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
