/**
 * Luma + RGB waveform analysis for the preview canvas. The waveform samples
 * the final display pixels (8-bit sRGB RGBA), so it always reflects what the
 * user sees, including tone edits, channel gains and view switching.
 */

export interface WaveformFrame {
  readonly columns: number;
  readonly samplesPerColumn: number;
  /** Rec.709 luma, 0-255, row-major per column. */
  readonly luma: Float32Array;
  readonly red: Float32Array;
  readonly green: Float32Array;
  readonly blue: Float32Array;
}

export const waveformColumns = 256;
export const waveformSamplesPerColumn = 192;

const LUMA = [0.2126, 0.7152, 0.0722] as const;

/**
 * Samples a display RGBA buffer into a bounded waveform grid. Sampling is
 * uniform in both axes and capped so a full-resolution frame never scans
 * more than `columns * samplesPerColumn` pixels.
 */
export function computeWaveform(
  rgba: Uint8Array,
  width: number,
  height: number,
  columns = waveformColumns,
  samplesPerColumn = waveformSamplesPerColumn,
): WaveformFrame {
  if (
    !Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0
    || rgba.byteLength !== width * height * 4
  ) {
    throw new Error("Waveform input dimensions do not match the RGBA buffer.");
  }
  const columnStride = Math.max(1, Math.floor(width / columns));
  const rowStride = Math.max(1, Math.floor(height / samplesPerColumn));
  const usedColumns = Math.ceil(width / columnStride);
  const usedRows = Math.ceil(height / rowStride);
  const luma = new Float32Array(usedColumns * usedRows);
  const red = new Float32Array(usedColumns * usedRows);
  const green = new Float32Array(usedColumns * usedRows);
  const blue = new Float32Array(usedColumns * usedRows);

  let sample = 0;
  for (let y = 0; y < height; y += rowStride) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x += columnStride) {
      const offset = rowOffset + x * 4;
      const r = rgba[offset];
      const g = rgba[offset + 1];
      const b = rgba[offset + 2];
      red[sample] = r;
      green[sample] = g;
      blue[sample] = b;
      luma[sample] = r * LUMA[0] + g * LUMA[1] + b * LUMA[2];
      sample += 1;
    }
  }
  return {
    columns: usedColumns,
    samplesPerColumn: usedRows,
    luma,
    red,
    green,
    blue,
  };
}

/**
 * Draws the waveform onto a 2D canvas: Rec.709 luma as white dots plus the
 * three RGB channels overlaid, with 0/25/50/75/100% graticule lines. A null
 * frame clears the canvas and draws the graticule only.
 */
export function drawWaveform(canvas: HTMLCanvasElement, frame: WaveformFrame | null): void {
  const context = canvas.getContext("2d");
  if (context === null) return;
  const cssWidth = canvas.clientWidth || 320;
  const cssHeight = canvas.clientHeight || 168;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(cssWidth * ratio) || canvas.height !== Math.round(cssHeight * ratio)) {
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);

  // Graticule background and percent lines.
  context.fillStyle = "#101216";
  context.fillRect(0, 0, cssWidth, cssHeight);
  context.strokeStyle = "rgba(255, 255, 255, 0.10)";
  context.lineWidth = 1;
  context.font = "9px ui-monospace, monospace";
  context.fillStyle = "rgba(255, 255, 255, 0.45)";
  for (let level = 0; level <= 4; level += 1) {
    const percent = level * 25;
    const y = Math.round((1 - percent / 100) * (cssHeight - 1)) + 0.5;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(cssWidth, y);
    context.stroke();
    context.fillText(String(percent), 3, y - 2);
  }

  if (frame === null || frame.columns === 0 || frame.samplesPerColumn === 0) {
    context.fillStyle = "rgba(255, 255, 255, 0.35)";
    context.fillText("无波形数据", cssWidth / 2 - 28, cssHeight / 2);
    return;
  }

  const columnWidth = cssWidth / frame.columns;
  const valueToY = (value: number): number =>
    Math.round((1 - Math.max(0, Math.min(255, value)) / 255) * (cssHeight - 1));

  // Luma first (white, semi-transparent), then the RGB channels.
  context.globalAlpha = 0.55;
  context.fillStyle = "#f2f2f2";
  plotSamples(context, frame.luma, frame.columns, columnWidth, valueToY);
  context.globalAlpha = 0.45;
  context.fillStyle = "#e04848";
  plotSamples(context, frame.red, frame.columns, columnWidth, valueToY);
  context.fillStyle = "#50c878";
  plotSamples(context, frame.green, frame.columns, columnWidth, valueToY);
  context.fillStyle = "#4a90e2";
  plotSamples(context, frame.blue, frame.columns, columnWidth, valueToY);
  context.globalAlpha = 1;
}

function plotSamples(
  context: CanvasRenderingContext2D,
  values: Float32Array,
  columns: number,
  columnWidth: number,
  valueToY: (value: number) => number,
): void {
  const samplesPerColumn = Math.max(1, Math.floor(values.length / columns));
  const dotWidth = Math.max(1, Math.ceil(columnWidth));
  for (let index = 0; index < values.length; index += 1) {
    const column = Math.floor(index / samplesPerColumn);
    const x = Math.floor(column * columnWidth);
    const y = valueToY(values[index]);
    context.fillRect(x, y, dotWidth, 1);
  }
}
