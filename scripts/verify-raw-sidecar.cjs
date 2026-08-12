#!/usr/bin/env node
/*
 * Electron-builder hooks and a small CLI validator for the native RAW sidecar.
 *
 * `beforePack` proves that the target-specific executable was built. `afterPack`
 * proves that electron-builder copied that exact executable into resources. The
 * standalone CLI additionally exercises the JSON Lines ping handshake in CI.
 */

const { access, stat } = require("node:fs/promises");
const { constants } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawn } = require("node:child_process");

const SUPPORTED_PLATFORMS = new Set(["win32", "darwin", "linux"]);
const ARCH_BY_ELECTRON_BUILDER_VALUE = Object.freeze({
  0: "ia32",
  1: "x64",
  2: "armv7l",
  3: "arm64",
  4: "universal",
});

function normaliseArch(arch) {
  if (typeof arch === "string") return arch;
  const resolved = ARCH_BY_ELECTRON_BUILDER_VALUE[arch];
  if (resolved === undefined) {
    throw new Error(`Unknown electron-builder architecture value: ${String(arch)}`);
  }
  return resolved;
}

function platformArch(platform, arch) {
  const normalisedArch = normaliseArch(arch);
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`RAW sidecar is not configured for Electron platform: ${platform}`);
  }
  if (normalisedArch !== "x64" && normalisedArch !== "arm64") {
    throw new Error(`RAW sidecar is not built for architecture: ${normalisedArch}`);
  }
  return `${platform}-${normalisedArch}`;
}

function executableName(platform) {
  return platform === "win32" ? "filmlab-raw-worker.exe" : "filmlab-raw-worker";
}

function relativeWorkerPath(platform, arch) {
  return join("raw-worker", platformArch(platform, arch), executableName(platform));
}

function sourceWorkerPath(projectDir, platform, arch) {
  return join(resolve(projectDir), "native", "raw-worker", "out", platformArch(platform, arch), executableName(platform));
}

async function assertExecutable(file, label) {
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new Error(`${label} is missing: ${file}`);
  }
  if (!info.isFile() || info.size === 0) {
    throw new Error(`${label} is not a non-empty executable file: ${file}`);
  }
  if (process.platform !== "win32") {
    try {
      await access(file, constants.X_OK);
    } catch {
      throw new Error(`${label} is not executable: ${file}`);
    }
  }
  return file;
}

function collectTerminalResponse(output) {
  const response = output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`RAW sidecar emitted non-JSON stdout: ${line}`);
      }
    })
    .find((value) => value && value.id === "release-ping" && Object.hasOwn(value, "ok"));
  if (response === undefined) {
    throw new Error("RAW sidecar did not return a terminal ping response.");
  }
  return response;
}

async function pingWorker(file) {
  await assertExecutable(file, "RAW sidecar");
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout;
    const settle = (callback) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        callback();
      }
    };
    timeout = setTimeout(() => {
      child.kill();
      settle(() => rejectPromise(new Error("RAW sidecar ping timed out after 10 seconds.")));
    }, 10_000);

    child.once("error", (error) => settle(() => rejectPromise(new Error(`RAW sidecar could not start: ${error.message}`))));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8_192);
    });
    child.once("exit", (code) => settle(() => {
      if (code !== 0) {
        rejectPromise(new Error(`RAW sidecar ping exited with ${String(code)}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      try {
        const response = collectTerminalResponse(stdout);
        if (response.ok !== true || typeof response.result !== "object" || response.result === null) {
          throw new Error("RAW sidecar ping returned an unsuccessful response.");
        }
        const result = response.result;
        if (result.protocolVersion !== 1 || result.cacheFormat !== "filmlab-rgb16le-v1") {
          throw new Error("RAW sidecar ping returned an unsupported protocol or cache format.");
        }
        if (!Array.isArray(result.supportedCfa) || result.supportedCfa.length !== 1 || result.supportedCfa[0] !== "bayer-2x2") {
          throw new Error("RAW sidecar release contract requires Bayer-only capability (supportedCfa: [\"bayer-2x2\"]).");
        }
        resolvePromise();
      } catch (error) {
        rejectPromise(error);
      }
    }));
    child.stdin.end('{"id":"release-ping","type":"ping"}\n', "utf8");
  });
}

async function beforePack(context) {
  const worker = sourceWorkerPath(context.packager.projectDir, context.electronPlatformName, context.arch);
  await assertExecutable(worker, "Required RAW sidecar for this package target");
}

async function afterPack(context) {
  const relative = relativeWorkerPath(context.electronPlatformName, context.arch);
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir);
  await assertExecutable(join(resourcesDir, relative), "Packaged RAW sidecar");
}

function parseArguments(argv) {
  const options = { root: process.cwd(), ping: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root" || argument === "--platform" || argument === "--arch") {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      options[argument.slice(2)] = value;
    } else if (argument === "--ping") {
      options.ping = true;
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function resolveCliTarget(options, host = { platform: process.platform, arch: process.arch }) {
  return {
    platform: options.platform ?? host.platform,
    arch: options.arch ?? host.arch,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/verify-raw-sidecar.cjs [--platform <win32|darwin|linux>] [--arch <x64|arm64>] [--root <project>] [--ping]");
    console.log("Platform and architecture default to the current Node.js host.");
    return;
  }
  const target = resolveCliTarget(options);
  const worker = sourceWorkerPath(options.root, target.platform, target.arch);
  await assertExecutable(worker, "RAW sidecar");
  if (options.ping) await pingWorker(worker);
  console.log(`RAW sidecar verified: ${worker}${options.ping ? " (ping; Bayer-only)" : ""}`);
}

module.exports = {
  afterPack,
  assertExecutable,
  beforePack,
  executableName,
  normaliseArch,
  pingWorker,
  platformArch,
  relativeWorkerPath,
  resolveCliTarget,
  sourceWorkerPath,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`RAW sidecar validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
