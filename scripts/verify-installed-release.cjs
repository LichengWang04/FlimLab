#!/usr/bin/env node

const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { createReadStream } = require("node:fs");
const { access, chmod, mkdir, readdir, readFile, rm, stat, writeFile } = require("node:fs/promises");
const { basename, dirname, extname, join, resolve } = require("node:path");
const { pingWorker, sourceWorkerPath } = require("./verify-raw-sidecar.cjs");

const root = resolve(__dirname, "..");
const options = parseArgs(process.argv.slice(2));

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

async function main() {
  if (options.package === undefined) throw new Error("--package <installer|dmg|AppImage> is required.");
  const packagePath = resolve(options.package);
  const workRoot = resolve(options["work-root"] ?? join(root, "artifacts", "installed-release"));
  const reportPath = resolve(options.report ?? join(root, "artifacts", "installed-release.json"));
  await access(packagePath);
  await rm(workRoot, { recursive: true, force: true });
  await mkdir(workRoot, { recursive: true });

  const installed = await installPackage(packagePath, workRoot);
  try {
    const sourceWorker = sourceWorkerPath(root, process.platform, process.arch);
    await pingWorker(installed.worker);
    const [packageSha256, sourceWorkerSha256, packagedWorkerSha256] = await Promise.all([
      sha256(packagePath), sha256(sourceWorker), sha256(installed.worker),
    ]);
    if (sourceWorkerSha256 !== packagedWorkerSha256) {
      throw new Error("Installed RAW sidecar does not match the verified build input.");
    }

    let acceptance;
    if (options["fixture-root"] !== undefined) {
      const acceptanceReportDir = join(workRoot, "a7rv-reports");
      await run(process.execPath, [
        join(root, "scripts", "run-a7rv-acceptance.cjs"),
        "--app-executable", installed.executable,
        "--fixture-root", resolve(options["fixture-root"]),
        "--work-root", join(workRoot, "a7rv-work"),
        "--report-dir", acceptanceReportDir,
        "--formats", options.formats ?? "tiff",
        "--stability-cycles", options["stability-cycles"] ?? "1",
      ], { cwd: root });
      acceptance = JSON.parse(await readFile(join(acceptanceReportDir, `${process.platform}-${process.arch}-summary.json`), "utf8"));
    } else {
      acceptance = await runInstalledRendererSmoke(installed.executable, workRoot);
    }

    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify({
      schemaVersion: 1,
      platform: process.platform,
      arch: process.arch,
      package: { name: basename(packagePath), bytes: (await stat(packagePath)).size, sha256: packageSha256 },
      installed: { executable: installed.executable, worker: installed.worker, workerSha256: packagedWorkerSha256 },
      upgradeReinstallVerified: installed.upgradeReinstallVerified,
      acceptance,
    }, null, 2) + "\n", "utf8");
    console.log(`Installed release verified: ${reportPath}`);
  } finally {
    await installed.cleanup();
  }
}

async function installPackage(packagePath, workRoot) {
  if (process.platform === "win32") return installWindows(packagePath, workRoot);
  if (process.platform === "darwin") return installMac(packagePath, workRoot);
  return installLinux(packagePath, workRoot);
}

async function installWindows(packagePath, workRoot) {
  if (extname(packagePath).toLowerCase() !== ".exe") throw new Error("Windows release verification requires an NSIS .exe.");
  const installRoot = join(workRoot, "installed", "FilmLab");
  const installArgs = ["/S", `/D=${installRoot}`];
  await run(packagePath, installArgs);
  const executable = join(installRoot, "FilmLab.exe");
  const worker = join(installRoot, "resources", "raw-worker", `win32-${process.arch}`, "filmlab-raw-worker.exe");
  await Promise.all([access(executable), access(worker)]);
  // A second installation to the same application identity and directory is
  // the upgrade contract; NSIS must replace in place without duplicate roots.
  await run(packagePath, installArgs);
  const uninstaller = join(installRoot, "Uninstall FilmLab.exe");
  await access(uninstaller);
  return {
    executable,
    worker,
    upgradeReinstallVerified: true,
    cleanup: async () => {
      try {
        await run(uninstaller, ["/S"], { rejectOnNonZero: false });
        await waitUntilMissing(executable, 30_000);
      } finally {
        await rm(join(workRoot, "installed"), { recursive: true, force: true });
      }
    },
  };
}

async function installMac(packagePath, workRoot) {
  if (extname(packagePath).toLowerCase() !== ".dmg") throw new Error("macOS release verification requires a DMG.");
  const mount = join(workRoot, "mounted");
  const installRoot = join(workRoot, "installed");
  await mkdir(mount, { recursive: true });
  await run("hdiutil", ["attach", packagePath, "-nobrowse", "-readonly", "-mountpoint", mount]);
  try {
    const appName = (await readdir(mount)).find((name) => name.endsWith(".app"));
    if (appName === undefined) throw new Error("DMG does not contain an application bundle.");
    const app = join(installRoot, appName);
    await mkdir(installRoot, { recursive: true });
    await run("ditto", [join(mount, appName), app]);
    const executable = join(app, "Contents", "MacOS", "FilmLab");
    const worker = join(app, "Contents", "Resources", "raw-worker", `darwin-${process.arch}`, "filmlab-raw-worker");
    await Promise.all([access(executable), access(worker)]);
    return {
      executable,
      worker,
      upgradeReinstallVerified: false,
      cleanup: async () => {
        await run("hdiutil", ["detach", mount], { rejectOnNonZero: false });
        await rm(installRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
      await run("hdiutil", ["detach", mount], { rejectOnNonZero: false });
      await rm(installRoot, { recursive: true, force: true });
      throw error;
  }
}

async function installLinux(packagePath, workRoot) {
  if (!packagePath.toLowerCase().endsWith(".appimage")) throw new Error("Linux release verification requires an AppImage.");
  await chmod(packagePath, 0o755);
  const extractRoot = join(workRoot, "appimage");
  await mkdir(extractRoot, { recursive: true });
  await run(packagePath, ["--appimage-extract"], { cwd: extractRoot });
  const applicationRoot = join(extractRoot, "squashfs-root");
  const executable = join(applicationRoot, "AppRun");
  const worker = join(applicationRoot, "resources", "raw-worker", `linux-${process.arch}`, "filmlab-raw-worker");
  await Promise.all([access(executable), access(worker)]);
  return {
    executable,
    worker,
    upgradeReinstallVerified: false,
    cleanup: async () => rm(extractRoot, { recursive: true, force: true }),
  };
}

async function runInstalledRendererSmoke(executable, workRoot) {
  const reportPath = join(workRoot, "renderer-smoke.json");
  const specPath = join(workRoot, "renderer-smoke-spec.json");
  await writeFile(specPath, JSON.stringify({
    phase: "renderer",
    machineRoot: join(workRoot, "machine"),
    reportPath,
    expectedRendererBackend: "any",
  }, null, 2) + "\n", "utf8");
  await run(executable, [], { env: { ...process.env, FILMLAB_A7RV_ACCEPTANCE_SPEC: specPath } });
  return JSON.parse(await readFile(reportPath, "utf8"));
}

async function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function run(command, args, settings = {}) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: settings.cwd,
      env: settings.env ?? process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 || settings.rejectOnNonZero === false) resolveRun();
      else reject(new Error(`${basename(command)} exited ${String(code)} (${String(signal)}).`));
    });
  });
}

async function waitUntilMissing(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
    } catch {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Uninstaller did not remove ${path} within ${timeoutMs}ms.`);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current.startsWith("--")) throw new Error(`Unexpected argument: ${current}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) parsed[current.slice(2)] = true;
    else {
      parsed[current.slice(2)] = value;
      index += 1;
    }
  }
  return parsed;
}
