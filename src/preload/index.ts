import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/ipc.ts";
import type {
  AppInfo,
  RestoredSession,
  RollExportProgress,
  RollExportRequest,
  RollExportResult,
  RollFrameInfo,
  RollOpenMode,
  RollPreview,
  RollThumbnail,
  SingleExportRequest,
  SingleExportResult,
  SessionSaveRequest,
} from "../shared/ipc.ts";

const api = {
  openRoll: (mode: RollOpenMode): Promise<RollFrameInfo[] | null> => (
    ipcRenderer.invoke(IPC_CHANNELS.rollOpen, mode)
  ),
  previewFrame: (id: string): Promise<RollPreview> => ipcRenderer.invoke(IPC_CHANNELS.rollPreview, id),
  thumbnailFrame: (id: string): Promise<RollThumbnail> => ipcRenderer.invoke(IPC_CHANNELS.rollThumbnail, id),
  exportFrame: (request: SingleExportRequest): Promise<SingleExportResult> => (
    ipcRenderer.invoke(IPC_CHANNELS.rollExportSingle, request)
  ),
  exportRoll: (request: RollExportRequest): Promise<RollExportResult> => (
    ipcRenderer.invoke(IPC_CHANNELS.rollExport, request)
  ),
  cancelRollExport: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.rollExportCancel),
  releaseFrame: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.rollRelease, id),
  saveSession: (request: SessionSaveRequest): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.sessionSave, request),
  restoreSession: (): Promise<RestoredSession | null> => ipcRenderer.invoke(IPC_CHANNELS.sessionRestore),
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
  onExportProgress: (callback: (progress: RollExportProgress) => void): (() => void) => {
    const listener = (_event: unknown, progress: RollExportProgress) => callback(progress);
    ipcRenderer.on(IPC_CHANNELS.rollExportProgress, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.rollExportProgress, listener);
  },
};

contextBridge.exposeInMainWorld("filmlab", api);
