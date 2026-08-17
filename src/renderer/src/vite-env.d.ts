/// <reference types="vite/client" />
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
} from "../../shared/ipc.ts";

declare global {
  interface Window {
    filmlab: {
      openRoll: (mode: RollOpenMode) => Promise<RollFrameInfo[] | null>;
      previewFrame: (id: string) => Promise<RollPreview>;
      thumbnailFrame: (id: string) => Promise<RollThumbnail>;
      exportFrame: (request: SingleExportRequest) => Promise<SingleExportResult>;
      exportRoll: (request: RollExportRequest) => Promise<RollExportResult>;
      cancelRollExport: () => Promise<void>;
      releaseFrame: (id: string) => Promise<boolean>;
      saveSession: (request: SessionSaveRequest) => Promise<void>;
      restoreSession: () => Promise<RestoredSession | null>;
      appInfo: () => Promise<AppInfo>;
      onExportProgress: (callback: (progress: RollExportProgress) => void) => () => void;
    };
  }
}

export {};
