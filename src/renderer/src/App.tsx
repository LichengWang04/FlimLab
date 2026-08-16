import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_RECIPE, Raster, encode8, processNegative, srgbOetf } from "../../core/index.ts";
import type { BaseSample, DensityAnchors, Recipe, Rect, Rgb } from "../../core/index.ts";
import type {
  RollExportProgress,
  RollExportResult,
  RollFrameInfo,
  RollOpenMode,
  RollPreview,
  RollThumbnail,
} from "../../shared/ipc.ts";
import { RadioGroup, Section, Slider } from "./ui.tsx";

type DrawMode = "view" | "base-roi" | "neutral-roi" | "crop";

interface PreviewResult {
  rgba: Uint8ClampedArray<ArrayBuffer>;
  /** Delivered composition size (after rotation and crop). */
  width: number;
  height: number;
  base: BaseSample;
  anchors: DensityAnchors;
  whitePoint: number;
  autoGains?: Rgb;
  ms: number;
}

interface FrameEntry {
  info: RollFrameInfo;
  thumbnail: { width: number; height: number; raster: Float32Array } | null;
  status: "idle" | "exported" | "failed";
  failure?: string;
}

const BASE_ERROR = /片基/;
const PREVIEW_CACHE_LIMIT = 3;

function cloneRecipe(recipe: Recipe): Recipe {
  return {
    ...recipe,
    crop: recipe.crop === undefined ? undefined : { ...recipe.crop },
    baseRoi: recipe.baseRoi === undefined ? undefined : { ...recipe.baseRoi },
    neutralRoi: recipe.neutralRoi === undefined ? undefined : { ...recipe.neutralRoi },
    whiteBalance: [...recipe.whiteBalance],
  };
}

function FrameThumb({ frame, recipe }: { frame: FrameEntry; recipe: Recipe | undefined }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const thumb = frame.thumbnail;
    if (canvas === null || thumb === null) return;
    canvas.width = thumb.width;
    canvas.height = thumb.height;
    const context = canvas.getContext("2d");
    if (context === null) return;

    let bytes: Uint8Array;
    let outWidth = thumb.width;
    let outHeight = thumb.height;
    try {
      if (recipe === undefined) throw new Error("配方尚未就绪。");
      const raster = new Raster(thumb.width, thumb.height, "transmission-linear", thumb.raster);
      const { display } = processNegative(raster, recipe);
      bytes = encode8(display);
      outWidth = display.width;
      outHeight = display.height;
    } catch {
      // Fallback: show the raw negative scan (linear → sRGB).
      bytes = new Uint8Array(thumb.raster.length);
      for (let index = 0; index < thumb.raster.length; index += 1) {
        bytes[index] = Math.round(srgbOetf(thumb.raster[index]!) * 255);
      }
    }
    canvas.width = outWidth;
    canvas.height = outHeight;
    const rgba = new Uint8ClampedArray(bytes.length / 3 * 4);
    for (let i = 0, j = 0; i < bytes.length; i += 3, j += 4) {
      rgba[j] = bytes[i]!;
      rgba[j + 1] = bytes[i + 1]!;
      rgba[j + 2] = bytes[i + 2]!;
      rgba[j + 3] = 255;
    }
    context.putImageData(new ImageData(rgba, outWidth, outHeight), 0, 0);
  }, [frame.thumbnail, recipe]);

  return <canvas ref={canvasRef} className="frame-thumb" />;
}

export function App() {
  const [frames, setFrames] = useState<FrameEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [preview, setPreview] = useState<RollPreview | null>(null);
  const [recipes, setRecipes] = useState<Record<string, Recipe>>({});
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [mode, setMode] = useState<DrawMode>("view");
  const [draft, setDraft] = useState<Rect | null>(null);
  const [exporting, setExporting] = useState<"tiff" | "jpeg" | null>(null);
  const [rollProgress, setRollProgress] = useState<RollExportProgress | null>(null);
  const [summary, setSummary] = useState<RollExportResult | null>(null);

  const imageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);
  const toastTimerRef = useRef<number | undefined>(undefined);
  const previewCacheRef = useRef(new Map<string, RollPreview>());
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const recipe = activeId === null ? null : recipes[activeId] ?? null;

  const update = useCallback((patch: Partial<Recipe>) => {
    const id = activeIdRef.current;
    if (id === null) return;
    setRecipes((current) => {
      const previous = current[id];
      if (previous === undefined) return current;
      return { ...current, [id]: { ...previous, ...patch } };
    });
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 6000);
  }, []);

  // Listen to batch export progress for the lifetime of the window.
  useEffect(() => window.filmlab.onExportProgress(setRollProgress), []);

  // Debounced preview processing of the active frame; thumbnails and export
  // reuse the same core so everything stays on one formula set.
  useEffect(() => {
    if (preview === null || recipe === null) return;
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      const id = activeIdRef.current;
      try {
        const raster = new Raster(preview.width, preview.height, "transmission-linear", preview.raster);
        const started = performance.now();
        const { display, base, anchors, whitePoint, autoGains } = processNegative(raster, recipe);
        const bytes = encode8(display);
        const rgba = new Uint8ClampedArray(bytes.length / 3 * 4);
        for (let i = 0, j = 0; i < bytes.length; i += 3, j += 4) {
          rgba[j] = bytes[i]!;
          rgba[j + 1] = bytes[i + 1]!;
          rgba[j + 2] = bytes[i + 2]!;
          rgba[j + 3] = 255;
        }
        setResult({
          rgba,
          width: display.width,
          height: display.height,
          base,
          anchors,
          whitePoint,
          autoGains,
          ms: performance.now() - started,
        });
        setError(null);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        // A crop can leave a drawn base ROI over image content; fall back
        // to the automatic envelope estimate instead of failing.
        if (BASE_ERROR.test(message) && recipe.baseMode !== "auto") {
          setRecipes((current) => {
            const previous = current[id ?? ""];
            if (id === null || previous === undefined) return current;
            return { ...current, [id]: { ...previous, baseMode: "auto", baseRoi: undefined } };
          });
        } else {
          setError(message);
        }
      }
    }, 110);
    return () => window.clearTimeout(debounceRef.current);
  }, [preview, recipe]);

  // Draw the processed preview at the delivered (post-geometry) size.
  useEffect(() => {
    const canvas = imageCanvasRef.current;
    if (canvas === null || result === null) return;
    canvas.width = result.width;
    canvas.height = result.height;
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.putImageData(new ImageData(result.rgba, result.width, result.height), 0, 0);
  }, [result]);

  // Draw region overlays in delivered-space coordinates (base and neutral
  // ROIs are already relative to the delivered frame), on a layer matching
  // the delivered canvas so drags stay cheap.
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (canvas === null || result === null || recipe === null) return;
    canvas.width = result.width;
    canvas.height = result.height;
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.clearRect(0, 0, canvas.width, canvas.height);

    const stroke = (rect: Rect, color: string) => {
      context.strokeStyle = color;
      context.lineWidth = Math.max(2, Math.round(canvas.width / 500));
      context.setLineDash([Math.round(canvas.width / 90), Math.round(canvas.width / 180)]);
      context.strokeRect(
        rect.x * canvas.width,
        rect.y * canvas.height,
        rect.width * canvas.width,
        rect.height * canvas.height,
      );
      context.setLineDash([]);
    };
    if (recipe.baseMode === "roi" && recipe.baseRoi !== undefined && mode !== "base-roi") {
      stroke(recipe.baseRoi, "#4ade80");
    }
    if (recipe.neutralRoi !== undefined && mode !== "neutral-roi") {
      stroke(recipe.neutralRoi, "#60a5fa");
    }
    if (recipe.crop !== undefined) {
      // A crop defines the delivered frame boundary; mark it with an inset
      // outline rather than a region that no longer exists on the canvas.
      context.strokeStyle = "#f8fafc";
      context.lineWidth = 1;
      context.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
    }
    if (draft !== null) {
      stroke(draft, "#facc15");
    }
  }, [result, recipe, mode, draft]);

  const selectFrame = useCallback(async (id: string) => {
    setActiveId(id);
    setResult(null);
    setError(null);
    setDraft(null);
    setMode("view");
    const cache = previewCacheRef.current;
    const cached = cache.get(id);
    if (cached !== undefined) {
      setPreview(cached);
      return;
    }
    try {
      const decoded = await window.filmlab.previewFrame(id);
      if (activeIdRef.current === id) {
        cache.set(id, decoded);
        while (cache.size > PREVIEW_CACHE_LIMIT) {
          const oldest = cache.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
        setPreview(decoded);
      }
    } catch (caught) {
      if (activeIdRef.current === id) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }
  }, []);

  const handleOpen = useCallback(async (openMode: RollOpenMode) => {
    try {
      const infos = await window.filmlab.openRoll(openMode);
      if (infos === null) return;
      if (infos.length === 0) {
        showToast("所选文件夹中没有支持的图像文件(TIFF/JPEG/PNG)。");
        return;
      }
      setFrames(infos.map((info) => ({ info, thumbnail: null, status: "idle" as const })));
      setSkipped(new Set());
      setSummary(null);
      setRollProgress(null);
      setRecipes((current) => {
        const next = { ...current };
        for (const info of infos) {
          if (next[info.id] === undefined) next[info.id] = DEFAULT_RECIPE;
        }
        return next;
      });
      for (const info of infos) {
        window.filmlab.thumbnailFrame(info.id).then((thumb: RollThumbnail) => {
          setFrames((current) => current.map(
            (frame) => frame.info.id === thumb.id ? { ...frame, thumbnail: thumb } : frame,
          ));
        }).catch(() => {
          // Thumbnail decode failures leave the card blank; preview/export
          // still report their own errors.
        });
      }
      await selectFrame(infos[0]!.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [selectFrame, showToast]);

  const removeFrame = useCallback((id: string) => {
    setFrames((current) => {
      const index = current.findIndex((frame) => frame.info.id === id);
      const next = current.filter((frame) => frame.info.id !== id);
      if (id === activeIdRef.current) {
        if (next.length > 0) {
          const neighbor = next[Math.min(index, next.length - 1)]!;
          void selectFrame(neighbor.info.id);
        } else {
          setActiveId(null);
          setPreview(null);
          setResult(null);
        }
      }
      return next;
    });
  }, [selectFrame]);

  const toggleSkip = useCallback((id: string) => {
    setSkipped((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const applyRecipeToAll = useCallback(() => {
    const id = activeIdRef.current;
    if (id === null) return;
    setRecipes((current) => {
      const source = current[id];
      if (source === undefined) return current;
      const next = { ...current };
      for (const frame of frames) {
        if (!skipped.has(frame.info.id)) next[frame.info.id] = cloneRecipe(source);
      }
      return next;
    });
    showToast("当前帧配方已应用到整卷(跳过的帧除外)。");
  }, [frames, skipped, showToast]);

  const handleExportSingle = useCallback(async (format: "tiff" | "jpeg") => {
    const id = activeIdRef.current;
    if (id === null || recipe === null || exporting !== null) return;
    setExporting(format);
    try {
      const outcome = await window.filmlab.exportFrame({ id, recipe, format });
      if (outcome.ok) {
        showToast(`已导出正像:${outcome.path}`);
      } else {
        setError(outcome.message ?? "导出失败。");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setExporting(null);
    }
  }, [recipe, exporting, showToast]);

  const handleExportRoll = useCallback(async (format: "tiff" | "jpeg") => {
    if (exporting !== null || frames.length === 0) return;
    const targets = frames
      .filter((frame) => !skipped.has(frame.info.id))
      .map((frame) => ({ id: frame.info.id, recipe: recipes[frame.info.id] ?? DEFAULT_RECIPE }));
    if (targets.length === 0) {
      showToast("所有帧都已跳过,没有可导出的帧。");
      return;
    }
    setExporting(format);
    setSummary(null);
    setRollProgress({ done: 0, total: targets.length, fileName: "" });
    try {
      const outcome = await window.filmlab.exportRoll({ frames: targets, format });
      const succeededIds = new Set(outcome.succeeded.map((entry) => entry.id));
      const failedMessages = new Map(outcome.failed.map((entry) => [entry.id, entry.message]));
      setFrames((current) => current.map((frame) => {
        if (succeededIds.has(frame.info.id)) return { ...frame, status: "exported" as const };
        if (failedMessages.has(frame.info.id)) {
          return { ...frame, status: "failed" as const, failure: failedMessages.get(frame.info.id) };
        }
        return frame;
      }));
      setSummary(outcome);
      if (outcome.ok && !outcome.cancelled && outcome.failed.length === 0) {
        showToast(`整卷导出完成:${outcome.succeeded.length} 帧。`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setExporting(null);
      setRollProgress(null);
    }
  }, [exporting, frames, skipped, recipes, showToast]);

  const toImagePoint = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = overlayCanvasRef.current!;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) * canvas.width / bounds.width,
      y: (event.clientY - bounds.top) * canvas.height / bounds.height,
    };
  }, []);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode === "view") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStartRef.current = toImagePoint(event);
  }, [mode, toImagePoint]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragStartRef.current === null) return;
    const canvas = overlayCanvasRef.current;
    if (canvas === null) return;
    const point = toImagePoint(event);
    const start = dragStartRef.current;
    setDraft({
      x: Math.min(start.x, point.x) / canvas.width,
      y: Math.min(start.y, point.y) / canvas.height,
      width: Math.abs(point.x - start.x) / canvas.width,
      height: Math.abs(point.y - start.y) / canvas.height,
    });
  }, [toImagePoint]);

  const handlePointerUp = useCallback(() => {
    dragStartRef.current = null;
    setDraft((current) => {
      if (current === null || current.width < 0.002 || current.height < 0.002) return null;
      if (mode === "base-roi") {
        update({ baseRoi: current, baseMode: "roi" });
      } else if (mode === "neutral-roi") {
        update({ neutralRoi: current, autoNeutralize: true });
      } else if (mode === "crop") {
        update({ crop: current });
      }
      setMode("view");
      return null;
    });
  }, [mode, update]);

  const baseLabel = result === null ? "—" : result.base.method === "roi" ? "ROI 选区" : "自动估算";
  const baseDetail = result === null ? "" : `${(result.base.confidence * 100).toFixed(0)}% 置信度`;
  const batchTotal = frames.length - skipped.size;
  const batchBusy = exporting !== null && rollProgress !== null;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">FilmLab</span>
        <span className="topbar-sep" />
        <button className="btn primary" onClick={() => void handleOpen("single")} disabled={batchBusy}>打开负片…</button>
        <button className="btn" onClick={() => void handleOpen("files")} disabled={batchBusy}>导入整卷…</button>
        <button className="btn" onClick={() => void handleOpen("folder")} disabled={batchBusy}>导入文件夹…</button>
        <span className="topbar-sep" />
        {rollProgress !== null && (
          <span className="roll-progress">
            导出 {rollProgress.done}/{rollProgress.total} · {rollProgress.fileName}
            <button className="btn ghost" onClick={() => void window.filmlab.cancelRollExport()}>取消</button>
          </span>
        )}
        <button className="btn" disabled={activeId === null || exporting !== null} onClick={() => void handleExportSingle("tiff")}>
          {exporting === "tiff" && rollProgress === null ? "导出中…" : "导出单帧 TIFF"}
        </button>
        <button className="btn" disabled={activeId === null || exporting !== null} onClick={() => void handleExportSingle("jpeg")}>
          {exporting === "jpeg" && rollProgress === null ? "导出中…" : "导出单帧 JPEG"}
        </button>
        <button className="btn" disabled={frames.length === 0 || exporting !== null} onClick={() => void handleExportRoll("tiff")}>
          {batchBusy && exporting === "tiff" ? "整卷导出中…" : "整卷→TIFF"}
        </button>
        <button className="btn" disabled={frames.length === 0 || exporting !== null} onClick={() => void handleExportRoll("jpeg")}>
          {batchBusy && exporting === "jpeg" ? "整卷导出中…" : "整卷→JPEG"}
        </button>
        <button
          className="btn ghost"
          disabled={activeId === null}
          onClick={() => update({ ...DEFAULT_RECIPE, baseRoi: undefined })}
        >
          复位当前帧
        </button>
      </header>

      <main className="layout">
        {frames.length > 0 && (
          <aside className="filmstrip">
            {frames.map((frame) => (
              <div
                key={frame.info.id}
                className={[
                  "frame-card",
                  frame.info.id === activeId ? "active" : "",
                  skipped.has(frame.info.id) ? "skipped" : "",
                ].filter(Boolean).join(" ")}
                onClick={() => void selectFrame(frame.info.id)}
              >
                <FrameThumb frame={frame} recipe={recipes[frame.info.id]} />
                <div className="frame-meta">
                  <span className="frame-name" title={frame.failure ?? frame.info.fileName}>
                    {frame.info.fileName}
                  </span>
                  <span className={`frame-status ${frame.status}`}>
                    {frame.status === "exported" ? "✓" : frame.status === "failed" ? "✕" : ""}
                  </span>
                </div>
                <button
                  className="frame-remove"
                  title="移除该帧"
                  onClick={(event) => {
                    event.stopPropagation();
                    removeFrame(frame.info.id);
                  }}
                >
                  ✕
                </button>
                <button
                  className="frame-skip"
                  title={skipped.has(frame.info.id) ? "取消跳过" : "导出时跳过"}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleSkip(frame.info.id);
                  }}
                >
                  {skipped.has(frame.info.id) ? "⊘" : "⏭"}
                </button>
              </div>
            ))}
            <div className="filmstrip-footer">{batchTotal} 帧待导出</div>
          </aside>
        )}

        <div className="workspace">
          {preview === null ? (
            <div className="empty">
              <h1>负片 → 正像</h1>
              <p>打开单张负片,或一次导入整卷胶片,自动检测片基、反转密度并还原正像。</p>
              <div className="empty-actions">
                <button className="btn primary large" onClick={() => void handleOpen("single")}>打开负片…</button>
                <button className="btn large" onClick={() => void handleOpen("files")}>导入整卷…</button>
                <button className="btn large" onClick={() => void handleOpen("folder")}>导入文件夹…</button>
              </div>
              <p className="hint">支持 8/16 位 TIFF、JPEG、PNG;16 位 TIFF 无 ICC 时按线性扫描数据读取。</p>
            </div>
          ) : (
            <>
              <div className="canvas-frame">
                <canvas className="image-canvas" ref={imageCanvasRef} />
                <canvas
                  className={`overlay-canvas${mode === "view" ? "" : " drawing"}`}
                  ref={overlayCanvasRef}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                />
                {error !== null && (
                  <div className="error-banner">
                    {error}
                    <button className="dismiss" onClick={() => setError(null)}>✕</button>
                  </div>
                )}
                {toast !== null && <div className="toast">{toast}</div>}
              </div>
              <div className="modebar">
                <RadioGroup<DrawMode>
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: "view", label: "视图" },
                    { value: "base-roi", label: "框选片基" },
                    { value: "neutral-roi", label: "框选中性高密度" },
                    { value: "crop", label: "框选裁剪" },
                  ]}
                />
                <span className="modebar-hint">
                  {mode === "view" ? "选择一种框选模式后在画面上拖拽。" : "在画面上拖拽出选区。"}
                </span>
              </div>
            </>
          )}
        </div>

        {recipe !== null && preview !== null && (
          <aside className="panel">
            <Section title="整卷">
              <button className="btn" onClick={applyRecipeToAll} disabled={frames.length < 2}>应用到整卷</button>
              <p className="field-note">把当前帧的完整配方复制给整卷(跳过的帧除外)。</p>
            </Section>

            <Section title="几何">
              <button className="btn" onClick={() => update({ rotate: ((recipe.rotate + 90) % 360) as Recipe["rotate"] })}>
                ⟲ 旋转 90°(当前 {recipe.rotate}°)
              </button>
              <button className="btn" onClick={() => setMode("crop")} disabled={recipe.crop !== undefined}>
                框选裁剪
              </button>
              {recipe.crop !== undefined && (
                <button className="btn ghost" onClick={() => update({ crop: undefined })}>清除裁剪</button>
              )}
            </Section>

            <Section title="片基">
              <RadioGroup
                value={recipe.baseMode}
                onChange={(baseMode) => {
                  update({ baseMode });
                  if (baseMode === "roi" && recipe.baseRoi === undefined) setMode("base-roi");
                }}
                options={[
                  { value: "auto", label: "默认" },
                  { value: "roi", label: "手动选取" },
                ]}
              />
              <button className="btn" onClick={() => setMode("base-roi")}>框选片基区域</button>
              {recipe.baseMode === "roi" && recipe.baseRoi !== undefined && (
                <button
                  className="btn ghost"
                  onClick={() => update({ baseRoi: undefined, baseMode: "auto" })}
                >
                  清除选区(回到默认)
                </button>
              )}
              <p className="field-note">
                片基:{baseLabel} · {baseDetail}
              </p>
            </Section>

            <Section title="反转">
              <RadioGroup
                value={recipe.dmaxMode}
                onChange={(dmaxMode) => update({ dmaxMode })}
                options={[
                  { value: "auto", label: "自动 Dmax" },
                  { value: "manual", label: "手动 Dmax" },
                ]}
              />
              {recipe.dmaxMode === "manual" && (
                <Slider
                  label="Dmax"
                  value={recipe.manualDmax}
                  min={0.2}
                  max={3.5}
                  step={0.01}
                  onChange={(manualDmax) => update({ manualDmax })}
                  format={(value) => value.toFixed(2)}
                />
              )}
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={recipe.autoNeutralize}
                  onChange={(event) => update({ autoNeutralize: event.target.checked })}
                />
                自动中和橙罩(中性像素拟合)
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={recipe.autoWhiteBalance}
                  onChange={(event) => update({ autoWhiteBalance: event.target.checked })}
                />
                自动白平衡(灰世界中位数)
              </label>
              <button className="btn" onClick={() => setMode("neutral-roi")}>框选中性高密度区域</button>
              {recipe.neutralRoi !== undefined && (
                <button className="btn ghost" onClick={() => update({ neutralRoi: undefined })}>清除中性区</button>
              )}
              <Slider
                label="白平衡 R"
                value={recipe.whiteBalance[0]}
                min={0.6}
                max={1.6}
                step={0.01}
                onChange={(value) => update({ whiteBalance: [value, recipe.whiteBalance[1], recipe.whiteBalance[2]] })}
              />
              <Slider
                label="白平衡 B"
                value={recipe.whiteBalance[2]}
                min={0.6}
                max={1.6}
                step={0.01}
                onChange={(value) => update({ whiteBalance: [recipe.whiteBalance[0], recipe.whiteBalance[1], value] })}
              />
              <Slider
                label="密度预饱和"
                value={recipe.preSaturation}
                min={0.5}
                max={2}
                step={0.01}
                onChange={(preSaturation) => update({ preSaturation })}
              />
            </Section>

            <Section title="调色">
              <Slider
                label="曝光"
                value={recipe.exposure}
                min={-3}
                max={3}
                step={0.05}
                onChange={(exposure) => update({ exposure })}
                format={(value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)} EV`}
              />
              <Slider
                label="对比度"
                value={recipe.contrast}
                min={0.5}
                max={1.5}
                step={0.01}
                onChange={(contrast) => update({ contrast })}
              />
              <Slider
                label="高光压缩"
                value={recipe.highlightCompression}
                min={0}
                max={1}
                step={0.01}
                onChange={(highlightCompression) => update({ highlightCompression })}
              />
              <Slider
                label="饱和度"
                value={recipe.saturation}
                min={0}
                max={2}
                step={0.01}
                onChange={(saturation) => update({ saturation })}
              />
            </Section>
          </aside>
        )}
      </main>

      {preview !== null && (
        <footer className="statusbar">
          <span>{preview.fileName} · {preview.width}×{preview.height} 预览 · {preview.depth} 位{preview.hasIcc ? " · 带 ICC" : " · 无 ICC"}</span>
          {result !== null && (
            <>
              <span>
                Dmin {result.anchors.dmin.toFixed(3)} · Dmax {result.anchors.dmax.toFixed(3)} · 范围 {result.anchors.range.toFixed(3)}
              </span>
              <span>
                通道拟合 {result.anchors.channelFit === undefined
                  ? "—"
                  : result.anchors.channelFit.slope.map((value) => value.toFixed(3)).join("/")}
              </span>
              {result.autoGains !== undefined && (
                <span>自动白平衡 {result.autoGains.map((value) => value.toFixed(2)).join("/")}</span>
              )}
              <span>白点 {result.whitePoint.toFixed(3)} · 预览 {result.ms.toFixed(0)} ms</span>
            </>
          )}
        </footer>
      )}

      {summary !== null && (summary.failed.length > 0 || summary.cancelled) && (
        <div className="summary-overlay">
          <div className="summary-card">
            <h2>整卷导出{summary.cancelled ? "已取消" : "完成"}</h2>
            <p>
              成功 {summary.succeeded.length} 帧 · 失败 {summary.failed.length} 帧
              {summary.failed.length === 0 && summary.cancelled ? "(取消前已完成的帧已保存)" : ""}
            </p>
            {summary.failed.length > 0 && (
              <ul className="summary-failures">
                {summary.failed.map((entry) => (
                  <li key={entry.id} title={entry.message}>
                    {entry.fileName || entry.id}:{entry.message}
                  </li>
                ))}
              </ul>
            )}
            <button className="btn" onClick={() => setSummary(null)}>关闭</button>
          </div>
        </div>
      )}
    </div>
  );
}
