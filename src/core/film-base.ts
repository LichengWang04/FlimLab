import { validateRect } from "./geometry.ts";
import { Raster, medianInPlace, percentile, clamp01 } from "./raster.ts";
import type { BaseSample, Rect, Rgb } from "./types.ts";

const SAMPLE_CAP = 65_536;

/**
 * Samples the film base from a user-selected ROI (by default the unexposed
 * edge of the frame). Per-channel medians are refined with a MAD-based
 * outlier rejection so dust or image content inside the ROI does not bias
 * the base transmission.
 */
export function sampleFilmBase(linear: Raster, roi: Rect): BaseSample {
  linear.assertDomain(["transmission-linear"]);
  validateRect(roi, "Film-base ROI");

  // IPC validation keeps ROIs within [0,1] up to a rounding slack, so an
  // edge can still land one pixel out of bounds; clamp every edge so the
  // sampling loop never wraps onto unrelated rows or columns.
  const left = Math.min(Math.max(Math.floor(roi.x * linear.width), 0), linear.width - 1);
  const top = Math.min(Math.max(Math.floor(roi.y * linear.height), 0), linear.height - 1);
  const right = Math.min(Math.max(Math.max(left + 1, Math.ceil((roi.x + roi.width) * linear.width)), left + 1), linear.width);
  const bottom = Math.min(Math.max(Math.max(top + 1, Math.ceil((roi.y + roi.height) * linear.height)), top + 1), linear.height);
  const capacity = (right - left) * (bottom - top);
  if (capacity < 3) {
    throw new Error(
      "片基 ROI 至少需要 3 个像素;当前选区过小,请扩大选区或改用自动估算。",
    );
  }

  const red = new Float32Array(capacity);
  const green = new Float32Array(capacity);
  const blue = new Float32Array(capacity);
  let count = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = Raster.offsetOf(x, y, linear.width);
      const r = linear.data[offset]!;
      const g = linear.data[offset + 1]!;
      const b = linear.data[offset + 2]!;
      if (Number.isFinite(r) && r > 0 && Number.isFinite(g) && g > 0 && Number.isFinite(b) && b > 0) {
        red[count] = r;
        green[count] = g;
        blue[count] = b;
        count += 1;
      }
    }
  }
  if (count < 3) {
    throw new Error(
      "片基 ROI 中可用像素不足 3 个;请把选区放到未曝光的片基区域,或改用自动估算。",
    );
  }

  const channels = [red, green, blue] as const;
  const medians = channels.map((values) => medianInPlace(values.slice(0, count), count)) as Rgb;

  // Median absolute deviation around each channel median, with a 6x MAD
  // acceptance window: pixels within it are true base, the rest are content.
  const deviations = new Float32Array(count);
  const thresholds = medians.map((center, channelIndex) => {
    const values = channels[channelIndex]!;
    for (let i = 0; i < count; i += 1) deviations[i] = Math.abs(values[i]! - center);
    const mad = medianInPlace(deviations.slice(0, count), count);
    return Math.max(mad * 6, 1e-6);
  }) as Rgb;

  const filtered = channels.map(() => new Float32Array(count));
  let inlierCount = 0;
  for (let i = 0; i < count; i += 1) {
    if (
      Math.abs(red[i]! - medians[0]) <= thresholds[0]
      && Math.abs(green[i]! - medians[1]) <= thresholds[1]
      && Math.abs(blue[i]! - medians[2]) <= thresholds[2]
    ) {
      filtered[0]![inlierCount] = red[i]!;
      filtered[1]![inlierCount] = green[i]!;
      filtered[2]![inlierCount] = blue[i]!;
      inlierCount += 1;
    }
  }

  const useFiltered = inlierCount >= 3;
  const rgb = useFiltered
    ? filtered.map((values) => medianInPlace(values.slice(0, inlierCount), inlierCount)) as Rgb
    : medians;
  if (rgb.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("片基 ROI 中没有可用的正向透射样本。");
  }
  return {
    rgb,
    confidence: inlierCount / count,
    method: "roi",
    sampleCount: useFiltered ? inlierCount : count,
  };
}

/**
 * Estimates the film base from the upper transmission envelope when no
 * unexposed border is available. A single cropped scene cannot uniquely
 * determine the true Dmin, so confidence is deliberately capped at 0.65 and
 * the UI keeps warning that a measured border is preferable.
 */
export function estimateFilmBase(linear: Raster, upperPercentile = 0.9995): BaseSample {
  linear.assertDomain(["transmission-linear"]);
  if (!Number.isFinite(upperPercentile) || upperPercentile < 0.98 || upperPercentile > 1) {
    throw new Error("Automatic film-base percentile must be between 0.98 and 1.");
  }

  const pixelCount = linear.width * linear.height;
  const stride = Math.max(1, Math.ceil(pixelCount / SAMPLE_CAP));
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  for (let pixel = 0; pixel < pixelCount; pixel += stride) {
    const offset = pixel * 3;
    const values = [linear.data[offset]!, linear.data[offset + 1]!, linear.data[offset + 2]!];
    if (values.every((value) => Number.isFinite(value) && value > 0)) {
      red.push(values[0]!);
      green.push(values[1]!);
      blue.push(values[2]!);
    }
  }
  if (red.length < 32) {
    throw new Error("自动片基估算至少需要 32 个有效像素。");
  }

  const base: Rgb = [
    percentile(red, upperPercentile),
    percentile(green, upperPercentile),
    percentile(blue, upperPercentile),
  ];
  if (base.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("自动片基估算没有找到正向透射上包络。");
  }

  // A plausible base must be jointly close to the upper envelope in all three
  // channels; a single-channel saturated highlight must not raise confidence.
  const scores = red.map((_, index) => Math.min(
    red[index]! / base[0],
    green[index]! / base[1],
    blue[index]! / base[2],
  ));
  const threshold = percentile(scores, 0.99);
  const selected = scores
    .map((score, index) => (score >= threshold ? index : -1))
    .filter((index) => index >= 0);
  const picked = selected.length >= 3 ? selected : scores.map((_, index) => index);
  const channelMads = ([red, green, blue] as const).map((channel, channelIndex) => {
    const center = base[channelIndex]!;
    const spread = percentile(
      picked.map((index) => Math.abs(channel[index]! - center)),
      0.5,
    );
    return spread / Math.max(center, 1e-6);
  });
  const uniformity = clamp01(1 - Math.max(...channelMads) * 24);
  const jointHighCount = scores.filter((score) => score >= 0.985).length;
  const support = clamp01(jointHighCount / Math.max(4, red.length * 0.001));
  const coherence = clamp01(percentile(picked.map((index) => scores[index]!), 0.5));
  const confidence = Math.min(0.65, 0.18 + uniformity * 0.22 + support * 0.15 + coherence * 0.1);

  return {
    rgb: base,
    confidence,
    method: "automatic",
    sampleCount: picked.length,
  };
}
