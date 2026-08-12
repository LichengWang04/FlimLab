import type { GeometrySettings, PerspectiveQuad } from "../../core/types.ts";

export interface GeometryLayout {
  readonly geometryWidth: number;
  readonly geometryHeight: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly cropLeft: number;
  readonly cropTop: number;
}

export interface PreviewDisplaySize {
  readonly width: number;
  readonly height: number;
}

export interface ContainedPreviewSize extends PreviewDisplaySize {
  readonly scale: number;
}

export interface PreviewSizingSource {
  readonly width: number;
  readonly height: number;
  readonly gpuPipeline?: {
    readonly sourceWidth: number;
    readonly sourceHeight: number;
  };
}

export function computeGeometryLayout(
  sourceWidth: number,
  sourceHeight: number,
  geometry: GeometrySettings,
): GeometryLayout {
  const swapsAxes = geometry.rotation === 90 || geometry.rotation === 270;
  const rotatedWidth = swapsAxes ? sourceHeight : sourceWidth;
  const rotatedHeight = swapsAxes ? sourceWidth : sourceHeight;
  const quad = geometry.perspective;
  const perspectiveActive = quad !== undefined && !isIdentityPerspective(quad);
  const geometryWidth = perspectiveActive
    ? Math.max(1, Math.round((
      distance(quad.topLeft, quad.topRight) * rotatedWidth
      + distance(quad.bottomLeft, quad.bottomRight) * rotatedWidth
    ) * 0.5))
    : rotatedWidth;
  const geometryHeight = perspectiveActive
    ? Math.max(1, Math.round((
      distance(quad.topLeft, quad.bottomLeft) * rotatedHeight
      + distance(quad.topRight, quad.bottomRight) * rotatedHeight
    ) * 0.5))
    : rotatedHeight;
  const crop = geometry.crop;
  if (crop === undefined) {
    return {
      geometryWidth,
      geometryHeight,
      outputWidth: geometryWidth,
      outputHeight: geometryHeight,
      cropLeft: 0,
      cropTop: 0,
    };
  }
  const cropLeft = Math.floor(crop.x * geometryWidth);
  const cropTop = Math.floor(crop.y * geometryHeight);
  const cropRight = Math.ceil((crop.x + crop.width) * geometryWidth);
  const cropBottom = Math.ceil((crop.y + crop.height) * geometryHeight);
  return {
    geometryWidth,
    geometryHeight,
    outputWidth: Math.max(1, cropRight - cropLeft),
    outputHeight: Math.max(1, cropBottom - cropTop),
    cropLeft,
    cropTop,
  };
}

export function resolvePreviewDisplaySize(
  preview: PreviewSizingSource,
  geometry: GeometrySettings,
): PreviewDisplaySize {
  if (preview.gpuPipeline === undefined) {
    return { width: preview.width, height: preview.height };
  }
  const layout = computeGeometryLayout(
    preview.gpuPipeline.sourceWidth,
    preview.gpuPipeline.sourceHeight,
    geometry,
  );
  return { width: layout.outputWidth, height: layout.outputHeight };
}

export function fitPreviewIntoBounds(
  contentWidth: number,
  contentHeight: number,
  availableWidth: number,
  availableHeight: number,
  allowUpscale = false,
): ContainedPreviewSize {
  const dimensions = [contentWidth, contentHeight, availableWidth, availableHeight];
  if (dimensions.some((value) => !Number.isFinite(value) || value <= 0)) {
    return {
      width: Math.max(1, Number.isFinite(contentWidth) ? contentWidth : 1),
      height: Math.max(1, Number.isFinite(contentHeight) ? contentHeight : 1),
      scale: 1,
    };
  }
  const scale = Math.min(
    allowUpscale ? Number.POSITIVE_INFINITY : 1,
    availableWidth / contentWidth,
    availableHeight / contentHeight,
  );
  return {
    width: contentWidth * scale,
    height: contentHeight * scale,
    scale,
  };
}

export function isIdentityPerspective(quad: PerspectiveQuad): boolean {
  const epsilon = 1e-8;
  return Math.abs(quad.topLeft.x) < epsilon
    && Math.abs(quad.topLeft.y) < epsilon
    && Math.abs(quad.topRight.x - 1) < epsilon
    && Math.abs(quad.topRight.y) < epsilon
    && Math.abs(quad.bottomRight.x - 1) < epsilon
    && Math.abs(quad.bottomRight.y - 1) < epsilon
    && Math.abs(quad.bottomLeft.x) < epsilon
    && Math.abs(quad.bottomLeft.y - 1) < epsilon;
}

function distance(
  left: { readonly x: number; readonly y: number },
  right: { readonly x: number; readonly y: number },
): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}
