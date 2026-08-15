import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_RECIPE, Raster, encode8, processNegative } from "../../core/index.ts";
import type { BaseSample, DensityAnchors, Recipe, Rect } from "../../core/index.ts";
import type { OpenedSource } from "../../shared/ipc.ts";
import { RadioGroup, Section, Slider } from "./ui.tsx";

type DrawMode = "view" | "base-roi" | "neutral-roi" | "crop";

interface PreviewResult {
  rgba: Uint8ClampedArray<ArrayBuffer>;
  base: BaseSample;
  anchors: DensityAnchors;
  whitePoint: number;
  ms: number;
}

const BASE_ERROR = /片基/;

export function App() {
  const [source, setSource] = useState<OpenedSource | null>(null);
  const [recipe, setRecipe] = useState<Recipe>(DEFAULT_RECIPE);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [mode, setMode] = useState<DrawMode>("view");
  const [draft, setDraft] = useState<Rect | null>(null);
  const [exporting, setExporting] = useState<"tiff" | "jpeg" | null>(null);

  const imageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);
  const toastTimerRef = useRef<number | undefined>(undefined);

  const update = useCallback((patch: Partial<Recipe>) => {
    setRecipe((current) => ({ ...current, ...patch }));
  }, []);

  // Debounced preview processing on the main thread; 1600px frames cost tens
  // of milliseconds, so a short quiet period is enough to stay responsive.
  useEffect(() => {
    if (source === null) return;
    const recipeKey = JSON.stringify(recipe);
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      try {
        const raster = new Raster(source.width, source.height, "transmission-linear", source.raster);
        const started = performance.now();
        const { display, base, anchors, whitePoint } = processNegative(raster, recipe);
        const bytes = encode8(display);
        const rgba = new Uint8ClampedArray(bytes.length / 3 * 4);
        for (let i = 0, j = 0; i < bytes.length; i += 3, j += 4) {
          rgba[j] = bytes[i]!;
          rgba[j + 1] = bytes[i + 1]!;
          rgba[j + 2] = bytes[i + 2]!;
          rgba[j + 3] = 255;
        }
        setResult({ rgba, base, anchors, whitePoint, ms: performance.now() - started });
        setError(null);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        // A crop can leave the default border ROI over image content; fall
        // back to the automatic envelope estimate instead of failing.
        if (BASE_ERROR.test(message) && recipe.baseMode !== "auto") {
          setRecipe((current) => ({ ...current, baseMode: "auto" }));
        } else {
          setError(message);
        }
      }
    }, 110);
    return () => window.clearTimeout(debounceRef.current);
  }, [source, recipe]);

  // Draw the processed preview.
  useEffect(() => {
    const canvas = imageCanvasRef.current;
    if (canvas === null || source === null || result === null) return;
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.putImageData(new ImageData(result.rgba, source.width, source.height), 0, 0);
  }, [source, result]);

  // Draw region overlays on a separate layer so drags stay cheap.
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (canvas === null || source === null) return;
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.clearRect(0, 0, canvas.width, canvas.height);

    const stroke = (rect: Rect, color: string) => {
      context.strokeStyle = color;
      context.lineWidth = Math.max(2, Math.round(source.width / 500));
      context.setLineDash([Math.round(source.width / 90), Math.round(source.width / 180)]);
      context.strokeRect(
        rect.x * source.width,
        rect.y * source.height,
        rect.width * source.width,
        rect.height * source.height,
      );
      context.setLineDash([]);
    };
    if (recipe.baseMode === "roi" && (mode === "base-roi" || recipe.baseRoi !== DEFAULT_RECIPE.baseRoi)) {
      stroke(recipe.baseRoi, "#4ade80");
    }
    if (recipe.neutralRoi !== undefined && mode !== "neutral-roi") {
      stroke(recipe.neutralRoi, "#60a5fa");
    }
    if (recipe.crop !== undefined && mode !== "crop") {
      stroke(recipe.crop, "#f8fafc");
    }
    if (draft !== null) {
      stroke(draft, "#facc15");
    }
  }, [source, recipe, mode, draft]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 6000);
  }, []);

  const handleOpen = useCallback(async () => {
    try {
      const opened = await window.filmlab.openNegative();
      if (opened === null) return;
      setSource(opened);
      setRecipe(DEFAULT_RECIPE);
      setResult(null);
      setError(null);
      setMode("view");
      setDraft(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const handleExport = useCallback(async (format: "tiff" | "jpeg") => {
    if (source === null || exporting !== null) return;
    setExporting(format);
    try {
      const outcome = await window.filmlab.exportPositive({ format, recipe });
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
  }, [source, recipe, exporting, showToast]);

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
    if (dragStartRef.current === null || source === null) return;
    const point = toImagePoint(event);
    const start = dragStartRef.current;
    setDraft({
      x: Math.min(start.x, point.x) / source.width,
      y: Math.min(start.y, point.y) / source.height,
      width: Math.abs(point.x - start.x) / source.width,
      height: Math.abs(point.y - start.y) / source.height,
    });
  }, [source, toImagePoint]);

  const handlePointerUp = useCallback(() => {
    dragStartRef.current = null;
    setDraft((current) => {
      if (current === null || current.width < 0.002 || current.height < 0.002) return null;
      if (mode === "base-roi") {
        setRecipe((recipe) => ({ ...recipe, baseRoi: current, baseMode: "roi" }));
      } else if (mode === "neutral-roi") {
        setRecipe((recipe) => ({ ...recipe, neutralRoi: current, autoNeutralize: true }));
      } else if (mode === "crop") {
        setRecipe((recipe) => ({ ...recipe, crop: current }));
      }
      setMode("view");
      return null;
    });
  }, [mode]);

  const baseLabel = result === null ? "—" : result.base.method === "roi" ? "ROI 选区" : "自动估算";
  const baseDetail = result === null ? "" : `${(result.base.confidence * 100).toFixed(0)}% 置信度`;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">FilmLab</span>
        <span className="topbar-sep" />
        <button className="btn primary" onClick={handleOpen}>打开负片…</button>
        <button
          className="btn"
          disabled={source === null || exporting !== null}
          onClick={() => void handleExport("tiff")}
        >
          {exporting === "tiff" ? "导出中…" : "导出 16-bit TIFF"}
        </button>
        <button
          className="btn"
          disabled={source === null || exporting !== null}
          onClick={() => void handleExport("jpeg")}
        >
          {exporting === "jpeg" ? "导出中…" : "导出 JPEG"}
        </button>
        <button className="btn ghost" disabled={source === null} onClick={() => setRecipe(DEFAULT_RECIPE)}>
          复位全部
        </button>
      </header>

      <main className="layout">
        <div className="workspace">
          {source === null ? (
            <div className="empty">
              <h1>负片 → 正像</h1>
              <p>打开胶片翻拍或扫描得到的负像图片,自动检测片基、反转密度并还原正像。</p>
              <button className="btn primary large" onClick={handleOpen}>打开负片…</button>
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

        {source !== null && (
          <aside className="panel">
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
                onChange={(baseMode) => update({ baseMode })}
                options={[
                  { value: "roi", label: "默认选区(左侧 8%)" },
                  { value: "auto", label: "自动估算" },
                ]}
              />
              <button className="btn" onClick={() => setMode("base-roi")}>框选片基区域</button>
              <p className="field-note">
                片基:{baseLabel} · {baseDetail}
              </p>
              {recipe.baseMode === "auto" && (
                <p className="field-note warn">自动估算只是上包络近似,无法替代实测未曝光片基;建议保留胶片边缘再框选。</p>
              )}
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
                自动中和橙罩(中性高密度锚点)
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

      {source !== null && (
        <footer className="statusbar">
          <span>{source.fileName} · {source.width}×{source.height} 预览 · {source.depth} 位{source.hasIcc ? " · 带 ICC" : " · 无 ICC"}</span>
          {result !== null && (
            <>
              <span>
                Dmin {result.anchors.dmin.toFixed(3)} · Dmax {result.anchors.dmax.toFixed(3)} · 范围 {result.anchors.range.toFixed(3)}
              </span>
              <span>
                通道范围 {result.anchors.channelRange === undefined
                  ? "—"
                  : result.anchors.channelRange.map((value) => value.toFixed(3)).join("/")}
              </span>
              <span>白点 {result.whitePoint.toFixed(3)} · 预览 {result.ms.toFixed(0)} ms</span>
            </>
          )}
        </footer>
      )}
    </div>
  );
}
