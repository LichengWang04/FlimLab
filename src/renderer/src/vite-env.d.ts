/// <reference types="vite/client" />
import type {
  RollExportProgress,
  RollExportRequest,
  RollExportResult,
  RollFrameInfo,
  RollOpenMode,
  RollPreview,
  RollThumbnail,
  SingleExportRequest,
  SingleExportResult,
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
      onExportProgress: (callback: (progress: RollExportProgress) => void) => () => void;
    };
  }
}

export {};
