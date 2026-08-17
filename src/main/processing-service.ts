import { Worker } from "node:worker_threads";
import exportWorkerPath from "./export-worker?modulePath";
import pixelWorkerPath from "./pixel-worker?modulePath";
import { ProcessingServiceCore } from "./processing-service-core.ts";

/** Long-lived background export worker with one bounded in-flight job. */
export class ProcessingService extends ProcessingServiceCore {
  constructor() {
    super(() => (
      new Worker(exportWorkerPath, { workerData: { pixelWorkerPath } })
    ));
  }
}
