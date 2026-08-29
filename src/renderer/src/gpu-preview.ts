import type { ClassicRecipe, Recipe } from "../../core/index.ts";
import type { PreviewResult } from "./renderer-types.ts";

export type PreviewProcessingBackend = "canvas2d";

export interface PreviewCanvasRenderer {
  readonly backend: PreviewProcessingBackend;
  render(result: PreviewResult, recipe: Recipe): PreviewProcessingBackend;
  dispose(): void;
}

/** Stable cache key retained by the CPU compatibility worker. */
export function classicSceneKey(recipe: ClassicRecipe): string {
  const { exposure: _exposure, contrast: _contrast, highlightCompression: _highlight, saturation: _saturation, ...stable } = recipe;
  return JSON.stringify(stable);
}

/** WebGPU owns the accelerated display path. CPU output intentionally uses
 * only Canvas2D so FilmLab never creates a second GPU API/context. */
export function createPreviewCanvasRenderer(canvas: HTMLCanvasElement): PreviewCanvasRenderer {
  return new Canvas2dRenderer(canvas);
}

class Canvas2dRenderer implements PreviewCanvasRenderer {
  readonly backend = "canvas2d" as const;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas2D preview context is unavailable.");
    this.canvas = canvas;
    this.context = context;
  }

  render(result: PreviewResult): PreviewProcessingBackend {
    if (this.canvas.width !== result.width) this.canvas.width = result.width;
    if (this.canvas.height !== result.height) this.canvas.height = result.height;
    this.context.putImageData(new ImageData(result.rgba, result.width, result.height), 0, 0);
    this.canvas.dataset.processingBackend = this.backend;
    return this.backend;
  }

  dispose(): void {}
}
