import { Raster } from "../src/core/raster.ts";
import { applyPresetTransform } from "../src/core/transforms.ts";

const OLD_CURVES = [
  [{ x: 0, y: 0 }, { x: 0.24, y: 0.15 }, { x: 0.62, y: 0.93 }, { x: 1.08, y: 2.1 }],
  [{ x: 0, y: 0 }, { x: 0.24, y: 0.17 }, { x: 0.62, y: 0.9 }, { x: 1.08, y: 2.02 }],
  [{ x: 0, y: 0 }, { x: 0.24, y: 0.14 }, { x: 0.62, y: 0.95 }, { x: 1.08, y: 2.16 }],
];
const NEW_CURVES = [
  [{ x: 0, y: 0 }, { x: 0.24, y: 0.155 }, { x: 0.62, y: 0.93 }, { x: 1.08, y: 2.09 }],
  [{ x: 0, y: 0 }, { x: 0.24, y: 0.155 }, { x: 0.62, y: 0.93 }, { x: 1.08, y: 2.09 }],
  [{ x: 0, y: 0 }, { x: 0.24, y: 0.155 }, { x: 0.62, y: 0.93 }, { x: 1.08, y: 2.09 }],
];
const MATRIX = [
  [1.06, -0.04, -0.02],
  [-0.025, 1.05, -0.025],
  [-0.035, -0.04, 1.075],
];

function cast(label: string, curves: readonly (readonly { x: number; y: number }[])[], wb: readonly [number, number, number]): void {
  const rows: string[] = [];
  for (const d of [0.1, 0.24, 0.3, 0.62, 0.9, 1.08]) {
    const raster = new Raster(1, 1, "relative-density");
    raster.data[0] = d;
    raster.data[1] = d;
    raster.data[2] = d;
    const out = applyPresetTransform(raster, { id: "t", version: "1", curves, matrix: MATRIX }, wb);
    const ratio = out.data[2] / out.data[1];
    const maxDev = Math.max(...[0, 1, 2].map((c) => Math.abs(out.data[c] / out.data[1] - 1)));
    rows.push(`d=${String(d).padEnd(5)} R=${out.data[0].toFixed(4)} G=${out.data[1].toFixed(4)} B=${out.data[2].toFixed(4)}  max通道偏差=${(maxDev * 100).toFixed(1)}%`);
  }
  console.log(`\n=== ${label} ===`);
  for (const row of rows) console.log("  " + row);
}

cast("修复前（旧曲线 + 无白平衡）", OLD_CURVES, [1, 1, 1]);
cast("修复后（中性曲线 + 默认白平衡 [1.04,1,0.96]）", NEW_CURVES, [1.04, 1, 0.96]);
