import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyGains,
  applyDensityCurve,
  cropRaster,
  createGeometryPlan,
  DEFAULT_RECIPE,
  downscaleRaster,
  encode16,
  encode8,
  estimateFilmBase,
  estimateWhiteBalance,
  estimateWhitePoint,
  invertDensity,
  measureDensityAnchors,
  NegativeSession,
  normalizeRotation,
  percentile,
  processNegative,
  Raster,
  rotateRaster,
  sampleFilmBase,
  srgbOetf,
  srgbToLinear,
  straightenAngle,
  temperatureToGains,
  toRelativeDensity,
  toneMap,
  toneMapEncodeRgba8,
  validateRect,
} from "../src/core/index.ts";
import { getSrgb16Quantizer, getSrgb8Quantizer } from "../src/core/encode.ts";
import type { ChannelFit, ClassicRecipe, DensityCurve, RasterDomain, Rect, Rgb } from "../src/core/index.ts";
import { executeKernelTask } from "../src/main/parallel-kernel.ts";
import type { KernelAction, KernelTask } from "../src/main/parallel-kernel.ts";

type PixelFn = (x: number, y: number) => Rgb;

function build(width: number, height: number, domain: RasterDomain = "transmission-linear", fn: PixelFn = () => [0, 0, 0]): Raster {
  const raster = new Raster(width, height, domain);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = Raster.offsetOf(x, y, width);
      const [r, g, b] = fn(x, y);
      raster.data[offset] = r;
      raster.data[offset + 1] = g;
      raster.data[offset + 2] = b;
    }
  }
  return raster;
}

function approx(actual: number | undefined, expected: number, tolerance = 1e-6, message = ""): void {
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) <= tolerance,
    `${message} expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

function baseRecipe(overrides: Partial<ClassicRecipe> = {}): ClassicRecipe {
  return { ...DEFAULT_RECIPE, ...overrides };
}

describe("Raster", () => {
  it("rejects non-positive or fractional dimensions", () => {
    assert.throws(() => new Raster(0, 4, "transmission-linear"));
    assert.throws(() => new Raster(4, 0, "transmission-linear"));
    assert.throws(() => new Raster(4.5, 4, "transmission-linear"));
  });

  it("rejects data whose length does not match the dimensions", () => {
    assert.throws(() => new Raster(2, 2, "transmission-linear", new Float32Array(11)));
  });

  it("enforces the declared domain", () => {
    const transmission = new Raster(1, 1, "transmission-linear");
    transmission.assertDomain(["transmission-linear"]);
    assert.throws(() => transmission.assertDomain(["relative-density"]));
  });

  it("clones with a detached buffer", () => {
    const raster = build(2, 1);
    raster.data[0] = 0.25;
    const clone = raster.clone();
    clone.data[0] = 0.75;
    assert.equal(raster.data[0], 0.25);
  });

  it("computes row-major offsets", () => {
    assert.equal(Raster.offsetOf(1, 1, 2), 9);
  });
});

describe("Geometry", () => {
  it("rotates 90 degrees clockwise without interpolation", () => {
    const source = build(2, 1, "transmission-linear", (x) => (x === 0 ? [1, 2, 3] : [4, 5, 6]));
    const rotated = rotateRaster(source, 90);
    assert.equal(rotated.width, 1);
    assert.equal(rotated.height, 2);
    assert.deepEqual([...rotated.data.slice(0, 3)], [1, 2, 3]);
    assert.deepEqual([...rotated.data.slice(3, 6)], [4, 5, 6]);
  });

  it("restores the original after four quarter turns", () => {
    const source = build(3, 2, "transmission-linear", (x, y) => [x, y, x + y]);
    for (const quarter of [90, 180, 270] as const) {
      let current = source;
      for (let turn = 0; turn < 4; turn += 1) current = rotateRaster(current, quarter);
      assert.deepEqual([...current.data], [...source.data]);
      assert.equal(current.width, source.width);
      assert.equal(current.height, source.height);
    }
  });

  it("treats zero rotation as identity", () => {
    const source = build(2, 2);
    assert.equal(rotateRaster(source, 0), source);
  });

  it("bilinearly rotates into the largest rectangle without empty corners", () => {
    const source = build(100, 60, "transmission-linear", () => [0.25, 0.5, 0.75]);
    const rotated = rotateRaster(source, 30);
    assert.ok(rotated.width < source.width);
    assert.ok(rotated.height < source.height);
    for (let offset = 0; offset < rotated.data.length; offset += 3) {
      approx(rotated.data[offset], 0.25, 1e-6);
      approx(rotated.data[offset + 1], 0.5, 1e-6);
      approx(rotated.data[offset + 2], 0.75, 1e-6);
    }
  });

  it("derives the same straighten correction in either line direction", () => {
    const forward = straightenAngle({ x: 10, y: 10 }, { x: 110, y: 30 });
    const reverse = straightenAngle({ x: 110, y: 30 }, { x: 10, y: 10 });
    approx(forward, reverse, 1e-12);
    approx(forward, -Math.atan2(20, 100) * 180 / Math.PI, 1e-12);
    approx(normalizeRotation(370), 10, 1e-12);
    approx(normalizeRotation(-190), 170, 1e-12);
  });

  it("rejects invalid rotation and straighten inputs", () => {
    const source = build(2, 2);
    assert.throws(() => rotateRaster(source, Number.NaN));
    assert.throws(() => straightenAngle({ x: 1, y: 1 }, { x: 1, y: 1 }));
  });

  it("crops with clamped pixel rounding", () => {
    const source = build(10, 10, "transmission-linear", (x, y) => [x, y, 0]);
    const cropped = cropRaster(source, { x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
    assert.equal(cropped.width, 3);
    assert.equal(cropped.height, 4);
    // Target (0,0) corresponds to source pixel (1,2).
    assert.deepEqual([...cropped.data.slice(0, 3)], [1, 2, 0]);
  });

  it("clamps out-of-bounds crops to the frame", () => {
    const source = build(10, 10, "transmission-linear", (x) => [x, 0, 0]);
    const cropped = cropRaster(source, { x: 0.8, y: 0.8, width: 0.9, height: 0.9 });
    assert.equal(cropped.width, 2);
    assert.equal(cropped.height, 2);
    assert.deepEqual([...cropped.data.slice(0, 3)], [8, 0, 0]);
  });

  it("rejects degenerate rectangles", () => {
    assert.throws(() => validateRect({ x: 0, y: 0, width: 0, height: 1 }));
    assert.throws(() => validateRect({ x: 0, y: 0, width: Number.NaN, height: 1 }));
    assert.throws(() => cropRaster(build(4, 4), { x: 0, y: 0, width: 0, height: 1 }));
  });

  it("downscales with an area average", () => {
    const source = build(2, 1, "transmission-linear", (x) => (x === 0 ? [0.2, 0.4, 0.6] : [0.8, 0.2, 0.1]));
    const half = downscaleRaster(source, 1);
    assert.equal(half.width, 1);
    assert.equal(half.height, 1);
    approx(half.data[0]!, 0.5);
    approx(half.data[1]!, 0.3);
    approx(half.data[2]!, 0.35);
  });

  it("never upscales and passes small frames through", () => {
    const source = build(3, 2, "transmission-linear");
    assert.equal(downscaleRaster(source, 8), source);
  });
});

describe("Film base sampling", () => {
  const base: Rgb = [0.8, 0.5, 0.3];

  it("recovers the exact base from a clean border ROI", () => {
    const frame = build(100, 20, "transmission-linear", (x, y) => {
      const content = x >= 10 ? (x + y) / 20 * 0.1 : 0;
      return [base[0] - content, base[1] - content, base[2] - content];
    });
    const sample = sampleFilmBase(frame, { x: 0, y: 0, width: 0.08, height: 1 });
    approx(sample.rgb[0], 0.8);
    approx(sample.rgb[1], 0.5);
    approx(sample.rgb[2], 0.3);
    assert.equal(sample.confidence, 1);
    assert.equal(sample.method, "roi");
  });

  it("clamps an ROI that overshoots the raster by the IPC rounding slack", () => {
    const frame = build(100, 20, "transmission-linear", (x, y) => {
      const content = x >= 10 ? (x + y) / 20 * 0.1 : 0;
      return [base[0] - content, base[1] - content, base[2] - content];
    });
    const overshoot = sampleFilmBase(frame, { x: 0, y: 0, width: 1 + 5e-9, height: 1 + 5e-9 });
    const exact = sampleFilmBase(frame, { x: 0, y: 0, width: 1, height: 1 });
    assert.deepEqual(overshoot.rgb, exact.rgb);
    assert.equal(overshoot.confidence, exact.confidence);
    assert.equal(overshoot.sampleCount, exact.sampleCount);
  });

  it("ignores dust and content inside the ROI", () => {
    const frame = build(100, 20, "transmission-linear", (x, y) => {
      // Base pixels plus a minority of bright dust and dark content.
      const hash = (x * 31 + y * 17) % 10;
      if (hash === 0) return [0.05, 0.05, 0.05];
      if (hash === 1) return [0.99, 0.99, 0.99];
      return base;
    });
    const sample = sampleFilmBase(frame, { x: 0, y: 0, width: 1, height: 1 });
    approx(sample.rgb[0], 0.8);
    approx(sample.rgb[1], 0.5);
    approx(sample.rgb[2], 0.3);
    assert.ok(sample.confidence >= 0.79 && sample.confidence < 1);
  });

  it("rejects an ROI that is too small", () => {
    const frame = build(20, 20, "transmission-linear");
    assert.throws(
      () => sampleFilmBase(frame, { x: 0, y: 0, width: 0.01, height: 0.01 }),
      /片基/,
    );
  });

  it("rejects an ROI without positive samples", () => {
    const frame = build(20, 20, "transmission-linear");
    assert.throws(() => sampleFilmBase(frame, { x: 0, y: 0, width: 1, height: 1 }));
  });

  it("estimates the upper transmission envelope automatically", () => {
    const envelope: Rgb = [0.7, 0.45, 0.28];
    const frame = build(128, 128, "transmission-linear", (x, y) => {
      const isBase = (x * 7 + y * 13) % 97 === 0;
      const scale = isBase ? 1 : 0.2 + ((x * 3 + y * 5) % 40) / 200;
      return [envelope[0] * scale, envelope[1] * scale, envelope[2] * scale];
    });
    const sample = estimateFilmBase(frame);
    approx(sample.rgb[0], 0.7, 0.01);
    approx(sample.rgb[1], 0.45, 0.01);
    approx(sample.rgb[2], 0.28, 0.01);
    assert.equal(sample.method, "automatic");
    assert.ok(sample.confidence <= 0.65);
  });

  it("caps automatic confidence at 0.65 even for a perfect frame", () => {
    const frame = build(64, 64, "transmission-linear", () => [0.4, 0.4, 0.4]);
    assert.equal(estimateFilmBase(frame).confidence, 0.65);
  });

  it("requires at least 32 valid pixels for automatic estimation", () => {
    const frame = build(2, 2, "transmission-linear", () => [0.4, 0.4, 0.4]);
    assert.throws(() => estimateFilmBase(frame));
  });
});

describe("Density", () => {
  const base: Rgb = [1, 1, 1];

  it("maps base transmission to density zero", () => {
    const frame = build(8, 8, "transmission-linear", () => base);
    const density = toRelativeDensity(frame, base);
    assert.equal(density.domain, "relative-density");
    for (const value of density.data) assert.equal(value, 0);
  });

  it("maps one tenth transmission to density one", () => {
    const frame = build(4, 4, "transmission-linear", () => [0.1, 0.1, 0.1]);
    const density = toRelativeDensity(frame, base);
    for (const value of density.data) approx(value, 1);
  });

  it("maps non-finite or zero transmission to base (density zero)", () => {
    const frame = build(2, 1, "transmission-linear", (x) => (
      x === 0 ? [Number.NaN, 0, -1] : [0.1, 0.1, 0.1]
    ));
    const density = toRelativeDensity(frame, base);
    assert.equal(density.data[0], 0);
    approx(density.data[1], 6); // -log10(1e-6)
    approx(density.data[2], 6); // negative transmission clamps to extreme density
    approx(density.data[3], 1);
  });

  it("rejects invalid base values", () => {
    const frame = build(4, 4, "transmission-linear");
    assert.throws(() => toRelativeDensity(frame, [0, 1, 1]));
    assert.throws(() => toRelativeDensity(frame, [1, 1, 1], 0));
  });
});

describe("Density anchors", () => {
  it("measures dmin from the base transmission", () => {
    const base: Rgb = [0.5, 0.5, 0.5];
    const frame = build(32, 32, "transmission-linear", () => [0.05, 0.05, 0.05]);
    const density = toRelativeDensity(frame, base);
    const anchors = measureDensityAnchors(base, density);
    approx(anchors.dmin, -Math.log10(0.5));
    approx(anchors.range, 1); // D = -log10(0.05/0.5) = 1 everywhere
    approx(anchors.dmax, -Math.log10(0.5) + 1);
    assert.equal(anchors.channelFit, undefined);
  });

  it("honours a manual Dmax override", () => {
    const base: Rgb = [0.5, 0.5, 0.5];
    const frame = build(32, 32, "transmission-linear", () => [0.05, 0.05, 0.05]);
    const density = toRelativeDensity(frame, base);
    const anchors = measureDensityAnchors(base, density, 0.995, { dmaxOverride: 2.0 });
    approx(anchors.range, 2.0 - anchors.dmin);
    assert.equal(anchors.channelFit, undefined);
  });

  it("rejects an out-of-range manual Dmax", () => {
    const base: Rgb = [0.5, 0.5, 0.5];
    const frame = build(8, 8, "transmission-linear");
    const density = toRelativeDensity(frame, base);
    assert.throws(() => measureDensityAnchors(base, density, 0.995, { dmaxOverride: 17 }));
    assert.throws(() => measureDensityAnchors(base, density, 0.995, { dmaxOverride: -1 }));
  });

  it("falls back to per-channel ranges when a neutral ROI lacks density spread", () => {
    const base: Rgb = [0.8, 0.5, 0.3];
    const frame = build(32, 32, "transmission-linear", (x) => {
      const densities: Rgb = x < 16 ? [1.5, 1.4, 1.6] : [0.3, 0.3, 0.3];
      return [
        base[0] * Math.pow(10, -densities[0]),
        base[1] * Math.pow(10, -densities[1]),
        base[2] * Math.pow(10, -densities[2]),
      ];
    });
    const density = toRelativeDensity(frame, base);
    const anchors = measureDensityAnchors(base, density, 0.995, {
      neutralRoi: { x: 0, y: 0, width: 0.5, height: 1 },
    });
    assert.ok(anchors.channelFit);
    approx(anchors.channelFit!.slope[0], 1.5, 1e-6);
    approx(anchors.channelFit!.slope[1], 1.4, 1e-6);
    approx(anchors.channelFit!.slope[2], 1.6, 1e-6);
    assert.deepEqual(anchors.channelFit!.offset, [0, 0, 0]);
  });

  it("falls back to a single neutral-tail anchor without density spread", () => {
    const base: Rgb = [1, 1, 1];
    const frame = build(32, 32, "transmission-linear", (x, y) => {
      const inTail = x < 3; // ~9.4% of the frame
      const rgb: Rgb = inTail ? [2.2, 2.0, 2.1] : [0.5, 0.6, 0.4];
      return [
        base[0] * Math.pow(10, -rgb[0]),
        base[1] * Math.pow(10, -rgb[1]),
        base[2] * Math.pow(10, -rgb[2]),
      ];
    });
    const density = toRelativeDensity(frame, base);
    const neutral = measureDensityAnchors(base, density, 0.995, { autoNeutralize: true });
    assert.ok(neutral.channelFit);
    approx(neutral.channelFit!.slope[0], 2.2, 0.01);
    approx(neutral.channelFit!.slope[1], 2.0, 0.01);
    approx(neutral.channelFit!.slope[2], 2.1, 0.01);
    assert.deepEqual(neutral.channelFit!.offset, [0, 0, 0]);
  });

  it("does not infer a channel fit from a colourful tail", () => {
    const base: Rgb = [1, 1, 1];
    const frame = build(32, 32, "transmission-linear", (x) => {
      const rgb: Rgb = x < 3 ? [2.5, 1.2, 1.2] : [0.5, 0.5, 0.5];
      return [
        base[0] * Math.pow(10, -rgb[0]),
        base[1] * Math.pow(10, -rgb[1]),
        base[2] * Math.pow(10, -rgb[2]),
      ];
    });
    const density = toRelativeDensity(frame, base);
    const anchors = measureDensityAnchors(base, density, 0.995, { autoNeutralize: true });
    assert.equal(anchors.channelFit, undefined);
  });

  it("fits an affine per-channel response from neutrals across the tonal range", () => {
    // A neutral scene whose residual cast follows D_c = slope_c * s + offset_c
    // at every density s. The fit must recover both parameters so neutrals
    // stay neutral everywhere, not just at one anchor density.
    const slope: Rgb = [1, 0.95, 1.05];
    const offset: Rgb = [0.02, 0, 0.03];
    const levels = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    const base: Rgb = [1, 1, 1];
    const frame = build(40, 40, "transmission-linear", (x) => {
      const s = levels[x % levels.length]!;
      return [
        base[0] * Math.pow(10, -(slope[0] * s + offset[0])),
        base[1] * Math.pow(10, -(slope[1] * s + offset[1])),
        base[2] * Math.pow(10, -(slope[2] * s + offset[2])),
      ];
    });
    const density = toRelativeDensity(frame, base);
    const anchors = measureDensityAnchors(base, density, 0.995, { autoNeutralize: true });
    assert.ok(anchors.channelFit, "affine fit should fire for a low-chroma scene");
    assert.equal(anchors.channelCurves, undefined, "a truly affine response must not grow a curve");
    approx(anchors.channelFit!.slope[0], 1, 0.02);
    approx(anchors.channelFit!.slope[1], 0.95, 0.02);
    approx(anchors.channelFit!.slope[2], 1.05, 0.02);
    approx(anchors.channelFit!.offset[0], 0.02, 0.02);
    approx(anchors.channelFit!.offset[1], 0, 0.02);
    approx(anchors.channelFit!.offset[2], 0.03, 0.02);

    // Inversion through the fit yields near-identical channels at every
    // level, including low densities where a single-anchor normalization
    // leaves a visible cast. Fitted parameters carry estimation error, so
    // values are checked loosely while channel equality stays tight.
    const scene = invertDensity(density, anchors, { preSaturation: 1 });
    for (const s of levels) {
      const offsetIndex = Raster.offsetOf(levels.indexOf(s), 0, 40);
      const expected = Math.pow(10, s) - 1;
      approx(scene.data[offsetIndex]!, expected, expected * 0.08, `red at s=${s}`);
      approx(scene.data[offsetIndex + 1]!, scene.data[offsetIndex]!, expected * 0.02, `green at s=${s}`);
      approx(scene.data[offsetIndex + 2]!, scene.data[offsetIndex]!, expected * 0.02, `blue at s=${s}`);
    }
  });

  it("fits a neutral axis across 0.2-2.5 D with 30% colourful outliers", () => {
    const base: Rgb = [1, 1, 1];
    const slope: Rgb = [1.12, 0.92, 0.96];
    const channelOffset: Rgb = [0.04, -0.03, -0.01];
    const frame = build(100, 60, "transmission-linear", (x, y) => {
      const neutral = 0.2 + 2.3 * ((x * 37 + y * 19) % 97) / 96;
      const density = slope.map((value, channel) => value * neutral + channelOffset[channel]!) as Rgb;
      if ((x * 7 + y * 13) % 10 < 3) {
        const dominant = (x + y) % 3;
        density[dominant] = density[dominant]! + 0.9;
        const secondary = (dominant + 1) % 3;
        density[secondary] = density[secondary]! + 0.15;
      }
      return density.map((value) => Math.pow(10, -Math.max(0, value))) as Rgb;
    });
    const density = toRelativeDensity(frame, base);
    const anchors = measureDensityAnchors(base, density, 0.995, { autoNeutralize: true });
    assert.ok(anchors.channelFit, "the stratified neutral axis should survive colourful outliers");

    const scene = invertDensity(density, anchors, { preSaturation: 1 });
    for (const [x, y] of [[2, 1], [23, 17], [47, 29], [81, 43]] as const) {
      if ((x * 7 + y * 13) % 10 < 3) continue;
      const at = Raster.offsetOf(x, y, 100);
      const recovered = [0, 1, 2].map((channel) => Math.log10(scene.data[at + channel]! + 1));
      const spread = Math.max(...recovered) - Math.min(...recovered);
      assert.ok(spread <= 0.02, `neutral residual ${spread} D at ${x},${y}`);
    }
  });

  it("uses monotone curves for toe/shoulder casts with 30% colourful outliers", () => {
    const width = 120;
    const height = 80;
    const base: Rgb = [1, 1, 1];
    const frame = build(width, height, "transmission-linear", (x, y) => {
      if ((x * 17 + y * 23) % 257 === 0) return [0, 1, 0]; // clipped dust/scratch pixel
      const neutral = 0.2 + 2.3 * ((x * 37 + y * 19) % 127) / 126;
      const bend = neutral * (neutral - 1.35);
      const density: Rgb = [
        neutral + 0.08 * bend,
        neutral - 0.01 * bend,
        neutral - 0.07 * bend,
      ];
      if ((x * 7 + y * 13) % 10 < 3) {
        const dominant = (x + y) % 3;
        density[dominant] = density[dominant]! + 0.9;
        density[(dominant + 1) % 3] = density[(dominant + 1) % 3]! + 0.15;
      }
      return density.map((value) => Math.pow(10, -Math.max(0, value))) as Rgb;
    });
    const density = toRelativeDensity(frame, base);
    const anchors = measureDensityAnchors(base, density, 0.995, { autoNeutralize: true });
    assert.equal(anchors.neutralization?.method, "curve");
    assert.ok(anchors.neutralization!.improvement >= 0.1);
    assert.ok(anchors.channelCurves);
    for (const curve of anchors.channelCurves!) {
      assert.ok(curve.input.length >= 9);
      for (let index = 1; index < curve.input.length; index += 1) {
        assert.ok(curve.input[index]! > curve.input[index - 1]!);
        assert.ok(curve.output[index]! >= curve.output[index - 1]!);
      }
    }

    const scene = invertDensity(density, anchors, { preSaturation: 1 });
    let maximumResidual = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if ((x * 17 + y * 23) % 257 === 0 || (x * 7 + y * 13) % 10 < 3) continue;
        const at = Raster.offsetOf(x, y, width);
        const recovered = [0, 1, 2].map((channel) => Math.log10(scene.data[at + channel]! + 1));
        maximumResidual = Math.max(maximumResidual, Math.max(...recovered) - Math.min(...recovered));
      }
    }
    assert.ok(maximumResidual <= 0.02, `curve residual ${maximumResidual} D`);
  });

  it("selects robust PCA when a sparse tonal ramp cannot support binned regression", () => {
    const base: Rgb = [1, 1, 1];
    const frame = build(12, 12, "transmission-linear", (x, y) => {
      const neutral = 0.2 + 2.1 * ((x * 7 + y * 3) % 15) / 14;
      const density: Rgb = [1.15 * neutral + 0.03, 0.92 * neutral - 0.02, 0.93 * neutral - 0.01];
      return density.map((value) => Math.pow(10, -Math.max(0, value))) as Rgb;
    });
    const anchors = measureDensityAnchors(base, toRelativeDensity(frame, base), 0.995, { autoNeutralize: true });
    assert.equal(anchors.neutralization?.method, "pca");
    assert.ok(anchors.channelFit);
    assert.equal(anchors.channelCurves, undefined);
  });

  it("rejects a curve that only improves the spatial training split", () => {
    const width = 120;
    const height = 80;
    const base: Rgb = [1, 1, 1];
    const hash = (x: number, y: number): number => {
      let value = Math.imul(x + 1, 0x1f123bb5) ^ Math.imul(y + 1, 0x5f356495);
      value ^= value >>> 16;
      value = Math.imul(value, 0x45d9f3b);
      value ^= value >>> 16;
      return value >>> 0;
    };
    const frame = build(width, height, "transmission-linear", (x, y) => {
      const neutral = 0.2 + 2.3 * ((x * 37 + y * 19) % 127) / 126;
      const bend = hash(x, y) % 5 === 0 ? 0 : neutral * (neutral - 1.35);
      const density: Rgb = [neutral + 0.08 * bend, neutral - 0.01 * bend, neutral - 0.07 * bend];
      return density.map((value) => Math.pow(10, -Math.max(0, value))) as Rgb;
    });
    const anchors = measureDensityAnchors(base, toRelativeDensity(frame, base), 0.995, { autoNeutralize: true });
    assert.notEqual(anchors.neutralization?.method, "curve");
    assert.equal(anchors.channelCurves, undefined);
  });
});

describe("Inversion", () => {
  const anchors = { dmin: 0.3, dmax: 1.3, range: 1.0 };

  function invert(
    values: Rgb[],
    options: { channelFit?: ChannelFit; preSaturation?: number } = {},
  ) {
    const width = values.length;
    const density = new Raster(width, 1, "relative-density");
    values.forEach(([r, g, b], index) => {
      const offset = index * 3;
      density.data[offset] = r;
      density.data[offset + 1] = g;
      density.data[offset + 2] = b;
    });
    return invertDensity(density, {
      ...anchors,
      channelFit: options.channelFit,
    }, {
      preSaturation: options.preSaturation ?? 1,
    });
  }

  it("implements the conservative 10^D - 1 transform without a channel range", () => {
    const scene = invert([
      [0, 0, 0],
      [1, 1, 1],
      [2, 2, 2],
      [0.5, 0.5, 0.5],
    ]);
    approx(scene.data[0], 0);
    approx(scene.data[3], 9);
    approx(scene.data[6], 99);
    approx(scene.data[9], Math.sqrt(10) - 1);
  });

  it("normalizes density by the per-channel fit and caps at 4x", () => {
    const identityFit: ChannelFit = { offset: [0, 0, 0], slope: [1, 1, 1] };
    const scene = invert(
      [[1, 1, 1], [2, 2, 2], [5, 5, 5]],
      { channelFit: identityFit },
    );
    approx(scene.data[0], 9);
    approx(scene.data[3], 99);
    approx(scene.data[6], 9999);
  });

  it("neutralizes an affine channel response at every density", () => {
    const fit: ChannelFit = { offset: [0.2, 0, -0.1], slope: [1.2, 1, 0.8] };
    // These triples sit on the fitted lines: (D - offset) / slope = 1, 2, 0.5.
    const scene = invert(
      [[1.4, 1, 0.7], [2.6, 2, 1.5], [0.8, 0.5, 0.3]],
      { channelFit: fit },
    );
    approx(scene.data[0], 9, 1e-3);
    approx(scene.data[1], 9, 1e-3);
    approx(scene.data[2], 9, 1e-3);
    approx(scene.data[3], 99, 1e-3);
    approx(scene.data[4], 99, 1e-3);
    approx(scene.data[5], 99, 1e-3);
    approx(scene.data[6], Math.sqrt(10) - 1, 1e-3);
    approx(scene.data[7], Math.sqrt(10) - 1, 1e-3);
    approx(scene.data[8], Math.sqrt(10) - 1, 1e-3);
  });

  it("clamps negative density to zero", () => {
    const scene = invert([[-1, -1, -1]]);
    assert.deepEqual([...scene.data], [0, 0, 0]);
  });

  it("rejects invalid pre-saturation and channel fits", () => {
    assert.throws(() => invert([[1, 1, 1]], { preSaturation: 3 }));
    assert.throws(() => invert([[1, 1, 1]], { channelFit: { offset: [0, 0, 0], slope: [0.01, 1, 1] } }));
    assert.throws(() => invert([[1, 1, 1]], { channelFit: { offset: [0, 3, 0], slope: [1, 1, 1] } }));
  });

  it("preserves the density-domain mean under pre-saturation", () => {
    const density = [1.2, 0.9, 1.5] as Rgb;
    const fit: ChannelFit = { offset: [0, 0, 0], slope: [1, 1, 1] };
    const scene = invert([density], { preSaturation: 1.08, channelFit: fit });
    // Pre-saturation spreads channels around their mean without moving it;
    // after 10^D - 1 the density-domain mean is recovered via log10(v + 1).
    const mean = density.reduce((sum, value) => sum + value, 0) / 3;
    const recovered = [0, 1, 2].map((index) => Math.log10(scene.data[index]! + 1));
    approx((recovered[0]! + recovered[1]! + recovered[2]!) / 3, mean, 1e-6);
  });

  it("applies pre-saturation after channel normalization", () => {
    const fit: ChannelFit = { offset: [0.08, -0.03, -0.05], slope: [1.15, 0.9, 0.95] };
    const neutral = 1.2;
    const density: Rgb = [
      fit.offset[0] + fit.slope[0] * neutral,
      fit.offset[1] + fit.slope[1] * neutral,
      fit.offset[2] + fit.slope[2] * neutral,
    ];
    const scene = invert([density], { channelFit: fit, preSaturation: 1.7 });
    approx(scene.data[0], scene.data[1]!, 1e-5);
    approx(scene.data[1], scene.data[2]!, 1e-5);
  });

  it("interpolates curves continuously and bounds endpoint extrapolation", () => {
    const curve: DensityCurve = { input: [0, 1, 2], output: [0, 0.5, 2] };
    approx(applyDensityCurve(1 - 1e-7, curve), applyDensityCurve(1 + 1e-7, curve), 1e-6);
    const shallow: DensityCurve = { input: [0, 1], output: [0, 0.1] };
    approx(applyDensityCurve(-0.1, shallow), -0.025, 1e-9);
    assert.ok(Math.abs(applyDensityCurve(3, shallow) - 3) <= 0.35 + 1e-9);
  });

  it("rejects non-monotone density curves", () => {
    const densityCurve: DensityCurve = { input: [0, 1, 0.5], output: [0, 1, 2] };
    const density = new Raster(1, 1, "relative-density");
    density.data.set([1, 1, 1]);
    assert.throws(() => invertDensity(density, {
      ...anchors,
      channelFit: { offset: [0, 0, 0], slope: [1, 1, 1] },
      channelCurves: [densityCurve, densityCurve, densityCurve],
    }, { preSaturation: 1 }));
  });
});

describe("White balance", () => {
  it("maps manual colour temperature around a neutral 5500 K point", () => {
    assert.deepEqual(temperatureToGains(5500), [1, 1, 1]);
    const cool = temperatureToGains(2500);
    const warm = temperatureToGains(10_000);
    assert.ok(cool[2] > cool[0], `2500 K gains ${cool.join("/")} should cool the image`);
    assert.ok(warm[0] > warm[2], `10000 K gains ${warm.join("/")} should warm the image`);
    for (const gains of [cool, warm]) {
      assert.equal(gains[1], 1);
      assert.ok(gains.every((value) => Number.isFinite(value) && value >= 0.25 && value <= 4));
    }
    assert.throws(() => temperatureToGains(2499));
    assert.throws(() => temperatureToGains(10_001));
  });

  it("estimates gray-world gains from per-channel medians", () => {
    const scene = new Raster(32, 16, "scene-linear-rgb");
    for (let i = 0; i < scene.data.length; i += 3) {
      scene.data[i] = 0.4;
      scene.data[i + 1] = 0.2;
      scene.data[i + 2] = 0.1;
    }
    const gains = estimateWhiteBalance(scene);
    approx(gains[0], 0.5, 1e-9);
    approx(gains[1], 1, 1e-9);
    approx(gains[2], 2, 1e-9);
  });

  it("clamps gains to [0.25, 4] and ignores a minority of outliers", () => {
    const scene = new Raster(64, 16, "scene-linear-rgb");
    for (let i = 0; i < scene.data.length; i += 3) {
      scene.data[i] = 1.0;
      scene.data[i + 1] = 0.1;
      scene.data[i + 2] = 0.05;
    }
    // 10% extreme pixels must not move the medians.
    for (let i = 0; i < scene.data.length * 0.1; i += 3) {
      scene.data[i] = 500;
      scene.data[i + 1] = 500;
      scene.data[i + 2] = 500;
    }
    const gains = estimateWhiteBalance(scene);
    approx(gains[0], 0.25, 1e-9); // 0.1 / 1.0, clamped
    approx(gains[1], 1, 1e-9);
    approx(gains[2], 2, 1e-9); // 0.1 / 0.05, within range
  });

  it("returns identity for black or tiny frames", () => {
    const black = new Raster(16, 16, "scene-linear-rgb");
    assert.deepEqual(estimateWhiteBalance(black), [1, 1, 1]);
    const tiny = new Raster(1, 1, "scene-linear-rgb");
    tiny.data.set([0.2, 0.2, 0.2]);
    assert.deepEqual(estimateWhiteBalance(tiny), [1, 1, 1]);
  });

  it("multiplies channels and preserves the domain", () => {
    const scene = new Raster(1, 1, "scene-linear-rgb");
    scene.data.set([2, 4, 8]);
    const out = applyGains(scene, [1.5, 1, 0.5]);
    assert.equal(out.domain, "scene-linear-rgb");
    assert.deepEqual([...out.data], [3, 4, 4]);
  });

  it("rejects invalid gains", () => {
    const scene = new Raster(1, 1, "scene-linear-rgb");
    assert.throws(() => applyGains(scene, [Number.NaN, 1, 1]));
    assert.throws(() => applyGains(scene, [1, -0.5, 1]));
  });

  it("corrects an illuminant cast end-to-end when enabled", () => {
    // Colourful content (no channel fit fires) with a warm scene-side cast
    // of +0.08 D red and -0.06 D blue per channel.
    const base: Rgb = [0.8, 0.5, 0.3];
    const cast: Rgb = [0.08, 0, -0.06];
    const frame = build(64, 64, "transmission-linear", (x, y) => {
      if (x < 6) return [...base]; // unexposed border
      const channel = (x * 31 + y * 17) % 3;
      const density: Rgb = channel === 0
        ? [1.0, 0.15, 0.15]
        : channel === 1
          ? [0.15, 1.0, 0.15]
          : [0.15, 0.15, 1.0];
      return [
        base[0] * Math.pow(10, -(density[0] + cast[0])),
        base[1] * Math.pow(10, -(density[1] + cast[1])),
        base[2] * Math.pow(10, -(density[2] + cast[2])),
      ];
    });
    const withWb = processNegative(frame, baseRecipe({ autoWhiteBalance: true }));
    const withoutWb = processNegative(frame, baseRecipe({ autoWhiteBalance: false }));
    assert.ok(withWb.autoGains);

    const median = (raster: Raster, channel: number) => {
      const values: number[] = [];
      for (let index = channel; index < raster.data.length; index += 3) values.push(raster.data[index]!);
      values.sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)]!;
    };
    const red = median(withWb.display, 0);
    const green = median(withWb.display, 1);
    const blue = median(withWb.display, 2);
    approx(red, green, green * 0.01);
    approx(blue, green, green * 0.01);

    // Without auto WB the cast stays visible in the same medians.
    const castRed = median(withoutWb.display, 0);
    const castGreen = median(withoutWb.display, 1);
    const castBlue = median(withoutWb.display, 2);
    assert.ok(castRed / castGreen > 1.3, `red/green ${castRed / castGreen} should keep the cast`);
    assert.ok(castBlue / castGreen < 0.8, `blue/green ${castBlue / castGreen} should keep the cast`);
  });

  it("uses temperature only when automatic white balance is disabled", () => {
    const frame = build(40, 40, "transmission-linear", (x) => {
      const density = 0.2 + x / 30;
      return [0.8, 0.5, 0.3].map((base) => base * Math.pow(10, -density)) as Rgb;
    });
    const automaticCool = processNegative(frame, baseRecipe({ autoWhiteBalance: true, temperatureKelvin: 2500 }));
    const automaticWarm = processNegative(frame, baseRecipe({ autoWhiteBalance: true, temperatureKelvin: 10_000 }));
    assert.deepEqual([...automaticCool.display.data], [...automaticWarm.display.data]);

    const manualNeutral = processNegative(frame, baseRecipe({ autoWhiteBalance: false, temperatureKelvin: 5500 }));
    const manualWarm = processNegative(frame, baseRecipe({ autoWhiteBalance: false, temperatureKelvin: 10_000 }));
    const sample = Raster.offsetOf(20, 20, 40);
    assert.ok(manualWarm.display.data[sample]! > manualNeutral.display.data[sample]!);
    assert.ok(manualWarm.display.data[sample + 2]! < manualNeutral.display.data[sample + 2]!);
  });
});

describe("Tone mapping", () => {
  it("normalizes a solid mid-grey scene to display white", () => {
    const scene = build(16, 16, "scene-linear-rgb", () => [0.18, 0.18, 0.18]);
    const { display, whitePoint } = toneMap(scene, baseRecipe());
    approx(whitePoint, 0.18);
    for (const value of display.data) approx(value, 1);
  });

  it("brightens by one stop relative to the white point", () => {
    const scene = build(16, 16, "scene-linear-rgb", () => [0.18, 0.18, 0.18]);
    const { display } = toneMap(scene, baseRecipe({ exposure: 1 }));
    for (const value of display.data) approx(value, 2);
  });

  it("applies log-domain contrast around 0.18 mid grey", () => {
    const scene = new Raster(1, 1, "scene-linear-rgb");
    scene.data.set([0.36, 0.36, 0.36]);
    const { display } = toneMap(scene, baseRecipe({ contrast: 1.2 }));
    const expected = 0.18 * Math.pow(2, 1.2) / 0.36;
    for (const value of display.data) approx(value, expected);
  });

  it("compresses values above the knee", () => {
    const scene = new Raster(1, 1, "scene-linear-rgb");
    scene.data.set([1.5, 1.5, 1.5]);
    const { display } = toneMap(scene, baseRecipe({ highlightCompression: 0.5 }));
    // Knee: 1 + (1.5 - 1) * 0.5 = 1.25, then normalized by the white point.
    for (const value of display.data) approx(value, 1.25 / 1.5);
  });

  it("preserves grey through saturation changes", () => {
    const scene = build(8, 8, "scene-linear-rgb", () => [0.3, 0.3, 0.3]);
    for (const saturation of [0, 0.5, 1, 2]) {
      const { display } = toneMap(scene, baseRecipe({ saturation }));
      const first = display.data[0]!;
      for (let offset = 0; offset < display.data.length; offset += 3) {
        approx(display.data[offset]!, first);
        approx(display.data[offset + 1]!, first);
        approx(display.data[offset + 2]!, first);
      }
    }
  });

  it("desaturates to luma at saturation zero", () => {
    const scene = build(1, 1, "scene-linear-rgb");
    scene.data.set([0.9, 0.2, 0.1]);
    const { display } = toneMap(scene, baseRecipe({ saturation: 0 }));
    const luma = 0.9 * 0.2126 + 0.2 * 0.7152 + 0.1 * 0.0722;
    for (const value of display.data) approx(value, luma / 0.9 * 0.9 / (luma));
  });

  it("ignores border content when estimating the white point", () => {
    const width = 100;
    const scene = build(width, 20, "scene-linear-rgb", (x) => (
      x < 3 || x >= 97 ? [1, 1, 1] : [0.2, 0.2, 0.2]
    ));
    approx(estimateWhitePoint(scene), 0.2);
  });

  it("takes the highlight percentile of the central region", () => {
    const scene = build(64, 64, "scene-linear-rgb", (x, y) => [
      (x + y) / 128, (x + y) / 128, (x + y) / 128,
    ]);
    // Central 90% region spans x+y from 6 to 120; its 99.5th percentile sits
    // at x+y = 115 on this discrete ramp.
    approx(estimateWhitePoint(scene), 115 / 128, 0.001);
  });

  it("rejects out-of-range tone controls", () => {
    const scene = build(4, 4, "scene-linear-rgb");
    assert.throws(() => toneMap(scene, baseRecipe({ contrast: 2 })));
    assert.throws(() => toneMap(scene, baseRecipe({ highlightCompression: 1.5 })));
    assert.throws(() => toneMap(scene, baseRecipe({ saturation: -0.1 })));
  });
});

describe("sRGB encoding", () => {
  it("implements the IEC 61966-2-1 OETF", () => {
    approx(srgbOetf(0), 0);
    approx(srgbOetf(1), 1);
    approx(srgbOetf(0.0031308), 0.04045, 1e-5);
    approx(srgbOetf(0.5), 0.735357, 1e-5);
  });

  it("round-trips through the inverse transfer function", () => {
    for (const value of [0, 0.001, 0.02, 0.1, 0.5, 0.9, 1]) {
      approx(srgbToLinear(srgbOetf(value)), value, 1e-6);
    }
  });

  it("quantizes display-linear to 8 and 16 bits", () => {
    const display = new Raster(1, 1, "display-linear");
    display.data.set([1, 0, 0.5]);
    const bytes = encode8(display);
    assert.deepEqual([...bytes], [255, 0, 188]);
    const words = encode16(display);
    assert.deepEqual([...words], [65535, 0, 48192]);
  });

  it("rejects non-display domains at encode time", () => {
    const scene = new Raster(1, 1, "scene-linear-rgb");
    assert.throws(() => encode8(scene));
  });

  it("keeps exact legacy quantization at every 8/16-bit code boundary", () => {
    const storage = new ArrayBuffer(4);
    const float = new Float32Array(storage);
    const bits = new Uint32Array(storage);
    const adjacent = (value: number, delta: number): number => {
      float[0] = value;
      bits[0] = bits[0]! + delta;
      return float[0]!;
    };
    for (const [scale, quantize] of [[255, getSrgb8Quantizer()], [65_535, getSrgb16Quantizer()]] as const) {
      for (let code = 0; code < scale; code += 1) {
        const boundary = Math.fround(srgbToLinear((code + 0.5) / scale));
        for (let delta = -2; delta <= 2; delta += 1) {
          const value = adjacent(boundary, delta);
          assert.equal(quantize(value), Math.round(srgbOetf(value) * scale));
        }
      }
      assert.equal(quantize(Number.NaN), 0);
      assert.equal(quantize(Number.NEGATIVE_INFINITY), 0);
      assert.equal(quantize(Number.POSITIVE_INFINITY), scale);
    }
  });
});

describe("End-to-end negative inversion", () => {
  /**
   * Builds a synthetic masked negative from a known positive scene:
   * T(x,y) = base / (1 + 9 * scene(x,y)). The pipeline must recover the
   * scene (times white-point normalization) from this input.
   */
  function syntheticNegative(base: Rgb, scene: (x: number, y: number) => number): Raster {
    return build(100, 40, "transmission-linear", (x, y) => {
      const s = x < 8 ? 0 : scene(x, y); // left 8% is unexposed border
      const transmission = 1 / (1 + 9 * s);
      return [base[0] * transmission, base[1] * transmission, base[2] * transmission];
    });
  }

  it("recovers a grey ramp from a masked negative", () => {
    const base: Rgb = [0.9, 0.5, 0.3];
    const frame = syntheticNegative(base, (x) => (x - 8) / 92);
    const result = processNegative(frame, baseRecipe({
      baseMode: "roi",
      baseRoi: { x: 0, y: 0, width: 0.08, height: 1 },
    }));

    // Base sampling finds the true mask; the perfectly neutral ramp needs no
    // channel fit, so the conservative transform applies.
    assert.equal(result.base.method, "roi");
    approx(result.base.rgb[0], 0.9, 1e-6);
    approx(result.base.rgb[1], 0.5, 1e-6);
    approx(result.base.rgb[2], 0.3, 1e-6);
    assert.equal(result.anchors.channelFit, undefined);

    // The display output must be the scene ramp times one constant scale
    // factor (the auto white point), with no per-pixel distortion.
    const sampleXs = [10, 30, 50, 70, 90];
    const scales = sampleXs.map((x) => {
      const offset = Raster.offsetOf(x, 20, 100);
      return result.display.data[offset]! / ((x - 8) / 92);
    });
    const meanScale = scales.reduce((sum, value) => sum + value, 0) / scales.length;
    assert.ok(meanScale > 0.9 && meanScale < 1.15, `mean scale ${meanScale}`);
    for (const scale of scales) {
      approx(scale, meanScale, meanScale * 0.02);
    }
    // The recovered ramp is neutral: the orange mask leaves no colour cast.
    for (const x of sampleXs) {
      const offset = Raster.offsetOf(x, 20, 100);
      approx(result.display.data[offset]!, result.display.data[offset + 1]!, 1e-6, `red vs green at x=${x}`);
      approx(result.display.data[offset]!, result.display.data[offset + 2]!, 1e-6, `red vs blue at x=${x}`);
    }
  });

  it("recovers a grey ramp with the default automatic base estimate", () => {
    const base: Rgb = [0.9, 0.5, 0.3];
    const frame = syntheticNegative(base, (x) => (x - 8) / 92);
    const result = processNegative(frame, baseRecipe());

    // The upper envelope lands on the 8% border, recovering the true mask.
    assert.equal(result.base.method, "automatic");
    approx(result.base.rgb[0], 0.9, 1e-6);
    approx(result.base.rgb[1], 0.5, 1e-6);
    approx(result.base.rgb[2], 0.3, 1e-6);
    assert.equal(result.anchors.channelFit, undefined);

    const sampleXs = [10, 30, 50, 70, 90];
    const scales = sampleXs.map((x) => {
      const offset = Raster.offsetOf(x, 20, 100);
      return result.display.data[offset]! / ((x - 8) / 92);
    });
    const meanScale = scales.reduce((sum, value) => sum + value, 0) / scales.length;
    assert.ok(meanScale > 0.9 && meanScale < 1.15, `mean scale ${meanScale}`);
    for (const scale of scales) approx(scale, meanScale, meanScale * 0.02);
  });

  it("falls back to the automatic estimate when a drawn ROI is missing", () => {
    const base: Rgb = [0.9, 0.5, 0.3];
    const frame = syntheticNegative(base, (x) => (x - 8) / 92);
    const result = processNegative(frame, baseRecipe({ baseMode: "roi" }));
    assert.equal(result.base.method, "automatic");
  });

  it("recovers distinct colours through per-channel inversion", () => {
    const base: Rgb = [0.8, 0.5, 0.3];
    // Pure-red positive: green and blue are zero in the scene.
    const frame = build(64, 32, "transmission-linear", (x) => {
      const border = x < 6;
      const s = border ? 0 : 0.8;
      return [
        base[0] / (1 + 9 * s),
        base[1],
        base[2],
      ];
    });
    const result = processNegative(frame, baseRecipe());
    const offset = Raster.offsetOf(32, 16, 64);
    const red = result.display.data[offset]!;
    const green = result.display.data[offset + 1]!;
    const blue = result.display.data[offset + 2]!;
    assert.ok(red > 0.5, `red ${red} should dominate`);
    assert.ok(green < 0.2, `green ${green} should stay low`);
    assert.ok(blue < 0.2, `blue ${blue} should stay low`);
  });

  it("rotates the frame and samples the relocated border", () => {
    const base: Rgb = [0.8, 0.5, 0.3];
    // Border along the top of the original frame; rotation moves it to the
    // right side, so the base ROI must move with it.
    const frame = build(40, 100, "transmission-linear", (x, y) => {
      const s = y < 8 ? 0 : (y - 8) / 92;
      const transmission = 1 / (1 + 9 * s);
      return [base[0] * transmission, base[1] * transmission, base[2] * transmission];
    });
    const result = processNegative(frame, baseRecipe({
      rotate: 90,
      baseMode: "roi",
      baseRoi: { x: 0.92, y: 0, width: 0.08, height: 1 },
      autoNeutralize: false,
    }));
    assert.equal(result.display.width, 100);
    assert.equal(result.display.height, 40);
    approx(result.base.rgb[0], 0.8, 1e-6);
    approx(result.base.rgb[1], 0.5, 1e-6);
    approx(result.base.rgb[2], 0.3, 1e-6);
    // Without channel-range normalization the recovered positive is exactly
    // (Tbase/T - 1) = 9s; display = 9s / whitePoint, so display/s is constant.
    const sampleXs = [10, 30, 50, 70, 90];
    const scales = sampleXs.map((x) => {
      const s = (91 - x) / 92; // x maps to sourceY = 99 - x
      const offset = Raster.offsetOf(x, 20, 100);
      return result.display.data[offset]! / s;
    });
    const meanScale = scales.reduce((sum, value) => sum + value, 0) / scales.length;
    for (const scale of scales) approx(scale, meanScale, 1e-6);
  });

  it("applies the crop before film-base sampling", () => {
    const base: Rgb = [0.8, 0.5, 0.3];
    // Border on the left 20%; cropping to the left half keeps border inside.
    const frame = build(100, 40, "transmission-linear", (x) => {
      const s = x < 20 ? 0 : (x - 20) / 80;
      const transmission = 1 / (1 + 9 * s);
      return [base[0] * transmission, base[1] * transmission, base[2] * transmission];
    });
    const result = processNegative(frame, baseRecipe({
      baseMode: "roi",
      baseRoi: { x: 0, y: 0, width: 0.08, height: 1 },
      crop: { x: 0, y: 0, width: 0.5, height: 1 },
      autoNeutralize: false,
    }));
    assert.equal(result.display.width, 50);
    assert.equal(result.display.height, 40);
    assert.equal(result.base.method, "roi");
    approx(result.base.rgb[0], 0.8, 1e-6);
    // display = 9s / whitePoint with s = (x - 20) / 80.
    const sampleXs = [25, 30, 35, 40, 45];
    const scales = sampleXs.map((x) => {
      const offset = Raster.offsetOf(x, 20, 50);
      return result.display.data[offset]! / ((x - 20) / 80);
    });
    const meanScale = scales.reduce((sum, value) => sum + value, 0) / scales.length;
    for (const scale of scales) approx(scale, meanScale, 1e-6);
  });

  it("survives corrupt pixels without failing the frame", () => {
    const base: Rgb = [0.9, 0.5, 0.3];
    const frame = syntheticNegative(base, (x) => (x - 8) / 92);
    const corrupt = Raster.offsetOf(50, 20, 100);
    frame.data[corrupt] = Number.NaN;
    frame.data[corrupt + 1] = Number.POSITIVE_INFINITY;
    const result = processNegative(frame, baseRecipe());
    // The corrupted channels map to the film base and stay black; the
    // untouched blue channel keeps its (pre-saturation boosted) ramp value.
    const offset = Raster.offsetOf(50, 20, 100);
    approx(result.display.data[offset]!, 0, 1e-6);
    approx(result.display.data[offset + 1]!, 0, 1e-6);
    approx(result.display.data[offset + 2]!, 0.55, 0.06);
    // Neighbouring pixels are unaffected.
    const neighbour = Raster.offsetOf(51, 20, 100);
    approx(result.display.data[neighbour]!, 0.5, 0.06);
    approx(result.display.data[neighbour + 1]!, 0.5, 0.06);
    approx(result.display.data[neighbour + 2]!, 0.5, 0.06);
  });

  it("rejects non-transmission input domains", () => {
    const density = new Raster(4, 4, "relative-density");
    assert.throws(() => processNegative(density, baseRecipe()));
  });

  it("keeps roi and automatic base results consistent on a realistic masked negative", () => {
    // Realistic scan: noisy border with the orange mask, scene content with
    // a per-channel film response and some saturated colours. A drawn base
    // ROI must not diverge from the automatic envelope estimate.
    const base: Rgb = [0.85, 0.62, 0.4];
    const slope: Rgb = [1.0, 0.95, 1.08];
    const offset: Rgb = [0.02, 0, 0.05];
    let seed = 42;
    const noise = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed / 2147483648 - 0.5) * 0.02;
    };
    const frame = build(100, 60, "transmission-linear", (x, y) => {
      if (x < 10) {
        const gradient = x / 10 * 0.03;
        return [
          Math.max(0.01, base[0] * (1 - gradient + noise())),
          Math.max(0.01, base[1] * (1 - gradient + noise())),
          Math.max(0.01, base[2] * (1 - gradient + noise())),
        ];
      }
      const s = (x - 10) / 90;
      const coloured = (x * 7 + y * 13) % 5 === 0;
      return ([0, 1, 2] as const).map((channel) => {
        const scene = coloured ? (channel === (x + y) % 3 ? 1.0 : 0.15) : s;
        const density = slope[channel] * -Math.log10(Math.max(0.05, scene)) + offset[channel];
        return Math.min(0.999, base[channel] * Math.pow(10, -density) * (1 + noise()));
      }) as Rgb;
    });

    const auto = processNegative(frame, baseRecipe());
    const roi = processNegative(frame, baseRecipe({
      baseMode: "roi",
      baseRoi: { x: 0, y: 0, width: 0.08, height: 1 },
    }));

    // Both paths must fire the channel fit and agree on its parameters.
    assert.ok(auto.anchors.channelFit, "automatic base should produce a channel fit");
    assert.ok(roi.anchors.channelFit, "roi base should produce the same channel fit");
    for (let channel = 0; channel < 3; channel += 1) {
      approx(roi.anchors.channelFit!.slope[channel]!, auto.anchors.channelFit!.slope[channel]!, 0.03);
      approx(roi.anchors.channelFit!.offset[channel]!, auto.anchors.channelFit!.offset[channel]!, 0.03);
    }
    // And the delivered colours must stay close on scene pixels.
    for (const sampleX of [20, 40, 60, 80]) {
      const sample = Raster.offsetOf(sampleX, 30, 100);
      for (let channel = 0; channel < 3; channel += 1) {
        approx(roi.display.data[sample + channel]!, auto.display.data[sample + channel]!, 0.03);
      }
    }
  });
});

describe("Default recipe", () => {
  it("starts from the automatic base estimate", () => {
    assert.equal(DEFAULT_RECIPE.rotate, 0);
    assert.equal(DEFAULT_RECIPE.crop, undefined);
    assert.equal(DEFAULT_RECIPE.baseMode, "auto");
    assert.equal(DEFAULT_RECIPE.baseRoi, undefined);
    assert.equal(DEFAULT_RECIPE.dmaxMode, "auto");
    assert.equal(DEFAULT_RECIPE.autoNeutralize, true);
    assert.equal(DEFAULT_RECIPE.temperatureKelvin, 5500);
    assert.equal(DEFAULT_RECIPE.autoWhiteBalance, true);
    assert.equal(DEFAULT_RECIPE.preSaturation, 1.08);
    assert.equal(DEFAULT_RECIPE.exposure, 0);
    assert.equal(DEFAULT_RECIPE.contrast, 1);
    assert.equal(DEFAULT_RECIPE.highlightCompression, 0);
    assert.equal(DEFAULT_RECIPE.saturation, 1);
  });
});

describe("Recipe application order", () => {
  it("keeps baseRoi relative to the delivered (cropped) frame", () => {
    const base: Rgb = [0.8, 0.5, 0.3];
    // The frame has a border only on its left 20%, then a content ramp.
    const frame = build(100, 40, "transmission-linear", (x, y) => {
      const s = x < 20 ? 0 : (x - 20) / 80;
      const transmission = 1 / (1 + 9 * s);
      return [base[0] * transmission, base[1] * transmission, base[2] * transmission];
    });
    // Crop to the content only; the default left-8% base ROI would then fail,
    // so auto mode must still produce a usable image.
    const result = processNegative(frame, baseRecipe({
      baseMode: "auto",
      crop: { x: 0.2, y: 0, width: 0.8, height: 1 },
    }));
    assert.equal(result.display.width, 80);
    const offset = Raster.offsetOf(40, 20, 80);
    const expected = 40 / 80;
    approx(result.display.data[offset]!, expected, 0.05);
    assert.equal(result.base.method, "automatic");
  });
});

describe("CPU pipeline acceleration", () => {
  function performanceNegative(): Raster {
    const base: Rgb = [0.84, 0.61, 0.39];
    return build(128, 88, "transmission-linear", (x, y) => {
      if (x < 10 || y < 5 || x >= 123 || y >= 83) return base;
      const level = 0.05 + 0.9 * ((x - 10) / 113 * 0.7 + (y - 5) / 78 * 0.3);
      const accent = (x * 17 + y * 31) % 11 === 0;
      const scene: Rgb = accent ? [level, level * 0.55, level * 0.25] : [level, level, level];
      return [
        base[0] * Math.pow(10, -(0.03 + -Math.log10(scene[0]) * 0.96)),
        base[1] * Math.pow(10, -(0.00 + -Math.log10(scene[1]) * 1.02)),
        base[2] * Math.pow(10, -(0.05 + -Math.log10(scene[2]) * 1.08)),
      ];
    });
  }

  it("invalidates only the cache layers affected by each recipe field", () => {
    const session = new NegativeSession(performanceNegative());
    const initial = baseRecipe({ autoNeutralize: false });
    session.process(initial);
    assert.deepEqual(session.stats, { geometry: 1, analysis: 1, inversion: 1, balance: 1, tone: 1 });

    session.process({ ...initial, exposure: 0.4 });
    assert.deepEqual(session.stats, { geometry: 1, analysis: 1, inversion: 1, balance: 1, tone: 2 });

    // Manual temperature is intentionally absent from the automatic-WB key.
    session.process({ ...initial, temperatureKelvin: 7200 });
    assert.deepEqual(session.stats, { geometry: 1, analysis: 1, inversion: 1, balance: 1, tone: 3 });

    session.process({ ...initial, autoWhiteBalance: false, temperatureKelvin: 7200 });
    assert.deepEqual(session.stats, { geometry: 1, analysis: 1, inversion: 1, balance: 2, tone: 4 });

    session.process({ ...initial, preSaturation: 1.2 });
    assert.deepEqual(session.stats, { geometry: 1, analysis: 1, inversion: 2, balance: 3, tone: 5 });

    session.process({ ...initial, dmaxMode: "manual", manualDmax: 2.2 });
    assert.deepEqual(session.stats, { geometry: 1, analysis: 2, inversion: 3, balance: 4, tone: 6 });

    session.process({ ...initial, rotate: 90 });
    assert.deepEqual(session.stats, { geometry: 2, analysis: 3, inversion: 4, balance: 5, tone: 7 });
  });

  it("matches the previous sorted percentile definition exactly", () => {
    let seed = 0x5eed1234;
    const random = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let length = 1; length <= 257; length += 7) {
      const values = Array.from({ length }, (_, index) => (
        index % 9 === 0 ? 0.5 : Math.round((random() * 20 - 10) * 8) / 8
      ));
      for (const fraction of [0, 0.01, 0.25, 0.5, 0.73, 0.995, 1]) {
        const sorted = [...values].sort((left, right) => left - right);
        const position = (length - 1) * fraction;
        const lower = Math.floor(position);
        const upper = Math.ceil(position);
        const weight = position - lower;
        const expected = sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
        assert.equal(percentile(values, fraction), expected);
      }
    }
  });

  it("produces byte-identical 8/16-bit output with 1, 2, and 4 pixel partitions", () => {
    const source = performanceNegative();
    for (const recipe of [
      baseRecipe({ autoNeutralize: true, autoWhiteBalance: true }),
      baseRecipe({
        rotate: 7.5,
        crop: { x: 0.03, y: 0.03, width: 0.94, height: 0.94 },
        autoNeutralize: false,
        autoWhiteBalance: false,
        temperatureKelvin: 7200,
        preSaturation: 1.25,
        exposure: 0.35,
        contrast: 1.2,
        highlightCompression: 0.45,
        saturation: 1.3,
      }),
    ]) {
      const canonical = processNegative(source, recipe).display;
      const expected8 = encode8(canonical);
      const expected16 = encode16(canonical);
      for (const partitions of [1, 2, 4]) {
        const { bytes8, bytes16 } = runPartitionedPipeline(source, recipe, partitions);
        assert.deepEqual(bytes8, expected8, `${partitions}-partition 8-bit output diverged`);
        assert.deepEqual(bytes16, expected16, `${partitions}-partition 16-bit output diverged`);
      }

      const preview = new NegativeSession(source).processPreview(recipe);
      const expectedRgba = new Uint8ClampedArray(expected8.length / 3 * 4);
      for (let sourceOffset = 0, targetOffset = 0; sourceOffset < expected8.length; sourceOffset += 3, targetOffset += 4) {
        expectedRgba[targetOffset] = expected8[sourceOffset]!;
        expectedRgba[targetOffset + 1] = expected8[sourceOffset + 1]!;
        expectedRgba[targetOffset + 2] = expected8[sourceOffset + 2]!;
        expectedRgba[targetOffset + 3] = 255;
      }
      assert.deepEqual(preview.rgba, expectedRgba, "fused preview RGBA output diverged");
    }
  });

  it("matches canonical rotation and crop exactly across geometry partitions", () => {
    const source = performanceNegative();
    const sourceBuffer = new SharedArrayBuffer(source.data.byteLength);
    new Float32Array(sourceBuffer).set(source.data);
    for (const specification of [
      { rotate: 0, crop: undefined },
      { rotate: 90, crop: { x: 0.05, y: 0.1, width: 0.8, height: 0.75 } },
      { rotate: -17.35, crop: { x: 0.03, y: 0.04, width: 0.91, height: 0.89 } },
      { rotate: 132.5, crop: undefined },
    ] as const) {
      const rotated = rotateRaster(source, specification.rotate);
      const expected = specification.crop === undefined ? rotated : cropRaster(rotated, specification.crop);
      const plan = createGeometryPlan(source.width, source.height, specification.rotate, specification.crop);
      assert.equal(plan.width, expected.width);
      assert.equal(plan.height, expected.height);
      const pixelCount = plan.width * plan.height;
      for (const partitions of [1, 2, 4]) {
        const output = new SharedArrayBuffer(expected.data.byteLength);
        for (let part = 0; part < partitions; part += 1) {
          executeKernelTask({
            taskId: part,
            action: "geometry",
            startPixel: Math.floor(pixelCount * part / partitions),
            endPixel: Math.floor(pixelCount * (part + 1) / partitions),
            pixels: output,
            source: sourceBuffer,
            geometryPlan: plan,
          });
        }
        assert.deepEqual(new Float32Array(output), expected.data);
      }
    }
  });

  it("keeps identity tone fast paths byte-identical to the original equations", () => {
    let seed = 0x13579bdf;
    const scene = build(257, 193, "scene-linear-rgb", () => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      const red = seed / 0x1_0000_0000 * 6;
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      const green = seed / 0x1_0000_0000 * 6;
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      const blue = seed / 0x1_0000_0000 * 6;
      return [red, green, blue];
    });
    for (const recipe of [
      baseRecipe({ exposure: 0.37, contrast: 1, highlightCompression: 0, saturation: 1 }),
      baseRecipe({ exposure: -0.63, contrast: 1, highlightCompression: 0.4, saturation: 1 }),
      baseRecipe({ exposure: 0.12, contrast: 1, highlightCompression: 0.2, saturation: 0.8 }),
      baseRecipe({ exposure: 0.12, contrast: 1.2, highlightCompression: 0.2, saturation: 1 }),
    ]) {
      assert.deepEqual(toneMapEncodeRgba8(scene, recipe, 2.3), legacyToneRgba(scene, recipe, 2.3));
    }
  });
});

function legacyToneRgba(scene: Raster, recipe: ClassicRecipe, whitePoint: number): Uint8ClampedArray {
  const target = new Uint8ClampedArray(scene.width * scene.height * 4);
  const exposureScale = Math.pow(2, recipe.exposure);
  const kneeSlope = 1 - recipe.highlightCompression;
  for (let offset = 0; offset < scene.data.length; offset += 3) {
    const channels = [scene.data[offset]!, scene.data[offset + 1]!, scene.data[offset + 2]!].map((input) => {
      const exposed = input * exposureScale;
      const contrasted = exposed <= 0
        ? 0
        : 0.18 * Math.pow(2, Math.log2(exposed / 0.18) * recipe.contrast);
      return recipe.highlightCompression > 0 && contrasted > 1
        ? 1 + (contrasted - 1) * kneeSlope
        : contrasted;
    });
    const luma = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    const rgbaOffset = offset / 3 * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      const display = Math.fround(
        Math.max(0, luma + (channels[channel]! - luma) * recipe.saturation) / whitePoint,
      );
      target[rgbaOffset + channel] = Math.round(srgbOetf(display) * 255);
    }
    target[rgbaOffset + 3] = 255;
  }
  return target;
}

function runPartitionedPipeline(
  source: Raster,
  recipe: ClassicRecipe,
  partitions: number,
): { bytes8: Uint8Array; bytes16: Uint16Array } {
  const rotated = rotateRaster(source, recipe.rotate);
  const framed = recipe.crop === undefined ? rotated : cropRaster(rotated, recipe.crop);
  const base = recipe.baseMode === "roi" && recipe.baseRoi !== undefined
    ? sampleFilmBase(framed, recipe.baseRoi)
    : estimateFilmBase(framed);
  const pixels = new SharedArrayBuffer(framed.data.byteLength);
  new Float32Array(pixels).set(framed.data);
  const pixelCount = framed.width * framed.height;
  const execute = (action: KernelAction, parameters: Partial<KernelTask> = {}): void => {
    for (let part = 0; part < partitions; part += 1) {
      executeKernelTask({
        taskId: part,
        action,
        startPixel: Math.floor(pixelCount * part / partitions),
        endPixel: Math.floor(pixelCount * (part + 1) / partitions),
        pixels,
        ...parameters,
      });
    }
  };

  execute("density", { base: base.rgb });
  const density = new Raster(framed.width, framed.height, "relative-density", new Float32Array(pixels));
  const anchors = measureDensityAnchors(base.rgb, density, 0.995, {
    dmaxOverride: recipe.dmaxMode === "manual" ? recipe.manualDmax : undefined,
    neutralRoi: recipe.autoNeutralize ? recipe.neutralRoi : undefined,
    autoNeutralize: recipe.autoNeutralize,
  });
  execute("invert", { anchors, preSaturation: recipe.preSaturation });
  const inverted = new Raster(framed.width, framed.height, "scene-linear-rgb", new Float32Array(pixels));
  const gains = recipe.autoWhiteBalance
    ? estimateWhiteBalance(inverted)
    : temperatureToGains(recipe.temperatureKelvin);
  execute("gains", { gains });
  const scene = new Raster(framed.width, framed.height, "scene-linear-rgb", new Float32Array(pixels));
  const whitePoint = estimateWhitePoint(scene);
  const output8 = new SharedArrayBuffer(pixelCount * 3);
  const output16 = new SharedArrayBuffer(pixelCount * 3 * Uint16Array.BYTES_PER_ELEMENT);
  execute("toneEncode8", { output: output8, recipe, whitePoint });
  execute("toneEncode16", { output: output16, recipe, whitePoint });
  return { bytes8: new Uint8Array(output8), bytes16: new Uint16Array(output16) };
}
