import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CalibrationProfileService } from "../src/main/calibration-profile-service.ts";
import { ProjectLifecycleService } from "../src/main/project-lifecycle-service.ts";
import { projectSchemaVersion } from "../src/shared/project.ts";

test("project lifecycle restores the active session and recent list after restart", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "filmlab-lifecycle-startup-"));
  context.after(async () => rm(root, { recursive: true, force: true }));

  const service = createService(root);
  const created = await service.create(join(root, "projects", "alpha"));
  assert.equal(created.session.readOnly, false);
  assert.equal(created.session.pendingAction, undefined);
  assert.equal(created.session.name, "alpha");
  assert.equal(created.project.schemaVersion, projectSchemaVersion);

  const restarted = createService(root);
  const loaded = await restarted.loadStartup();
  assert.equal(loaded.session.projectId, created.session.projectId);
  assert.equal(loaded.session.name, "alpha");
  assert.equal(loaded.session.readOnly, false);

  const recents = await restarted.recentProjects();
  assert.equal(recents[0]?.name, "alpha");
  assert.equal(recents[0]?.available, true);
  assert.equal(recents[0]?.id, created.session.projectId);

  await assert.rejects(restarted.openRecent("not-an-opaque-id", false), /无效/);
  await assert.rejects(restarted.openRecent("0".repeat(64), false), /不存在/);
});

test("project lifecycle enforces read-only sessions and allows save-as", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "filmlab-lifecycle-readonly-"));
  context.after(async () => rm(root, { recursive: true, force: true }));

  const service = createService(root);
  await service.create(join(root, "projects", "bravo"));
  const bundlePath = join(root, "projects", "bravo.filmlab");

  const opened = await service.open(bundlePath, true);
  assert.equal(opened.session.readOnly, true);
  await assert.rejects(service.save(opened.session.id, draft()), /只读/);
  await assert.rejects(service.createBackup(opened.session.id), /只读/);

  const savedAs = await service.saveAs(opened.session.id, draft("另存卷"), join(root, "projects", "charlie"));
  assert.equal(savedAs.session.readOnly, false);
  assert.equal(savedAs.session.name, "charlie");
  assert.equal(savedAs.project.rolls[0]?.title, "另存卷");
});

test("project lifecycle rejects saves from a session that was switched away", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "filmlab-lifecycle-stale-"));
  context.after(async () => rm(root, { recursive: true, force: true }));

  const service = createService(root);
  const first = await service.create(join(root, "projects", "delta"));
  const second = await service.create(join(root, "projects", "echo"));
  assert.notEqual(first.session.id, second.session.id);

  await assert.rejects(service.save(first.session.id, draft()), /已切换/);
  await assert.rejects(service.confirmPending(first.session.id, draft()), /已切换/);

  const saved = await service.save(second.session.id, draft("新标题"));
  assert.equal(saved.project.rolls[0]?.title, "新标题");
  assert.equal(saved.backupCount, 1);
});

test("project lifecycle opens an old schema as a read-only migration preview", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "filmlab-lifecycle-migration-"));
  context.after(async () => rm(root, { recursive: true, force: true }));

  const bundlePath = join(root, "projects", "legacy.filmlab");
  await mkdir(bundlePath, { recursive: true });
  await writeFile(join(bundlePath, "project.json"), JSON.stringify({
    schemaVersion: 7,
    rolls: [{ id: "roll-a", title: "旧版胶卷", assets: [], frameOrder: [] }],
    activeRollId: "roll-a",
    recipe: {
      mode: "preset",
      view: "positive",
      tone: { exposureStops: 0.2, contrast: 1.1, highlightCompression: 0.3, saturation: 1 },
    },
    presets: [],
    updatedAt: new Date().toISOString(),
  }), "utf8");

  const service = createService(root);
  const opened = await service.open(bundlePath, false);
  assert.equal(opened.session.pendingAction, "migration");
  assert.equal(opened.session.migratedFromVersion, 7);
  assert.equal(opened.session.readOnly, true);
  assert.equal(opened.project.schemaVersion, projectSchemaVersion);
  assert.equal(opened.project.rolls[0]?.title, "旧版胶卷");

  await assert.rejects(service.save(opened.session.id, draft()), /确认/);

  const confirmed = await service.confirmPending(opened.session.id, draft("迁移后"));
  assert.equal(confirmed.session.pendingAction, undefined);
  assert.equal(confirmed.session.readOnly, false);
  assert.equal(confirmed.project.rolls[0]?.title, "迁移后");

  const reopened = await service.open(bundlePath, false);
  assert.equal(reopened.session.pendingAction, undefined);
  assert.equal(reopened.session.readOnly, false);
  assert.equal(reopened.project.rolls[0]?.title, "迁移后");
});

test("project lifecycle recovers a corrupted main file from the latest valid backup", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "filmlab-lifecycle-recovery-"));
  context.after(async () => rm(root, { recursive: true, force: true }));

  const service = createService(root);
  const created = await service.create(join(root, "projects", "foxtrot"));
  const bundlePath = join(root, "projects", "foxtrot.filmlab");
  await service.save(created.session.id, draft("已保存"));

  await writeFile(join(bundlePath, "project.json"), "{ 已损坏", "utf8");

  const opened = await service.open(bundlePath, false);
  assert.equal(opened.session.pendingAction, "recovery");
  assert.equal(opened.session.readOnly, true);
  // The automatic backup captured the project before the save overwrote it.
  assert.equal(opened.project.rolls[0]?.title, "未命名胶卷");

  const confirmed = await service.confirmPending(opened.session.id, draft("恢复确认"));
  assert.equal(confirmed.session.pendingAction, undefined);
  assert.equal(confirmed.session.readOnly, false);
  assert.equal(confirmed.project.rolls[0]?.title, "恢复确认");
});

test("project lifecycle rejects a corrupted project that has no usable backup", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "filmlab-lifecycle-broken-"));
  context.after(async () => rm(root, { recursive: true, force: true }));

  const bundlePath = join(root, "projects", "broken.filmlab");
  await mkdir(bundlePath, { recursive: true });
  await writeFile(join(bundlePath, "project.json"), "not a project", "utf8");

  const service = createService(root);
  await assert.rejects(service.open(bundlePath, false), /已损坏且没有可用备份/);
  await assert.rejects(
    service.open(join(root, "projects", "plain-directory"), false),
    /以 \.filmlab 结尾/,
  );
});

function createService(root: string): ProjectLifecycleService {
  return new ProjectLifecycleService(
    join(root, "projects"),
    join(root, "state", "projects-state.json"),
    new CalibrationProfileService(join(root, "profiles")),
  );
}

function draft(title = "测试卷"): unknown {
  return {
    rolls: [{ id: "roll-a", title, assets: [], frameOrder: [] }],
    activeRollId: "roll-a",
    recipe: {
      mode: "preset",
      view: "positive",
      tone: { exposureStops: 0, contrast: 1, highlightCompression: 0, saturation: 1 },
    },
  };
}
