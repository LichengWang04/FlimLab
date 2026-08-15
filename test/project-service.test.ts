import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProjectService } from "../src/main/project-service.ts";
import { ProjectSaveQueue } from "../src/renderer/src/project-save-queue.ts";
import { projectSchemaVersion } from "../src/shared/project.ts";

test("project save queue publishes writes in request order", async () => {
  const queue = new ProjectSaveQueue();
  const completed: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.enqueue(async () => {
    await firstGate;
    completed.push("first");
  });
  const second = queue.enqueue(async () => {
    completed.push("second");
  });

  await Promise.resolve();
  assert.deepEqual(completed, []);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(completed, ["first", "second"]);
});

test("project save queue continues after a failed write", async () => {
  const queue = new ProjectSaveQueue();
  await assert.rejects(
    queue.enqueue(async () => Promise.reject(new Error("disk unavailable"))),
    /disk unavailable/,
  );

  let laterSaveRan = false;
  await queue.enqueue(async () => {
    laterSaveRan = true;
  });
  assert.equal(laterSaveRan, true);
});

test("project save queue flush waits for every accepted write", async () => {
  const queue = new ProjectSaveQueue();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed = false;
  void queue.enqueue(async () => {
    await gate;
    completed = true;
  });

  const flushed = queue.flush();
  await Promise.resolve();
  assert.equal(completed, false);
  release?.();
  await flushed;
  assert.equal(completed, true);
});

test("project storage persists a renderer-safe recipe and source list", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-project-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));

  const service = new ProjectService(directory);
  const initial = await service.load();
  assert.equal(initial.rolls[0]?.title, "未命名胶卷");
  assert.deepEqual(initial.rolls[0]?.assets, []);
  assert.deepEqual(initial.rolls[0]?.frameOrder, []);
  assert.deepEqual(initial.rolls[0]?.recipesByFrameId, {});
  assert.deepEqual(initial.recipe.tone, {
    exposureStops: 0,
    contrast: 1,
    highlightCompression: 0,
    saturation: 1,
  });

  const saved = await service.save({
    rolls: [
      {
        id: "summer-roll",
        title: "C-41 夏日卷",
        assets: [{
          id: "9f6b32d1-987a-44a6-9fc4-c4011d7ab2ec",
          name: "frame-001.dng",
          extension: "dng",
          identity: {
            size: 123_456,
            lastModifiedAt: "2026-08-11T08:00:00.000Z",
            fingerprint: { algorithm: "sha256-full-v1", value: "a".repeat(64) },
          },
        }],
        frameOrder: ["9f6b32d1-987a-44a6-9fc4-c4011d7ab2ec", "demo-negative"],
        recipesByFrameId: {
          "9f6b32d1-987a-44a6-9fc4-c4011d7ab2ec": {
            mode: "generic",
            view: "positive",
            tone: { exposureStops: 0.65, contrast: 1.21, highlightCompression: 0.2, saturation: 0.92 },
          },
          "demo-negative": {
            mode: "preset",
            view: "density",
            tone: { exposureStops: -0.35, contrast: 0.95, highlightCompression: 0.1, saturation: 1.08 },
          },
        },
        uniformRecipe: {
          sourceFrameId: "9f6b32d1-987a-44a6-9fc4-c4011d7ab2ec",
          recipe: {
            mode: "generic",
            view: "positive",
            tone: { exposureStops: 0.2, contrast: 1.08, highlightCompression: 0.3, saturation: 1.02 },
          },
        },
        manualDmax: {
          value: 1.42,
          sourceFrameId: "9f6b32d1-987a-44a6-9fc4-c4011d7ab2ec",
          channelRange: [0.92, 0.88, 0.95],
        },
      },
      { id: "winter-roll", title: "冬日卷", assets: [], frameOrder: [] },
    ],
    activeRollId: "summer-roll",
    recipe: {
      mode: "preset",
      view: "positive",
      tone: {
        exposureStops: 0.3,
        contrast: 1.12,
        highlightCompression: 0.45,
        saturation: 1.08,
      },
    },
  });

  assert.equal(saved.rolls[0]?.title, "C-41 夏日卷");
  assert.equal(saved.rolls[0]?.assets[0]?.extension, "DNG");
  assert.equal(saved.rolls[0]?.assets[0]?.identity?.size, 123_456);
  assert.equal(saved.rolls[0]?.assets[0]?.identity?.lastModifiedAt, "2026-08-11T08:00:00.000Z");
  assert.equal(saved.rolls[0]?.uniformRecipe?.sourceFrameId, "9f6b32d1-987a-44a6-9fc4-c4011d7ab2ec");
  assert.equal(saved.rolls[0]?.uniformRecipe?.recipe.mode, "generic");
  assert.deepEqual(saved.rolls[0]?.manualDmax, {
    value: 1.42,
    sourceFrameId: "9f6b32d1-987a-44a6-9fc4-c4011d7ab2ec",
    channelRange: [0.92, 0.88, 0.95],
  });
  assert.equal(saved.rolls[0]?.recipesByFrameId?.["9f6b32d1-987a-44a6-9fc4-c4011d7ab2ec"]?.tone.exposureStops, 0.65);
  assert.equal(saved.rolls[0]?.recipesByFrameId?.["demo-negative"]?.view, "density");
  assert.deepEqual(saved.rolls[1]?.recipesByFrameId, {});
  assert.equal(saved.activeRollId, "summer-roll");
  assert.ok(Date.parse(saved.updatedAt));

  const reloaded = await new ProjectService(directory).load();
  assert.deepEqual(reloaded, saved);
  const file = await readFile(join(directory, "workspace.filmlab", "project.json"), "utf8");
  assert.match(file, /sha256-full-v1/);
  assert.doesNotMatch(file, /[\\/](?:Users|home|tmp)[\\/]/i);
});

test("project storage persists a frozen film-base reference", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-project-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const service = new ProjectService(directory);
  const frameId = "frame-reference";

  const saved = await service.save({
    rolls: [{
      id: "reference-roll",
      title: "无边框测试卷",
      assets: [{ id: frameId, name: "reference.tif", extension: "TIF" }],
      frameOrder: [frameId],
    }],
    activeRollId: "reference-roll",
    recipe: {
      mode: "preset",
      view: "positive",
      tone: { exposureStops: 0, contrast: 1.16, highlightCompression: 0.5, saturation: 1.04 },
      processing: {
        baseRoi: { x: 0, y: 0, width: 0.08, height: 1 },
        filmBase: {
          kind: "reference",
          rgb: [0.82, 0.55, 0.3],
          origin: "sampled",
          confidence: 0.97,
          sourceFrameId: frameId,
        },
        geometry: { rotation: 0, straighten: 0 },
        restoration: { dust: false, scratches: false, denoise: 0, sharpen: 0 },
      },
    },
  });

  assert.deepEqual(saved.recipe.processing.filmBase, {
    kind: "reference",
    rgb: [0.82, 0.55, 0.3],
    origin: "sampled",
    confidence: 0.97,
    sourceFrameId: frameId,
  });
  assert.deepEqual((await service.load()).recipe.processing.filmBase, saved.recipe.processing.filmBase);
});

test("project storage rejects a source path supplied by an untrusted renderer", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-project-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));

  const service = new ProjectService(directory);
  await assert.rejects(
    service.save({
      rolls: [{
        id: "unsafe-roll",
        title: "不安全项目",
        assets: [{ id: "9f6b32d1-987a-44a6-9fc4-c4011d7ab2ec", name: "C:\\private\\frame.dng", extension: "DNG" }],
        frameOrder: ["9f6b32d1-987a-44a6-9fc4-c4011d7ab2ec"],
      }],
      activeRollId: "unsafe-roll",
      recipe: {
        mode: "generic",
        view: "positive",
        tone: {
          exposureStops: 0,
          contrast: 1,
          highlightCompression: 0,
          saturation: 1,
        },
      },
    }),
    /源文件信息/,
  );
});

test("project storage rejects a roll recipe whose source frame is not in the roll", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-project-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));

  const service = new ProjectService(directory);
  await assert.rejects(
    service.save({
      rolls: [{
        id: "roll-a",
        title: "测试胶卷",
        assets: [{ id: "frame-a", name: "a.tif", extension: "TIF" }],
        frameOrder: ["frame-a"],
        uniformRecipe: {
          sourceFrameId: "frame-missing",
          recipe: {
            mode: "preset",
            view: "positive",
            tone: { exposureStops: 0, contrast: 1, highlightCompression: 0, saturation: 1 },
          },
        },
      }],
      activeRollId: "roll-a",
      recipe: {
        mode: "preset",
        view: "positive",
        tone: { exposureStops: 0, contrast: 1, highlightCompression: 0, saturation: 1 },
      },
    }),
    /来源帧不在胶卷中/,
  );
});

test("project storage rejects frame-recipe keys outside frame order on save and load", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-project-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const service = new ProjectService(directory);
  const recipe = {
    mode: "preset",
    view: "positive",
    tone: { exposureStops: 0, contrast: 1, highlightCompression: 0, saturation: 1 },
  };
  const invalidRoll = {
    id: "roll-a",
    title: "测试胶卷",
    assets: [{ id: "frame-a", name: "a.tif", extension: "TIF" }],
    frameOrder: ["frame-a"],
    recipesByFrameId: {
      "frame-missing": recipe,
    },
  };

  await assert.rejects(
    service.save({
      rolls: [invalidRoll],
      activeRollId: "roll-a",
      recipe,
    }),
    /逐帧配方包含不在帧顺序中的帧 ID/,
  );

  await writeFile(join(directory, "workspace.filmlab.json"), JSON.stringify({
    schemaVersion: 7,
    rolls: [invalidRoll],
    activeRollId: "roll-a",
    recipe,
    presets: [],
    updatedAt: new Date().toISOString(),
  }), "utf8");
  await assert.rejects(
    new ProjectService(directory).load(),
    /项目文件无法读取/,
  );
});

test("project storage migrates a version 2 single-roll project", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-project-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));

  await writeFile(join(directory, "workspace.filmlab.json"), JSON.stringify({
    schemaVersion: 2,
    title: "旧胶卷",
    assets: [{ id: "legacy-frame", name: "legacy.tif", extension: "TIF" }],
    recipe: {
      mode: "generic",
      view: "positive",
      tone: { exposureStops: 0, contrast: 1, highlightCompression: 0, saturation: 1 },
    },
    presets: [],
    updatedAt: new Date().toISOString(),
  }), "utf8");

  const migrated = await new ProjectService(directory).load();
  assert.equal(migrated.schemaVersion, projectSchemaVersion);
  assert.equal(migrated.activeRollId, "legacy-roll");
  assert.equal(migrated.rolls[0]?.title, "旧胶卷");
  assert.equal(migrated.rolls[0]?.assets[0]?.name, "legacy.tif");
  assert.deepEqual(migrated.rolls[0]?.frameOrder, ["legacy-frame"]);
  assert.deepEqual(
    migrated.rolls[0]?.recipesByFrameId?.["legacy-frame"]?.tone,
    migrated.recipe.tone,
  );
});

test("project storage migrates version 3 rolls to an explicit frame order", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-project-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));

  await writeFile(join(directory, "workspace.filmlab.json"), JSON.stringify({
    schemaVersion: 3,
    rolls: [{
      id: "v3-roll",
      title: "上一版胶卷",
      assets: [
        { id: "frame-b", name: "b.tif", extension: "TIF" },
        { id: "frame-a", name: "a.tif", extension: "TIF" },
      ],
    }],
    activeRollId: "v3-roll",
    recipe: {
      mode: "generic",
      view: "positive",
      tone: { exposureStops: 0, contrast: 1, highlightCompression: 0, saturation: 1 },
    },
    presets: [],
    updatedAt: new Date().toISOString(),
  }), "utf8");

  const migrated = await new ProjectService(directory).load();
  assert.deepEqual(migrated.rolls[0]?.frameOrder, ["frame-b", "frame-a"]);
});

test("project storage migrates version 4 rolls without changing frame order", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-project-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));

  await writeFile(join(directory, "workspace.filmlab.json"), JSON.stringify({
    schemaVersion: 4,
    rolls: [{
      id: "v4-roll",
      title: "现有胶卷",
      assets: [{ id: "frame-a", name: "a.tif", extension: "TIF" }],
      frameOrder: ["frame-a"],
    }],
    activeRollId: "v4-roll",
    recipe: {
      mode: "preset",
      view: "positive",
      tone: { exposureStops: 0, contrast: 1.1, highlightCompression: 0.4, saturation: 1 },
    },
    presets: [],
    updatedAt: new Date().toISOString(),
  }), "utf8");

  const migrated = await new ProjectService(directory).load();
  assert.equal(migrated.schemaVersion, projectSchemaVersion);
  assert.deepEqual(migrated.rolls[0]?.frameOrder, ["frame-a"]);
  assert.equal(migrated.rolls[0]?.uniformRecipe, undefined);
  assert.equal(migrated.rolls[0]?.recipesByFrameId?.["frame-a"]?.tone.contrast, 1.1);
});

test("project storage migrates version 5 projects before film-base references", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-project-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));

  await writeFile(join(directory, "workspace.filmlab.json"), JSON.stringify({
    schemaVersion: 5,
    rolls: [{
      id: "v5-roll",
      title: "上一版项目",
      assets: [{ id: "frame-a", name: "a.tif", extension: "TIF" }],
      frameOrder: ["frame-a"],
    }],
    activeRollId: "v5-roll",
    recipe: {
      mode: "preset",
      view: "positive",
      tone: { exposureStops: 0, contrast: 1.1, highlightCompression: 0.4, saturation: 1 },
      processing: {
        baseRoi: { x: 0, y: 0, width: 0.08, height: 1 },
        geometry: {
          rotation: 0,
          straighten: 0,
          lens: { k1: 0.08, k2: -0.02, p1: 0, p2: 0 },
        },
        optical: {
          flatAssetId: "frame-a",
          darkAssetId: "frame-a",
          blackLevel: [0.01, 0.01, 0.01],
          darkScale: 1,
        },
        restoration: { dust: false, scratches: false, denoise: 0, sharpen: 0 },
      },
    },
    presets: [],
    updatedAt: new Date().toISOString(),
  }), "utf8");

  const migrated = await new ProjectService(directory).load();
  assert.equal(migrated.schemaVersion, projectSchemaVersion);
  assert.equal(migrated.recipe.processing.filmBase, undefined);
  assert.deepEqual(migrated.recipe.processing.baseRoi, { x: 0, y: 0, width: 0.08, height: 1 });
  assert.equal("lens" in migrated.recipe.processing.geometry, false);
  assert.equal("optical" in migrated.recipe.processing, false);
  assert.equal(migrated.rolls[0]?.recipesByFrameId?.["frame-a"]?.processing.filmBase, undefined);
});

test("project storage migrates version 6 global recipe into every frame and retains uniform recipe", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-project-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const globalRecipe = {
    mode: "preset",
    view: "positive",
    tone: { exposureStops: 0.4, contrast: 1.25, highlightCompression: 0.35, saturation: 0.88 },
  };
  const uniformRecipe = {
    mode: "generic",
    view: "positive",
    tone: { exposureStops: -0.75, contrast: 0.9, highlightCompression: 0, saturation: 1.1 },
  };

  await writeFile(join(directory, "workspace.filmlab.json"), JSON.stringify({
    schemaVersion: 6,
    rolls: [{
      id: "v6-roll",
      title: "第六版项目",
      assets: [
        { id: "frame-a", name: "a.tif", extension: "TIF" },
        { id: "frame-b", name: "b.tif", extension: "TIF" },
      ],
      frameOrder: ["frame-a", "frame-b"],
      // Version 6 had no per-frame recipes. Even if an unknown field was
      // injected, migration must derive every frame from the legacy global.
      recipesByFrameId: {
        "frame-a": uniformRecipe,
      },
      uniformRecipe: {
        sourceFrameId: "frame-a",
        recipe: uniformRecipe,
      },
    }],
    activeRollId: "v6-roll",
    recipe: globalRecipe,
    presets: [],
    updatedAt: new Date().toISOString(),
  }), "utf8");

  const migrated = await new ProjectService(directory).load();
  assert.equal(migrated.schemaVersion, projectSchemaVersion);
  assert.deepEqual(migrated.rolls[0]?.recipesByFrameId?.["frame-a"]?.tone, globalRecipe.tone);
  assert.deepEqual(migrated.rolls[0]?.recipesByFrameId?.["frame-b"]?.tone, globalRecipe.tone);
  assert.deepEqual(migrated.rolls[0]?.uniformRecipe?.recipe.tone, uniformRecipe.tone);
});
