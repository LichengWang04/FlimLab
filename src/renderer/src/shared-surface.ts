import type { RollPreview } from "../../shared/ipc.ts";

/**
 * Cross the Electron invoke boundary with a cloneable ArrayBuffer, then make
 * exactly one renderer-owned shared copy. The CPU analysis Worker and WebGPU
 * Worker receive this same SharedArrayBuffer without further pixel clones.
 */
export function promotePreviewToSharedSurface(preview: RollPreview): RollPreview {
  const SharedBuffer = globalThis.SharedArrayBuffer;
  if (SharedBuffer === undefined || preview.raster.buffer instanceof SharedBuffer) {
    return preview;
  }
  const raster = new Float32Array(new SharedBuffer(preview.raster.byteLength));
  raster.set(preview.raster);
  return { ...preview, raster };
}
