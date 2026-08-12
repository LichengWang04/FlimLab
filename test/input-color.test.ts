import assert from "node:assert/strict";
import test from "node:test";

import { scrgbFloatBufferToRaster } from "../src/main/input-color.ts";

test("float scRGB input remains linear and preserves its extended range", () => {
  const expected = [-0.02, 0.001, 0.18, 0.5, 1, 1.25];
  const values = new Float32Array(expected);
  const raster = scrgbFloatBufferToRaster(new Uint8Array(values.buffer), 2, 1);

  assert.equal(raster.domain, "transmission-linear-rgb");
  for (let index = 0; index < expected.length; index += 1) {
    const actual = raster.data[index];
    assert.ok(
      Math.abs(actual - expected[index]) <= 1e-7,
      `sample ${index}: expected ${expected[index]}, received ${actual}`,
    );
  }
});

test("float scRGB input validates dimensions and finite samples", () => {
  assert.throws(() => scrgbFloatBufferToRaster(new Uint8Array(3), 1, 1), /dimensions/);
  assert.throws(
    () => scrgbFloatBufferToRaster(new Uint8Array(new Float32Array([0, 0, Number.NaN]).buffer), 1, 1),
    /non-finite/,
  );
});
