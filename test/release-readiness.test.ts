import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Worker } from "node:worker_threads";
import { DEFAULT_RECIPE, Raster } from "../src/core/index.ts";
import {
  parseFrameId,
  parseOpenMode,
  parseRecipe,
  parseRollExportRequest,
  parseSessionSaveRequest,
} from "../src/main/ipc-validation.ts";
import { ProcessingServiceCore as ProcessingService } from "../src/main/processing-service-core.ts";
import {
  assertImageDimensions,
  assertRawImageDimensions,
  assertTiffStrips,
  friendlyProcessingError,
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  MAX_ROLL_FRAMES,
  MAX_TIFF_STRIP_BYTES,
} from "../src/main/resource-limits.ts";
import { framePath, registerFrames, releaseFrame } from "../src/main/roll-service.ts";
import { SessionStore } from "../src/main/session-store.ts";
import { PreviewWorkerClient } from "../src/renderer/src/preview-worker-client.ts";
import type { PreviewWorkerPort } from "../src/renderer/src/preview-worker-client.ts";
import type { PreviewWorkerResponse } from "../src/renderer/src/preview-worker-protocol.ts";
import { PreviewSourceCache } from "../src/renderer/src/preview-source-cache.ts";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
let tempDir: string | undefined;

after(async () => {
  if (tempDir !== undefined) await fs.rm(tempDir, { recursive: true, force: true });
});

describe("Release input boundaries", () => {
  it("accepts only the public import modes and opaque UUID frame ids", () => {
    assert.equal(parseOpenMode("files"), "files");
    assert.equal(parseFrameId(ID_A), ID_A);
    assert.throws(() => parseOpenMode("url"), /导入模式/);
    assert.throws(() => parseFrameId("../../secret.tiff"), /帧标识/);
  });

  it("validates every recipe field and normalized ROI", () => {
    assert.deepEqual(parseRecipe(DEFAULT_RECIPE), DEFAULT_RECIPE);
    assert.throws(() => parseRecipe({ ...DEFAULT_RECIPE, exposure: Number.NaN }), /曝光/);
    assert.throws(() => parseRecipe({ ...DEFAULT_RECIPE, temperatureKelvin: 20_000 }), /色温/);
    assert.throws(() => parseRecipe({ ...DEFAULT_RECIPE, crop: { x: 0.9, y: 0, width: 0.2, height: 1 } }), /范围/);
  });

  it("rejects duplicate and oversized roll/session payloads", () => {
    assert.throws(() => parseRollExportRequest({
      format: "tiff",
      frames: [
        { id: ID_A, recipe: DEFAULT_RECIPE },
        { id: ID_A, recipe: DEFAULT_RECIPE },
      ],
    }), /重复/);
    assert.throws(() => parseSessionSaveRequest({
      frames: Array.from({ length: MAX_ROLL_FRAMES + 1 }, () => ({ id: ID_A, recipe: DEFAULT_RECIPE, skipped: false })),
    }), /最多/);
  });

  it("enforces image and TIFF strip allocation limits", () => {
    assert.doesNotThrow(() => assertImageDimensions(10_000, 6_000));
    assert.throws(() => assertImageDimensions(MAX_IMAGE_EDGE + 1, 1), /最长边/);
    assert.throws(() => assertImageDimensions(MAX_IMAGE_PIXELS, 2), /最长边|MP/);
    assert.doesNotThrow(() => assertRawImageDimensions(9_504, 6_336));
    assert.throws(() => assertRawImageDimensions(10_000, 7_001), /RAW/);
    assert.throws(() => assertTiffStrips([0], [MAX_TIFF_STRIP_BYTES + 1]), /单条带/);
  });

  it("turns memory, disk and permission failures into path-free user errors", () => {
    assert.match(friendlyProcessingError(new RangeError("Array buffer allocation failed")), /内存不足/);
    assert.match(friendlyProcessingError(Object.assign(new Error("raw"), { code: "ENOSPC" })), /磁盘空间不足/);
    assert.match(friendlyProcessingError(Object.assign(new Error("raw"), { code: "EACCES" })), /不可写/);
    assert.match(friendlyProcessingError(Object.assign(new Error("raw"), { code: "ENOENT" })), /文件夹不存在/);
  });
});

describe("Installer legal bundle", () => {
  it("declares an existing source for every legal file and covers the bundled libvips runtime", async () => {
    const builder = await fs.readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
    const fromPaths = [...builder.matchAll(/^\s*-\s*from:\s*(.+)$/gm)].map((match) => match[1]!.trim());
    const toPaths = [...builder.matchAll(/^\s*to:\s*(.+)$/gm)].map((match) => match[1]!.trim());
    assert.ok(fromPaths.length >= 17, "extraResources 条目数量异常");
    assert.equal(toPaths.length, fromPaths.length, "每个 extraResources 都必须有唯一目标名");
    assert.equal(new Set(toPaths).size, toPaths.length, "legal 目标文件名不得互相覆盖");
    const platformOptional = new Set(["node_modules/@img/sharp-win32-x64/LICENSE"]);
    for (const relative of fromPaths) {
      if (process.platform !== "win32" && platformOptional.has(relative)) continue;
      await fs.access(new URL(`../${relative}`, import.meta.url));
    }
    for (const required of [
      "third-party/licenses/LGPL-3.0-or-later.txt",
      "third-party/licenses/libvips-SOURCE-NOTICE.md",
      "node_modules/@img/sharp-win32-x64/LICENSE",
    ]) {
      assert.ok(fromPaths.includes(required), `extraResources 缺少 ${required}`);
    }
    const lock = await fs.readFile(new URL("../package-lock.json", import.meta.url), "utf8");
    assert.match(lock, /node_modules\/@img\/sharp-win32-x64/);
    const notices = await fs.readFile(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
    assert.match(notices, /libvips（含其捆绑的图像编解码组件） \| 8\.18\.3 \| LGPL-3\.0-or-later/);
    assert.doesNotMatch(notices, /@img\/sharp-wasm32/);
    assert.doesNotMatch(notices, /捆绑组件声明见包内许可证/);
    const lgpl = await fs.readFile(
      new URL("../third-party/licenses/LGPL-3.0-or-later.txt", import.meta.url),
      "utf8",
    );
    assert.match(lgpl, /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  });
});

describe("Preview Worker scheduling and cache", () => {
  it("copies and transfers an unshared preview source for the CPU Worker fallback", () => {
    const worker = new FakePreviewWorker();
    const client = new PreviewWorkerClient(() => worker);
    const raster = new Float32Array([0.1, 0.2, 0.3]);
    client.registerSource(ID_A, 1, 1, raster);
    const message = worker.messages[0] as { kind: string; raster: Float32Array };
    assert.equal(message.kind, "register");
    assert.notEqual(message.raster, raster);
    assert.deepEqual(message.raster, raster);
    assert.deepEqual(worker.transfers[0], [message.raster.buffer]);
    assert.equal(raster.byteLength, 12);
  });

  it("publishes only the newest queued revision", () => {
    const worker = new FakePreviewWorker();
    const client = new PreviewWorkerClient(() => worker);
    const published: number[] = [];
    const request = (revision: number) => client.requestPreview({
      id: ID_A,
      recipe: DEFAULT_RECIPE,
      revision,
      onResult: (_result, completed) => published.push(completed),
      onError: () => assert.fail("preview should not fail"),
    });
    request(1);
    request(2);
    request(3);
    worker.respond(previewResponse(1));
    assert.deepEqual(published, []);
    const lastMessage = worker.messages.at(-1) as { kind: string; revision?: number };
    assert.equal(lastMessage.kind, "process");
    assert.equal(lastMessage.revision, 3);
    worker.respond(previewResponse(3));
    assert.deepEqual(published, [3]);
  });

  it("publishes only the newly selected frame when GPU preparation overlaps a switch", () => {
    const worker = new FakePreviewWorker();
    const client = new PreviewWorkerClient(() => worker);
    const published: string[] = [];
    client.requestGpuPreparation({
      id: ID_A,
      recipe: DEFAULT_RECIPE,
      revision: 1,
      onResult: () => published.push(ID_A),
      onError: () => assert.fail("GPU preparation should not fail"),
    });
    client.requestGpuPreparation({
      id: ID_B,
      recipe: DEFAULT_RECIPE,
      revision: 2,
      onResult: () => published.push(ID_B),
      onError: () => assert.fail("GPU preparation should not fail"),
    });
    worker.respond(gpuPreparationResponse(1, ID_A));
    assert.deepEqual(published, []);
    const next = worker.messages.at(-1) as { kind: string; revision?: number; id?: string };
    assert.deepEqual({ kind: next.kind, revision: next.revision, id: next.id }, {
      kind: "prepare-gpu",
      revision: 2,
      id: ID_B,
    });
    worker.respond(gpuPreparationResponse(2, ID_B));
    assert.deepEqual(published, [ID_B]);
  });

  it("suppresses released work and reports fatal Worker failures", () => {
    const worker = new FakePreviewWorker();
    const client = new PreviewWorkerClient(() => worker);
    let published = false;
    let fatal = "";
    client.onFatal((message) => { fatal = message; });
    client.requestPreview({
      id: ID_A,
      recipe: DEFAULT_RECIPE,
      revision: 1,
      onResult: () => { published = true; },
      onError: () => {},
    });
    client.release(ID_A);
    worker.respond(previewResponse(1));
    assert.equal(published, false);
    worker.fail("boom");
    assert.equal(fatal, "boom");
  });

  it("keeps at most three LRU sources and only one derived session", () => {
    const cache = new PreviewSourceCache(3, 10_000);
    for (const id of ["a", "b", "c"]) cache.register(id, tinyRaster());
    cache.activate("a");
    cache.register("d", tinyRaster());
    assert.equal(cache.size, 3);
    assert.equal(cache.has("a"), true);
    assert.equal(cache.has("b"), false);
    cache.activate("c");
    assert.ok(cache.estimatedBytes <= 10_000);
    cache.release("c");
    assert.equal(cache.has("c"), false);
  });

  it("evicts inactive sources to honour a custom memory budget", () => {
    const cache = new PreviewSourceCache(3, 290);
    cache.register("a", tinyRaster());
    cache.register("b", tinyRaster());
    cache.activate("a"); // active estimate 240 B; b adds 48 B
    cache.register("c", tinyRaster());
    assert.equal(cache.has("b"), false);
    assert.ok(cache.estimatedBytes <= 290);
  });
});

describe("Processing Worker lifecycle", () => {
  it("restarts exactly once and ignores the old Worker's later exit", async () => {
    const workers: FakeProcessingWorker[] = [];
    const service = new ProcessingService(() => {
      const worker = new FakeProcessingWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const result = service.renderPositive("source.tiff", DEFAULT_RECIPE, "tiff", "out.tiff");
    assert.equal(workers.length, 1);
    workers[0]!.emit("error", new Error("crash"));
    workers[0]!.emit("exit", 1);
    assert.equal(workers.length, 2);
    const request = workers[1]!.messages[0] as { jobId: number };
    workers[1]!.emit("message", { jobId: request.jobId, result: { ok: true, path: "out.tiff" } });
    assert.deepEqual(await result, { ok: true, path: "out.tiff" });
    service.close();
  });

  it("resolves an active task and terminates the Worker on close", async () => {
    const worker = new FakeProcessingWorker();
    const service = new ProcessingService(() => worker as unknown as Worker);
    const result = service.renderPositive("source.tiff", DEFAULT_RECIPE, "jpeg", "out.jpg");
    service.close();
    assert.equal(worker.terminated, true);
    assert.deepEqual(await result, { ok: false, message: "应用正在退出，导出已停止。" });
  });

  it("returns a clean failure when Worker creation fails twice", async () => {
    let attempts = 0;
    const service = new ProcessingService(() => {
      attempts += 1;
      throw new Error("unavailable");
    });
    const result = await service.renderPositive("source.tiff", DEFAULT_RECIPE, "jpeg", "out.jpg");
    assert.equal(attempts, 2);
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /unavailable/);
  });
});

describe("Local session and source-path lifecycle", () => {
  it("restores valid local frames and prunes removed source registrations", async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "filmlab-session-"));
    const first = join(tempDir, "一号 底片.tiff");
    const second = join(tempDir, "second.tiff");
    await fs.writeFile(first, "fixture");
    await fs.writeFile(second, "fixture");
    const infos = registerFrames([first, second]);
    const store = new SessionStore(() => join(tempDir!, "session.json"));
    await store.save({
      frames: [
        { id: infos[0]!.id, recipe: DEFAULT_RECIPE, skipped: false },
        { id: infos[1]!.id, recipe: { ...DEFAULT_RECIPE, exposure: 0.5 }, skipped: true },
      ],
      activeId: infos[1]!.id,
    });
    registerFrames([]);
    const restored = await store.restore();
    assert.equal(restored?.frames.length, 2);
    assert.equal(restored?.frames[1]!.recipe.engine, "classic");
    assert.equal(restored?.frames[1]!.recipe.engine === "classic" ? restored.frames[1]!.recipe.exposure : undefined, 0.5);
    assert.equal(restored?.frames[1]!.skipped, true);
    const restoredId = restored!.frames[0]!.info.id;
    assert.equal(framePath(restoredId), first);
    assert.equal(releaseFrame(restoredId), true);
    assert.equal(framePath(restoredId), null);
  });

  it("ignores a corrupt session file", async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "filmlab-session-"));
    const path = join(tempDir, "session.json");
    await fs.writeFile(path, "not json");
    assert.equal(await new SessionStore(() => path).restore(), null);
  });
});

function tinyRaster(): Raster {
  return new Raster(2, 2, "transmission-linear", new Float32Array(12).fill(0.5));
}

function previewResponse(revision: number): PreviewWorkerResponse {
  return {
    kind: "preview",
    requestId: revision,
    revision,
    id: ID_A,
    result: {
      rgba: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
      base: { rgb: [1, 1, 1], confidence: 1, method: "automatic", sampleCount: 1 },
      anchors: { dmin: 0, dmax: 1, range: 1 },
      whitePoint: 1,
      ms: 1,
      cacheStats: { geometry: 1, analysis: 1, inversion: 1, balance: 1, tone: 1 },
    },
  };
}

function gpuPreparationResponse(revision: number, id: string): PreviewWorkerResponse {
  return {
    kind: "gpu-prepared",
    requestId: revision,
    revision,
    id,
    result: {
      width: 1,
      height: 1,
      base: { rgb: [1, 1, 1], confidence: 1, method: "automatic", sampleCount: 1 },
      anchors: { dmin: 0, dmax: 1, range: 1 },
      whitePoint: 1,
      gains: [1, 1, 1],
      ms: 1,
      cacheStats: { geometry: 1, analysis: 1, inversion: 1, balance: 1, tone: 1 },
    },
  };
}

class FakePreviewWorker implements PreviewWorkerPort {
  onmessage: ((event: MessageEvent<PreviewWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: unknown[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.messages.push(message);
    this.transfers.push(transfer);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(response: PreviewWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<PreviewWorkerResponse>);
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

class FakeProcessingWorker extends EventEmitter {
  readonly messages: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
}
