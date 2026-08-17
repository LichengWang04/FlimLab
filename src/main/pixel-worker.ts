import { parentPort } from "node:worker_threads";
import { executeKernelTask } from "./parallel-kernel.ts";
import type { KernelTask } from "./parallel-kernel.ts";

if (parentPort === null) throw new Error("Pixel worker requires a parent port.");

parentPort.on("message", (task: KernelTask) => {
  try {
    executeKernelTask(task);
    parentPort!.postMessage({ taskId: task.taskId, ok: true });
  } catch (error) {
    parentPort!.postMessage({
      taskId: task.taskId,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
