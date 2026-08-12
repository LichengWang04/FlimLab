#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { cp, mkdir, readFile, readdir, rm, stat, writeFile } = require("node:fs/promises");
const { basename, join, resolve } = require("node:path");

const root = resolve(__dirname, "..");
const legalRoot = join(root, "build", "generated", "legal");
const nativeLicenseRoot = join(root, "third-party", "native-licenses");
const checkOnly = process.argv.includes("--check");

void main().catch((error) => {
  console.error(`Compliance asset generation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

async function main() {
  const packageDocument = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const nativeManifest = JSON.parse(await readFile(join(root, "third-party", "native-components.json"), "utf8"));
  const notices = await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  validateComplianceSources(packageDocument, lock, nativeManifest, notices);

  await rm(legalRoot, { recursive: true, force: true });
  await mkdir(join(legalRoot, "npm"), { recursive: true });
  for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
    await cp(join(root, file), join(legalRoot, file));
  }
  for (const component of nativeManifest.components) {
    for (const file of component.licenseFiles) {
      await copyRequired(join(nativeLicenseRoot, file), join(legalRoot, file));
    }
  }

  const installedLicenses = await copyInstalledNpmLicenses(lock);
  await writeFile(
    join(legalRoot, "npm", "INDEX.txt"),
    installedLicenses.map((entry) => `${entry.name}@${entry.version}\t${entry.license}\t${entry.files.join(", ")}`).join("\n") + "\n",
    "utf8",
  );

  const sbom = createSbom(lock, nativeManifest);
  const sbomName = `FilmLab-${packageDocument.version}-sbom.cdx.json`;
  await writeFile(join(legalRoot, sbomName), JSON.stringify(sbom, null, 2) + "\n", "utf8");
  console.log(`${checkOnly ? "Compliance verified" : "Compliance assets generated"}: ${legalRoot}`);
}

function validateComplianceSources(packageDocument, lock, nativeManifest, notices) {
  if (packageDocument.private !== true || packageDocument.license !== "UNLICENSED") {
    throw new Error("FilmLab must remain private/UNLICENSED unless the root proprietary license is deliberately changed.");
  }
  const libraw = nativeManifest.components.find((component) => component.name === "LibRaw");
  if (libraw?.version !== "0.22.1" || libraw.license !== "CDDL-1.0") {
    throw new Error("Native compliance manifest must elect CDDL-1.0 for LibRaw 0.22.1.");
  }
  for (const [path, value] of Object.entries(lock.packages)) {
    if (path === "" || value.dev === true) continue;
    const name = packageNameFromLockPath(path);
    if (typeof value.version !== "string" || typeof value.license !== "string") {
      throw new Error(`Runtime npm component lacks version/license metadata: ${path}`);
    }
    if (!notices.includes(`\`${name}\``) || !notices.includes(`\`${value.version}\``)) {
      throw new Error(`THIRD_PARTY_NOTICES.md does not identify ${name}@${value.version}.`);
    }
  }
  for (const component of nativeManifest.components) {
    if (!notices.includes(`\`${component.name}\``) || !notices.includes(`\`${component.version}\``)) {
      throw new Error(`THIRD_PARTY_NOTICES.md does not identify ${component.name}@${component.version}.`);
    }
  }
}

async function copyInstalledNpmLicenses(lock) {
  const results = [];
  for (const [path, value] of Object.entries(lock.packages)) {
    if (path === "" || value.dev === true) continue;
    const packageRoot = join(root, ...path.split("/"));
    if (!(await isDirectory(packageRoot))) continue; // Host-specific optional package.
    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    const candidates = (await readdir(packageRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice)(\.|$)/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    if (candidates.length === 0) throw new Error(`Installed runtime package has no license file: ${packageJson.name}@${value.version}`);
    const directory = `${safeName(packageJson.name)}@${value.version}`;
    await mkdir(join(legalRoot, "npm", directory), { recursive: true });
    for (const file of candidates) await cp(join(packageRoot, file), join(legalRoot, "npm", directory, file));
    results.push({ name: packageJson.name, version: value.version, license: value.license, files: candidates.map((file) => `${directory}/${file}`) });
  }
  return results.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
}

function createSbom(lock, nativeManifest) {
  const sbomArguments = ["sbom", "--package-lock-only", "--omit=dev", "--sbom-format=cyclonedx", "--sbom-type=application"];
  const npmCli = process.env.npm_execpath;
  const npmResult = npmCli === undefined
    ? spawnSync(process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm", process.platform === "win32"
      ? ["/d", "/s", "/c", `npm.cmd ${sbomArguments.join(" ")}`]
      : sbomArguments, { cwd: root, encoding: "utf8", windowsHide: true })
    : spawnSync(process.execPath, [npmCli, ...sbomArguments], { cwd: root, encoding: "utf8", windowsHide: true });
  if (npmResult.error !== undefined || npmResult.status !== 0 || typeof npmResult.stdout !== "string") {
    throw new Error(`npm sbom failed: ${npmResult.error?.message ?? npmResult.stderr?.trim() ?? `exit ${String(npmResult.status)}`}`);
  }
  const sbom = JSON.parse(npmResult.stdout);
  delete sbom.serialNumber;
  if (sbom.metadata) delete sbom.metadata.timestamp;
  sbom.metadata ??= {};
  sbom.metadata.properties = [
    { name: "filmlab:sbom-generation", value: "npm-lockfile-plus-vcpkg-manifest-v1" },
    { name: "filmlab:vcpkg-baseline", value: nativeManifest.vcpkgBaseline },
  ];
  sbom.components ??= [];
  const rootReference = sbom.metadata.component?.["bom-ref"];
  const nativeReferences = [];
  for (const component of nativeManifest.components) {
    const reference = component.purl;
    nativeReferences.push(reference);
    sbom.components.push({
      type: "library",
      "bom-ref": reference,
      name: component.name,
      version: component.version,
      licenses: [{ license: component.license.startsWith("LicenseRef-") ? { name: component.license } : { id: component.license } }],
      purl: component.purl,
      externalReferences: [{ type: "distribution", url: component.source }],
      properties: [{ name: "filmlab:dependency-manager", value: "vcpkg" }],
    });
  }
  sbom.components.sort((left, right) => String(left["bom-ref"]).localeCompare(String(right["bom-ref"])));
  sbom.dependencies ??= [];
  if (rootReference !== undefined) {
    const rootDependency = sbom.dependencies.find((entry) => entry.ref === rootReference);
    if (rootDependency) rootDependency.dependsOn = [...new Set([...(rootDependency.dependsOn ?? []), ...nativeReferences])].sort();
  }
  for (const reference of nativeReferences) {
    if (!sbom.dependencies.some((entry) => entry.ref === reference)) sbom.dependencies.push({ ref: reference, dependsOn: [] });
  }
  sbom.dependencies.sort((left, right) => left.ref.localeCompare(right.ref));
  return sbom;
}

async function copyRequired(source, destination) {
  const info = await stat(source).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.size === 0) throw new Error(`Required license file is missing: ${source}`);
  await cp(source, destination);
}

async function isDirectory(path) {
  return (await stat(path).catch(() => undefined))?.isDirectory() === true;
}

function packageNameFromLockPath(path) {
  const marker = "node_modules/";
  const last = path.lastIndexOf(marker);
  return path.slice(last + marker.length);
}

function safeName(name) {
  return name.replace(/^@/, "").replaceAll("/", "__").replace(/[^a-zA-Z0-9_.-]/g, "_");
}
