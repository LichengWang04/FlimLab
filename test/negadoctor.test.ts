import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_NEGADOCTOR_56,
  DEFAULT_RECIPE,
  NEGADOCTOR_56_BW_PRESET,
  NEGADOCTOR_56_COLOR_PRESET,
  NegativeSession,
  Raster,
  analyzeNegadoctor56,
  convertLinearRgb,
  encode16,
  encode8,
  negadoctor56Range,
  processNegative,
  validateNegadoctor56,
} from "../src/core/index.ts";
import type { NegadoctorRecipe, Rgb } from "../src/core/index.ts";
import { parseRecipe } from "../src/main/ipc-validation.ts";
import { executeKernelTask } from "../src/main/parallel-kernel.ts";

const THRESHOLD = 2 ** -32;

function oracle(input: number, dmin: number, recipe: NegadoctorRecipe, channel: 0 | 1 | 2): number {
  const density = -Math.log10(dmin / Math.max(input, THRESHOLD));
  const high = recipe.highlightBalanceRgb[channel];
  const corrected = high / recipe.dmax * density
    + high * recipe.scanExposureBias * recipe.shadowCastRgb[channel];
  const paper = Math.pow(Math.max(
    0,
    recipe.printExposure * (1 + recipe.paperBlack - Math.pow(10, corrected)),
  ), recipe.paperGrade);
  if (paper <= recipe.paperGloss) return paper;
  if (recipe.paperGloss === 1) return 1;
  const complement = 1 - recipe.paperGloss;
  return recipe.paperGloss + (1 - Math.exp(-(paper - recipe.paperGloss) / complement)) * complement;
}

function runKernel(input: Rgb, recipe: NegadoctorRecipe, dmin: Rgb): Rgb {
  const source = new Float32Array(input);
  const target = new Float32Array(3);
  negadoctor56Range(source, target, 0, 1, recipe, dmin);
  return [...target] as Rgb;
}

describe("Negadoctor 5.6 frozen contract", () => {
  it("exposes the darktable 5.6 defaults and official presets", () => {
    assert.deepEqual(DEFAULT_NEGADOCTOR_56.dminRgb, [1, 0.45, 0.25]);
    assert.equal(DEFAULT_NEGADOCTOR_56.dmax, 2.046);
    assert.equal(DEFAULT_NEGADOCTOR_56.scanExposureBias, -0.05);
    assert.deepEqual(DEFAULT_NEGADOCTOR_56.shadowCastRgb, [1, 1, 1]);
    assert.deepEqual(DEFAULT_NEGADOCTOR_56.highlightBalanceRgb, [1, 1, 1]);
    assert.equal(DEFAULT_NEGADOCTOR_56.paperBlack, 0.0755);
    assert.equal(DEFAULT_NEGADOCTOR_56.paperGrade, 4);
    assert.equal(DEFAULT_NEGADOCTOR_56.paperGloss, 0.75);
    assert.equal(DEFAULT_NEGADOCTOR_56.printExposure, 0.9245);
    assert.deepEqual(NEGADOCTOR_56_COLOR_PRESET.dminRgb, [1.13, 0.49, 0.27]);
    assert.equal(NEGADOCTOR_56_COLOR_PRESET.dmax, 1.6);
    assert.deepEqual(NEGADOCTOR_56_BW_PRESET.dminRgb, [1, 1, 1]);
    assert.equal(NEGADOCTOR_56_BW_PRESET.dmax, 2.2);
    assert.equal(NEGADOCTOR_56_BW_PRESET.paperGrade, 5);
    assert.equal(NEGADOCTOR_56_BW_PRESET.printExposure, 1);
  });

  it("matches an independent scalar oracle within 2e-6", () => {
    const recipe: NegadoctorRecipe = {
      ...DEFAULT_NEGADOCTOR_56,
      workingSpace: "linear-srgb",
      dmax: 1.73,
      scanExposureBias: -0.12,
      shadowCastRgb: [0.81, 1.04, 1.31],
      highlightBalanceRgb: [1.22, 0.93, 0.77],
      paperBlack: 0.11,
      paperGrade: 3.6,
      paperGloss: 0.68,
      printExposure: 1.08,
    };
    const dmin: Rgb = [1.13, 0.49, 0.27];
    const input: Rgb = [0.071, 0.15, 0.004];
    const actual = runKernel(input, recipe, dmin);
    for (const channel of [0, 1, 2] as const) {
      assert.ok(Math.abs(actual[channel] - oracle(input[channel], dmin[channel], recipe, channel)) <= 2e-6);
    }
  });

  it("handles zero, -32 EV transmission, channel corrections, and a gloss of one", () => {
    const recipe: NegadoctorRecipe = {
      ...DEFAULT_NEGADOCTOR_56,
      workingSpace: "linear-srgb",
      paperGloss: 1,
      printExposure: 2,
      paperBlack: 0.5,
      shadowCastRgb: [0.25, 1, 2],
      highlightBalanceRgb: [2, 1, 0.25],
    };
    const dmin: Rgb = [1, 0.45, 0.25];
    const zero = runKernel([0, 0, 0], recipe, dmin);
    const threshold = runKernel([THRESHOLD, THRESHOLD, THRESHOLD], recipe, dmin);
    assert.deepEqual(zero, threshold);
    assert.ok(zero.every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
    const corrected = runKernel([0.1, 0.1, 0.1], { ...recipe, printExposure: 0.8, paperBlack: 0 }, dmin);
    assert.notEqual(corrected[0], corrected[2]);
  });

  it("survives corrupt pixels with finite output instead of propagating NaN", () => {
    const recipe = { ...DEFAULT_NEGADOCTOR_56, workingSpace: "linear-srgb" } satisfies NegadoctorRecipe;
    // Non-finite or non-positive samples fall onto the fmaxf threshold.
    const subnormal = runKernel([Number.NaN, Number.NEGATIVE_INFINITY, -1], recipe, recipe.dminRgb);
    const threshold = runKernel([THRESHOLD, THRESHOLD, THRESHOLD], recipe, recipe.dminRgb);
    assert.deepEqual(subnormal, threshold);
    // +Infinity survives as an infinite density and prints paper white (0).
    const infinite = runKernel([Number.NaN, Number.POSITIVE_INFINITY, -1], recipe, recipe.dminRgb);
    assert.ok([...subnormal, ...infinite].every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
  });

  it("clamps analysis ROIs that overshoot the raster by the IPC rounding slack", () => {
    const width = 32;
    const height = 24;
    const data = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const border = x < 4 || y < 4 || x >= width - 4 || y >= height - 4;
        const density = border ? 0 : 0.15 + 1.7 * (x - 4) / (width - 9);
        const offset = (y * width + x) * 3;
        data[offset] = 1 * 10 ** -density;
        data[offset + 1] = 0.45 * 10 ** -(density * 1.03 + 0.01);
        data[offset + 2] = 0.25 * 10 ** -(density * 0.97 + 0.02);
      }
    }
    const source = new Raster(width, height, "transmission-linear", data);
    const recipe = { ...DEFAULT_NEGADOCTOR_56, workingSpace: "linear-srgb" } satisfies NegadoctorRecipe;
    const fullFrame = { ...recipe, contentRoi: { x: 0, y: 0, width: 1, height: 1 } };
    const overshoot = analyzeNegadoctor56(source, {
      ...fullFrame,
      contentRoi: { x: 0, y: 0, width: 1 + 5e-9, height: 1 },
    });
    assert.deepEqual(overshoot, analyzeNegadoctor56(source, fullFrame));
  });

  it("uses the red Dmin component for every channel in black-and-white mode", () => {
    const color = processNegative(
      new Raster(1, 1, "transmission-linear", new Float32Array([0.2, 0.2, 0.2])),
      { ...DEFAULT_NEGADOCTOR_56, workingSpace: "linear-srgb", dminRgb: [1, 0.5, 0.25] },
    );
    const monochrome = processNegative(
      new Raster(1, 1, "transmission-linear", new Float32Array([0.2, 0.2, 0.2])),
      { ...DEFAULT_NEGADOCTOR_56, workingSpace: "linear-srgb", filmStock: "black-and-white", dminRgb: [1, 0.5, 0.25] },
    );
    assert.notEqual(color.display.data[0], color.display.data[1]);
    assert.equal(monochrome.display.data[0], monochrome.display.data[1]);
    assert.equal(monochrome.display.data[1], monochrome.display.data[2]);
  });

  it("validates every documented parameter boundary", () => {
    validateNegadoctor56({ ...DEFAULT_NEGADOCTOR_56, paperGloss: 1 });
    assert.throws(() => validateNegadoctor56({ ...DEFAULT_NEGADOCTOR_56, dmax: 0.09 }), /Dmax/);
    assert.throws(() => validateNegadoctor56({ ...DEFAULT_NEGADOCTOR_56, dminRgb: [0, 1, 1] }), /Dmin/);
    assert.throws(() => validateNegadoctor56({ ...DEFAULT_NEGADOCTOR_56, shadowCastRgb: [2.01, 1, 1] }), /阴影/);
    assert.throws(() => validateNegadoctor56({ ...DEFAULT_NEGADOCTOR_56, paperGrade: 8.01 }), /相纸等级/);
  });

  it("writes deterministic robust automatic values back into legal parameter ranges", () => {
    const width = 40;
    const height = 32;
    const data = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const border = x < 4 || y < 4 || x >= width - 4 || y >= height - 4;
        const density = border ? 0 : 0.15 + 1.7 * (x - 4) / (width - 9);
        const offset = (y * width + x) * 3;
        data[offset] = 1 * 10 ** -density;
        data[offset + 1] = 0.45 * 10 ** -(density * 1.03 + 0.01);
        data[offset + 2] = 0.25 * 10 ** -(density * 0.97 + 0.02);
      }
    }
    const source = new Raster(width, height, "transmission-linear", data);
    const recipe = { ...DEFAULT_NEGADOCTOR_56, workingSpace: "linear-srgb" } satisfies NegadoctorRecipe;
    const first = analyzeNegadoctor56(source, recipe);
    const second = analyzeNegadoctor56(source, recipe);
    assert.deepEqual(first, second);
    assert.ok(first.dmax >= 0.1 && first.dmax <= 6);
    assert.ok(first.printExposure >= 0.5 && first.printExposure <= 2);
    validateNegadoctor56({ ...recipe, ...first, baseMode: "manual" });
  });
});

describe("Negadoctor colour spaces and execution paths", () => {
  it("reuses invariant preview preparation without changing RGBA output", () => {
    const width = 31;
    const height = 17;
    const values = new Float32Array(width * height * 3);
    for (let index = 0; index < values.length; index += 1) {
      values[index] = 0.001 + 0.98 * ((index * 41) % values.length) / values.length;
    }
    const source = new Raster(width, height, "transmission-linear", values);
    const session = new NegativeSession(source);
    session.processPreview(DEFAULT_NEGADOCTOR_56);
    const adjusted = { ...DEFAULT_NEGADOCTOR_56, printExposure: 0.95 } satisfies NegadoctorRecipe;
    const cached = session.processPreview(adjusted);
    const canonical = encode8(processNegative(source, adjusted).display);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      assert.deepEqual(Array.from(cached.rgba.subarray(pixel * 4, pixel * 4 + 3)), Array.from(canonical.subarray(pixel * 3, pixel * 3 + 3)));
      assert.equal(cached.rgba[pixel * 4 + 3], 255);
    }
    assert.deepEqual(session.stats, { geometry: 1, analysis: 1, inversion: 2, balance: 0, tone: 2 });
  });

  it("round-trips linear sRGB and Rec.2020 while preserving D65 neutrals", () => {
    for (const rgb of [[0, 0, 0], [0.18, 0.18, 0.18], [1, 1, 1], [1.2, -0.1, 0.4]] as Rgb[]) {
      const rec2020 = convertLinearRgb(rgb, "srgb", "rec2020");
      const roundTrip = convertLinearRgb(rec2020, "rec2020", "srgb");
      for (const channel of [0, 1, 2] as const) assert.ok(Math.abs(roundTrip[channel] - rgb[channel]) < 2e-12);
      if (rgb[0] === rgb[1] && rgb[1] === rgb[2]) {
        assert.ok(Math.abs(rec2020[0] - rec2020[1]) < 2e-12);
        assert.ok(Math.abs(rec2020[1] - rec2020[2]) < 2e-12);
      }
    }
  });

  it("keeps the partitioned kernel identical to the synchronous pixel kernel", () => {
    const recipe = { ...DEFAULT_NEGADOCTOR_56, workingSpace: "linear-srgb" } satisfies NegadoctorRecipe;
    const values = new Float32Array(96 * 3);
    for (let index = 0; index < values.length; index += 1) values[index] = 0.001 + index / values.length;
    const expected = new Float32Array(values.length);
    negadoctor56Range(values, expected, 0, 96, recipe, recipe.dminRgb);
    const pixels = new SharedArrayBuffer(values.byteLength);
    new Float32Array(pixels).set(values);
    for (let part = 0; part < 4; part += 1) {
      executeKernelTask({
        taskId: part,
        action: "negadoctor",
        startPixel: part * 24,
        endPixel: (part + 1) * 24,
        pixels,
        base: recipe.dminRgb,
        negadoctorRecipe: recipe,
      });
    }
    assert.deepEqual(new Float32Array(pixels), expected);
  });

  it("matches synchronous Rec.2020 processing and 8/16-bit quantization exactly", () => {
    const recipe = { ...DEFAULT_NEGADOCTOR_56 } satisfies NegadoctorRecipe;
    const width = 32;
    const height = 8;
    const values = new Float32Array(width * height * 3);
    for (let index = 0; index < values.length; index += 1) values[index] = 0.0001 + 0.999 * ((index * 37) % values.length) / values.length;
    const canonical = processNegative(new Raster(width, height, "transmission-linear", values), recipe).display;
    const pixels = new SharedArrayBuffer(values.byteLength);
    new Float32Array(pixels).set(values);
    const pixelCount = width * height;
    const execute = (action: "primaries" | "negadoctor" | "encode8" | "encode16", output?: SharedArrayBuffer) => {
      for (let part = 0; part < 4; part += 1) executeKernelTask({
        taskId: part,
        action,
        startPixel: part * pixelCount / 4,
        endPixel: (part + 1) * pixelCount / 4,
        pixels,
        ...(action === "primaries"
          ? { fromPrimaries: output === undefined ? "srgb" : "rec2020", toPrimaries: output === undefined ? "rec2020" : "srgb" }
          : action === "negadoctor"
            ? { base: recipe.dminRgb, negadoctorRecipe: recipe }
            : { output }),
      });
    };
    execute("primaries");
    execute("negadoctor");
    execute("primaries", new SharedArrayBuffer(0));
    const output8 = new SharedArrayBuffer(pixelCount * 3);
    const output16 = new SharedArrayBuffer(pixelCount * 3 * Uint16Array.BYTES_PER_ELEMENT);
    execute("encode8", output8);
    execute("encode16", output16);
    assert.deepEqual(new Uint8Array(output8), encode8(canonical));
    assert.deepEqual(new Uint16Array(output16), encode16(canonical));
  });

  it("migrates recipes without an engine to classic without changing values", () => {
    const { engine: _engine, ...legacy } = { ...DEFAULT_RECIPE, exposure: 0.37, contrast: 1.14 };
    const migrated = parseRecipe(legacy);
    assert.equal(migrated.engine, "classic");
    assert.deepEqual(migrated, { ...DEFAULT_RECIPE, exposure: 0.37, contrast: 1.14 });
    const width = 12;
    const height = 12;
    const source = new Raster(width, height, "transmission-linear", new Float32Array(width * height * 3).map((_, index) => (
      0.2 + 0.75 * ((index * 17) % (width * height * 3)) / (width * height * 3)
    )));
    const before = processNegative(source, { ...DEFAULT_RECIPE, exposure: 0.37, contrast: 1.14 });
    const after = processNegative(source, migrated);
    assert.deepEqual(after.display.data, before.display.data);
    assert.deepEqual(after.anchors, before.anchors);
    assert.deepEqual(parseRecipe(DEFAULT_NEGADOCTOR_56), DEFAULT_NEGADOCTOR_56);
    const boundary = parseRecipe({ ...DEFAULT_NEGADOCTOR_56, paperGloss: 1 });
    assert.equal(boundary.engine === "negadoctor-5.6" ? boundary.paperGloss : undefined, 1);
  });
});
