/// <reference types="vite/client" />
import type { ExportRequest, ExportResult, OpenedSource } from "../../shared/ipc.ts";

declare global {
  interface Window {
    filmlab: {
      openNegative: () => Promise<OpenedSource | null>;
      exportPositive: (request: ExportRequest) => Promise<ExportResult>;
    };
  }
}

export {};
