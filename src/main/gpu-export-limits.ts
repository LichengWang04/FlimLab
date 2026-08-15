export const maximumGpuMasterDimension = 32_768;
export const maximumGpuStripRows = 1_024;
export const maximumGpuStripBytes = 64 * 1_024 * 1_024;

export function gpuMasterDimensionsAreWithinLimits(
  width: number,
  height: number,
  rowsPerStrip: number,
): boolean {
  return Number.isInteger(width)
    && Number.isInteger(height)
    && Number.isInteger(rowsPerStrip)
    && width > 0
    && width <= maximumGpuMasterDimension
    && height > 0
    && height <= maximumGpuMasterDimension
    && rowsPerStrip >= 32
    && rowsPerStrip <= maximumGpuStripRows
    && width * Math.min(height, rowsPerStrip) * 3 * Uint16Array.BYTES_PER_ELEMENT <= maximumGpuStripBytes
    && width * height <= 80_000_000;
}

export function gpuStripPayloadIsWithinLimits(
  width: number,
  height: number,
  data: Uint16Array,
): boolean {
  return Number.isInteger(width)
    && Number.isInteger(height)
    && width > 0
    && width <= maximumGpuMasterDimension
    && height > 0
    && height <= maximumGpuStripRows
    && data.byteLength <= maximumGpuStripBytes
    && data.length === width * height * 3;
}
