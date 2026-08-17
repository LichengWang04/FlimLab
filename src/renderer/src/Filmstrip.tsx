import { useEffect, useRef } from "react";
import { encode8, processNegative, Raster } from "../../core/index.ts";
import type { Recipe } from "../../core/index.ts";
import type { FrameEntry } from "./renderer-types.ts";

function FrameThumb({ frame, recipe, synchronousFallback }: {
  frame: FrameEntry;
  recipe: Recipe | undefined;
  synchronousFallback: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    let thumb = frame.renderedThumbnail;
    if (thumb === undefined && synchronousFallback && frame.thumbnail !== null && recipe !== undefined) {
      try {
        const source = new Raster(
          frame.thumbnail.width,
          frame.thumbnail.height,
          "transmission-linear",
          frame.thumbnail.raster,
        );
        const { display } = processNegative(source, recipe);
        const rgb = encode8(display);
        const rgba = new Uint8ClampedArray(rgb.length / 3 * 4);
        for (let sourceOffset = 0, targetOffset = 0; sourceOffset < rgb.length; sourceOffset += 3, targetOffset += 4) {
          rgba[targetOffset] = rgb[sourceOffset]!;
          rgba[targetOffset + 1] = rgb[sourceOffset + 1]!;
          rgba[targetOffset + 2] = rgb[sourceOffset + 2]!;
          rgba[targetOffset + 3] = 255;
        }
        thumb = { rgba, width: display.width, height: display.height };
      } catch {
        return;
      }
    }
    if (canvas === null || thumb === undefined) return;
    canvas.width = thumb.width;
    canvas.height = thumb.height;
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.putImageData(new ImageData(thumb.rgba, thumb.width, thumb.height), 0, 0);
  }, [frame.renderedThumbnail, frame.thumbnail, recipe, synchronousFallback]);

  return <canvas ref={canvasRef} className="frame-thumb" />;
}

export function Filmstrip({
  frames,
  activeId,
  skipped,
  recipes,
  workerFailed,
  onSelect,
  onRemove,
  onToggleSkip,
}: {
  frames: FrameEntry[];
  activeId: string | null;
  skipped: Set<string>;
  recipes: Record<string, Recipe>;
  workerFailed: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onToggleSkip: (id: string) => void;
}) {
  return (
    <aside className="filmstrip">
      {frames.map((frame) => (
        <div
          key={frame.info.id}
          className={[
            "frame-card",
            frame.info.id === activeId ? "active" : "",
            skipped.has(frame.info.id) ? "skipped" : "",
          ].filter(Boolean).join(" ")}
          onClick={() => onSelect(frame.info.id)}
        >
          <FrameThumb frame={frame} recipe={recipes[frame.info.id]} synchronousFallback={workerFailed} />
          <div className="frame-meta">
            <span className="frame-name" title={frame.failure ?? frame.info.fileName}>{frame.info.fileName}</span>
            <span className={`frame-status ${frame.status}`}>
              {frame.status === "exported" ? "✓" : frame.status === "failed" ? "✕" : ""}
            </span>
          </div>
          <button
            className="frame-remove"
            title="移除该帧"
            onClick={(event) => {
              event.stopPropagation();
              onRemove(frame.info.id);
            }}
          >
            ✕
          </button>
          <button
            className="frame-skip"
            title={skipped.has(frame.info.id) ? "取消跳过" : "导出时跳过"}
            onClick={(event) => {
              event.stopPropagation();
              onToggleSkip(frame.info.id);
            }}
          >
            {skipped.has(frame.info.id) ? "⊘" : "⏭"}
          </button>
        </div>
      ))}
      <div className="filmstrip-footer">{frames.length - skipped.size} 帧待导出</div>
    </aside>
  );
}
