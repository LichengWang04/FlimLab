import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import type { CalibrationProfileDocument } from "../src/core/calibration.ts";
import { BatchService, type BatchSource } from "../src/main/batch-service.ts";
import type { ProcessingService } from "../src/main/processing-service.ts";
import {
  defaultProcessingRecipe,
  type BatchJobSummary,
} from "../src/shared/contracts.ts";

type ExportRequest = Parameters<ProcessingService["exportTiff"]>[2];

class RecordingProcessingService {
  public readonly calls: Array<{
    readonly assetId: string;
    readonly sourcePath: string;
    readonly request: ExportRequest;
  }> = [];
  public maximumActive = 0;
  private active = 0;

  public async exportTiff(
    assetId: string,
    sourcePath: string,
    request: ExportRequest,
  ): Promise<void> {
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      this.calls.push({ assetId, sourcePath, request });
    } finally {
      this.active -= 1;
    }
  }
}

test("batch export keeps each frame's recipe and remains sequential", async () => {
  const processing = new RecordingProcessingService();
  const service = new BatchService(processing as unknown as ProcessingService);
  const calibrationProfile = { id: "profile-b" } as CalibrationProfileDocument;
  const sources: readonly BatchSource[] = [
    {
      item: {
        assetId: "frame-a",
        mode: "generic",
        tone: {
          exposureStops: -0.4,
          contrast: 0.9,
          highlightCompression: 0.2,
          saturation: 0.8,
        },
        processing: {
          ...defaultProcessingRecipe,
          geometry: { rotation: 90, straighten: 0 },
          restoration: { dust: false, scratches: false, denoise: 0.1, sharpen: 0 },
        },
      },
      sourcePath: "C:\\sources\\a.arw",
      sourceName: "a.arw",
    },
    {
      item: {
        assetId: "frame-b",
        mode: "calibrated",
        tone: {
          exposureStops: 0.75,
          contrast: 1.35,
          highlightCompression: 0.65,
          saturation: 1.2,
        },
        calibrationProfileId: "profile-b",
        processing: {
          ...defaultProcessingRecipe,
          geometry: {
            rotation: 0,
            straighten: 1.25,
            crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
          },
          restoration: { dust: true, scratches: false, denoise: 0, sharpen: 0.6 },
        },
      },
      sourcePath: "C:\\sources\\b.tif",
      sourceName: "b.tif",
      calibrationProfile,
    },
  ];

  const started = service.start(sources, "C:\\exports");
  assert.equal("sources" in started, false);
  assert.equal("outputDirectory" in started, false);
  const completed = await waitForTerminalJob(service, started.id);

  assert.equal(completed.state, "completed");
  assert.equal(completed.total, 2);
  assert.equal(completed.completed, 2);
  assert.deepEqual(completed.failedAssetIds, []);
  assert.equal("sources" in completed, false);
  assert.equal("outputDirectory" in completed, false);
  assert.equal(processing.maximumActive, 1);
  assert.deepEqual(processing.calls.map((call) => call.assetId), ["frame-a", "frame-b"]);

  const first = processing.calls[0]?.request;
  const second = processing.calls[1]?.request;
  assert.equal(first?.mode, "generic");
  assert.equal(first?.tone.exposureStops, -0.4);
  assert.equal(first?.processing?.geometry.rotation, 90);
  assert.equal(first?.calibrationProfile, undefined);
  assert.equal(basename(first?.outputPath ?? ""), "001-a-positive.tiff");
  assert.equal(second?.mode, "calibrated");
  assert.equal(second?.tone.exposureStops, 0.75);
  assert.equal(second?.processing?.geometry.straighten, 1.25);
  assert.equal(second?.calibrationProfile, calibrationProfile);
  assert.equal(basename(second?.outputPath ?? ""), "002-b-positive.tiff");
});

test("batch export preserves an existing output by selecting a numbered name", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "filmlab-batch-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "001-scan-positive.tiff"), "existing", "utf8");

  const processing = new RecordingProcessingService();
  const service = new BatchService(processing as unknown as ProcessingService);
  const started = service.start([{
    item: {
      assetId: "frame-a",
      mode: "generic",
      tone: {
        exposureStops: 0,
        contrast: 1,
        highlightCompression: 0,
        saturation: 1,
      },
      processing: defaultProcessingRecipe,
    },
    sourcePath: "C:\\sources\\scan.tif",
    sourceName: "scan.tif",
  }], directory);

  const completed = await waitForTerminalJob(service, started.id);
  assert.equal(completed.state, "completed");
  assert.equal(
    basename(processing.calls[0]?.request.outputPath ?? ""),
    "001-scan-positive-2.tiff",
  );
});

async function waitForTerminalJob(
  service: BatchService,
  id: string,
): Promise<BatchJobSummary> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = service.get(id);
    if (
      job !== undefined
      && (job.state === "completed" || job.state === "cancelled" || job.state === "failed")
    ) {
      return job;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Batch job did not finish.");
}
