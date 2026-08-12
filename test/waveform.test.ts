import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWaveform } from "../src/renderer/src/waveform.ts";

test("waveform rejects buffers that do not match the declared dimensions", () => {
  assert.throws(() => computeWaveform(new Uint8Array(15), 2, 2));
  assert.throws(() => computeWaveform(new Uint8Array(2 * 2 * 4), 0, 2));
  assert.throws(() => computeWaveform(new Uint8Array(2 * 2 * 4), 2, -1));
});

test("waveform samples a solid colour into constant channel values", () => {
  const width = 16;
  const height = 12;
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = 200;
    rgba[index * 4 + 1] = 100;
    rgba[index * 4 + 2] = 50;
    rgba[index * 4 + 3] = 255;
  }
  const frame = computeWaveform(rgba, width, height, 8, 6);
  assert.equal(frame.columns, 8);
  assert.equal(frame.samplesPerColumn, 6);
  assert.equal(frame.red.length, 8 * 6);
  assert.ok(frame.red.every((value) => value === 200));
  assert.ok(frame.green.every((value) => value === 100));
  assert.ok(frame.blue.every((value) => value === 50));
  const expectedLuma = 200 * 0.2126 + 100 * 0.7152 + 50 * 0.0722;
  assert.ok(frame.luma.every((value) => Math.abs(value - expectedLuma) < 1e-3));
});

test("waveform samples a horizontal gradient across all columns", () => {
  const width = 32;
  const height = 4;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      rgba[offset] = Math.round(x / (width - 1) * 255);
      rgba[offset + 1] = 0;
      rgba[offset + 2] = 0;
      rgba[offset + 3] = 255;
    }
  }
  const frame = computeWaveform(rgba, width, height, 16, 4);
  assert.equal(frame.columns, 16);
  // Samples are row-major per column: the first column lives at indices
  // {row * columns}, the last at {row * columns + columns - 1}.
  const firstColumn = Array.from({ length: frame.samplesPerColumn }, (_unused, row) => frame.red[row * frame.columns]);
  const lastColumn = Array.from({ length: frame.samplesPerColumn }, (_unused, row) => frame.red[row * frame.columns + frame.columns - 1]);
  assert.ok(Math.max(...firstColumn) < 40, "leftmost column should be dark");
  assert.ok(Math.min(...lastColumn) > 215, "rightmost column should be bright");
});

test("waveform caps sampling on large frames", () => {
  const width = 4096;
  const height = 3072;
  const rgba = new Uint8Array(width * height * 4);
  const frame = computeWaveform(rgba, width, height);
  assert.ok(frame.columns <= 256 + 1, "column count stays bounded");
  assert.ok(frame.samplesPerColumn <= 192 + 1, "sample rows stay bounded");
  assert.ok(frame.red.length <= 256 * 193, "total samples stay bounded");
});
