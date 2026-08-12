import { contextBridge, ipcRenderer } from "electron";

import type {
  FilmLabApi,
  GpuMasterTiffBeginRequest,
  GpuMasterTiffExportRequest,
  GpuMasterTiffStripRequest,
  MasterTiffExportRequest,
  PreviewPngExportRequest,
  PreviewRequest,
} from "../shared/contracts.ts";
import type { WorkspaceProjectDraft } from "../shared/project.ts";

const api: FilmLabApi = {
  selectSourceFiles: () => ipcRenderer.invoke("project:select-sources"),
  renderPreview: (request: PreviewRequest) => ipcRenderer.invoke("preview:render", request),
  precomputePreview: (request: PreviewRequest) => ipcRenderer.invoke("preview:precompute", request),
  loadProject: () => ipcRenderer.invoke("project:load"),
  createProject: () => ipcRenderer.invoke("project:create"),
  openProject: (readOnly: boolean) => ipcRenderer.invoke("project:open", readOnly),
  openRecentProject: (request) => ipcRenderer.invoke("project:open-recent", request),
  saveProject: (sessionId: string, project: WorkspaceProjectDraft) => ipcRenderer.invoke("project:save", { sessionId, project }),
  saveProjectAs: (sessionId: string, project: WorkspaceProjectDraft) => ipcRenderer.invoke("project:save-as", { sessionId, project }),
  confirmProjectPendingAction: (sessionId: string, project: WorkspaceProjectDraft) => ipcRenderer.invoke("project:confirm-pending", { sessionId, project }),
  createProjectBackup: (sessionId: string) => ipcRenderer.invoke("project:create-backup", sessionId),
  onRequestClose: (listener) => {
    const wrapped = (): void => listener();
    ipcRenderer.on("app:request-close", wrapped);
    return () => ipcRenderer.removeListener("app:request-close", wrapped);
  },
  confirmClose: () => ipcRenderer.send("app:confirm-close"),
  exportPreviewPng: (request: PreviewPngExportRequest) => ipcRenderer.invoke("preview:export-png", request),
  exportMasterTiff: (request: MasterTiffExportRequest) => ipcRenderer.invoke("master:export-tiff", request),
  exportGpuMasterTiff: (request: GpuMasterTiffExportRequest) => ipcRenderer.invoke("master:export-gpu-tiff", request),
  beginGpuMasterTiff: (request: GpuMasterTiffBeginRequest) => ipcRenderer.invoke("master:begin-gpu-tiff", request),
  appendGpuMasterTiffStrip: (request: GpuMasterTiffStripRequest) => ipcRenderer.invoke("master:append-gpu-tiff-strip", request),
  finishGpuMasterTiff: (sessionId: string) => ipcRenderer.invoke("master:finish-gpu-tiff", sessionId),
  cancelGpuMasterTiff: (sessionId: string) => ipcRenderer.invoke("master:cancel-gpu-tiff", sessionId),
  importCalibrationProfile: () => ipcRenderer.invoke("calibration:import"),
  listCalibrationProfiles: () => ipcRenderer.invoke("calibration:list"),
  generateCalibrationFromColorCard: (assetId, processing) => ipcRenderer.invoke("calibration:generate-from-card", { assetId, processing }),
  relinkProjectSources: (assets) => ipcRenderer.invoke("project:relink-sources", assets),
  startBatchTiffExport: (request) => ipcRenderer.invoke("batch:start-tiff", request),
  getBatchJob: (jobId) => ipcRenderer.invoke("batch:get", jobId),
  cancelBatchJob: (jobId) => ipcRenderer.invoke("batch:cancel", jobId),
};

contextBridge.exposeInMainWorld("filmlab", api);
