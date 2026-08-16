import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyGains,
  cropRaster,
  DEFAULT_RECIPE,
  downscaleRaster,
  encode16,
  encode8,
  estimateFilmBase,
  estimateWhiteBalance,
  estimateWhitePoint,
  invertDensity,
  measureDensityAnchors,
  processNegative,
  Raster,
  rotateRaster,
  sampleFilmBase,
  srgbOetf,
  srgbToLinear,
  toRelativeDensity,
  toneMap,
  validateRect,
} from "../src/core/index.ts";
import type { ChannelFit, RasterDomain, Recipe, Rect, Rgb } from "../src/core/index.ts";

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

function baseRecipe(overrides: Partial<Recipe> = {}): Recipe {
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
  it("rotates 90 degrees counterclockwise", () => {
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
});

describe("White balance", () => {
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
    assert.deepEqual(DEFAULT_RECIPE.whiteBalance, [1, 1, 1]);
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
