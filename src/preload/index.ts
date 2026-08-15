import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/ipc.ts";
import type { ExportRequest, ExportResult, OpenedSource } from "../shared/ipc.ts";

const api = {
  openNegative: (): Promise<OpenedSource | null> => ipcRenderer.invoke(IPC_CHANNELS.openNegative),
  exportPositive: (request: ExportRequest): Promise<ExportResult> => (
    ipcRenderer.invoke(IPC_CHANNELS.exportPositive, request)
  ),
};

contextBridge.exposeInMainWorld("filmlab", api);
