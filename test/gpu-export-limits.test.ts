import assert from "node:assert/strict";
import test from "node:test";

import {
  gpuMasterDimensionsAreWithinLimits,
  gpuStripPayloadIsWithinLimits,
  maximumGpuMasterDimension,
  maximumGpuStripBytes,
  maximumGpuStripRows,
} from "../src/main/gpu-export-limits.ts";

test("GPU master dimensions have independent axis and strip-byte limits", () => {
  assert.equal(gpuMasterDimensionsAreWithinLimits(9_504, 6_336, 256), true);
  assert.equal(gpuMasterDimensionsAreWithinLimits(maximumGpuMasterDimension + 1, 1, 32), false);
  assert.equal(gpuMasterDimensionsAreWithinLimits(1, maximumGpuMasterDimension + 1, 32), false);
  assert.equal(gpuMasterDimensionsAreWithinLimits(1, 1, maximumGpuStripRows + 1), false);
  assert.equal(gpuMasterDimensionsAreWithinLimits(20_000, 1_000, 1_000), false);
});

test("GPU strip payloads reject oversized dimensions and byte buffers", () => {
  assert.equal(gpuStripPayloadIsWithinLimits(4, 2, new Uint16Array(24)), true);
  assert.equal(gpuStripPayloadIsWithinLimits(maximumGpuMasterDimension + 1, 1, new Uint16Array(3)), false);
  assert.equal(gpuStripPayloadIsWithinLimits(1, maximumGpuStripRows + 1, new Uint16Array(3)), false);
  assert.equal(gpuStripPayloadIsWithinLimits(4, 2, new Uint16Array(23)), false);
  const oversized = new Uint16Array(maximumGpuStripBytes / Uint16Array.BYTES_PER_ELEMENT + 1);
  assert.equal(gpuStripPayloadIsWithinLimits(1, 1, oversized), false);
});
