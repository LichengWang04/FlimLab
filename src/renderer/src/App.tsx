import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_RECIPE,
  Raster,
  encode8,
  normalizeRotation,
  processNegative,
  straightenAngle,
} from "../../core/index.ts";
import type { BaseSample, DensityAnchors, Recipe, Rect, Rgb } from "../../core/index.ts";
import type {
  AppInfo,
  RollExportProgress,
  RollExportResult,
  RollFrameInfo,
  RollOpenMode,
  RollPreview,
  RollThumbnail,
} from "../../shared/ipc.ts";
import { RadioGroup } from "./ui.tsx";
import { AboutDialog } from "./AboutDialog.tsx";
import { AdjustmentPanel } from "./AdjustmentPanel.tsx";
import { Filmstrip } from "./Filmstrip.tsx";
import { FilmCanisterIcon } from "./FilmCanisterIcon.tsx";
import { PreviewWorkerClient } from "./preview-worker-client.ts";
import { cloneRecipe } from "./renderer-types.ts";
import type { DrawMode, FrameEntry, PreviewResult, StraightenLine } from "./renderer-types.ts";

const BASE_ERROR = /片基/;
const PREVIEW_CACHE_LIMIT = 3;
const NEUTRALIZATION_LABEL = {
  curve: "曲线",
  "neutral-axis": "中性轴",
  pca: "PCA",
  anchor: "锚点",
  none: "无校正",
} as const;

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
  const [draftLine, setDraftLine] = useState<StraightenLine | null>(null);
  const [overlayRevision, setOverlayRevision] = useState(0);
  const [exporting, setExporting] = useState<"tiff" | "jpeg" | null>(null);
  const [rollProgress, setRollProgress] = useState<RollExportProgress | null>(null);
  const [summary, setSummary] = useState<RollExportResult | null>(null);
  const [workerReady, setWorkerReady] = useState(false);
  const [workerFailed, setWorkerFailed] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);

  const imageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const draftLineRef = useRef<StraightenLine | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);
  const toastTimerRef = useRef<number | undefined>(undefined);
  const sessionSaveTimerRef = useRef<number | undefined>(undefined);
  const previewCacheRef = useRef(new Map<string, RollPreview>());
  const previewWorkerRef = useRef<PreviewWorkerClient | null>(null);
  const previewRevisionRef = useRef(0);
  const thumbnailRecipeKeysRef = useRef(new Map<string, string>());
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

  const loadThumbnails = useCallback((infos: RollFrameInfo[]) => {
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
  }, []);

  // Listen to batch export progress for the lifetime of the window.
  useEffect(() => window.filmlab.onExportProgress(setRollProgress), []);

  useEffect(() => {
    void window.filmlab.appInfo().then(setAppInfo).catch(() => setAppInfo(null));
  }, []);

  useEffect(() => {
    try {
      const client = new PreviewWorkerClient();
      client.onFatal((message) => {
        previewWorkerRef.current = null;
        setWorkerReady(false);
        setWorkerFailed(true);
        setError(`后台预览不可用，已回退到兼容模式：${message}`);
      });
      previewWorkerRef.current = client;
      setWorkerReady(true);
      return () => {
        previewWorkerRef.current = null;
        client.terminate();
      };
    } catch (caught) {
      setWorkerFailed(true);
      setError(`后台预览不可用，已回退到兼容模式：${caught instanceof Error ? caught.message : String(caught)}`);
      return;
    }
  }, []);

  // Debounced preview processing of the active frame; thumbnails and export
  // reuse the same core so everything stays on one formula set.
  useEffect(() => {
    if (preview === null || recipe === null || (!workerReady && !workerFailed)) return;
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      const id = activeIdRef.current;
      const client = previewWorkerRef.current;
      if (client !== null) {
        const submit = (revision: number, retried = false): void => {
          client.requestPreview({
            id: preview.id,
            recipe,
            revision,
            onResult: (processed, completedRevision) => {
              if (completedRevision !== previewRevisionRef.current || activeIdRef.current !== preview.id) return;
              setResult(processed);
              setError(null);
            },
            onError: (message, missingSource) => {
              if (activeIdRef.current !== preview.id) return;
              if (missingSource && !retried) {
                client.registerSource(preview.id, preview.width, preview.height, preview.raster);
                submit(++previewRevisionRef.current, true);
                return;
              }
              if (BASE_ERROR.test(message) && recipe.baseMode !== "auto") {
                setRecipes((current) => {
                  const previous = current[id ?? ""];
                  if (id === null || previous === undefined) return current;
                  return { ...current, [id]: { ...previous, baseMode: "auto", baseRoi: undefined } };
                });
              } else {
                setError(message);
              }
            },
          });
        };
        submit(++previewRevisionRef.current);
        return;
      }
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
  }, [preview, recipe, workerReady, workerFailed]);

  useEffect(() => {
    const client = previewWorkerRef.current;
    if (client === null) return;
    for (const frame of frames) {
      const thumbnail = frame.thumbnail;
      const frameRecipe = recipes[frame.info.id];
      if (thumbnail === null || frameRecipe === undefined) continue;
      const key = JSON.stringify(frameRecipe);
      if (thumbnailRecipeKeysRef.current.get(frame.info.id) === key) continue;
      thumbnailRecipeKeysRef.current.set(frame.info.id, key);
      client.requestThumbnail({
        id: frame.info.id,
        width: thumbnail.width,
        height: thumbnail.height,
        raster: thumbnail.raster,
        recipe: frameRecipe,
        onResult: (renderedThumbnail) => {
          setFrames((current) => current.map(
            (entry) => entry.info.id === frame.info.id ? { ...entry, renderedThumbnail } : entry,
          ));
        },
      });
    }
  }, [frames, recipes, workerReady]);

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

  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (canvas === null) return;
    const observer = new ResizeObserver(() => setOverlayRevision((current) => current + 1));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [preview]);

  // Draw region overlays in delivered-space coordinates (base and neutral
  // ROIs are already relative to the delivered frame), on a layer matching
  // the delivered canvas so drags stay cheap.
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    const imageCanvas = imageCanvasRef.current;
    if (canvas === null || imageCanvas === null || result === null || recipe === null) return;
    const overlayBounds = canvas.getBoundingClientRect();
    const imageBounds = imageCanvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(overlayBounds.width));
    canvas.height = Math.max(1, Math.round(overlayBounds.height));
    const imageRect = {
      x: imageBounds.left - overlayBounds.left,
      y: imageBounds.top - overlayBounds.top,
      width: imageBounds.width,
      height: imageBounds.height,
    };
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.clearRect(0, 0, canvas.width, canvas.height);

    const stroke = (rect: Rect, color: string) => {
      context.strokeStyle = color;
      context.lineWidth = Math.max(2, Math.round(imageRect.width / 500));
      context.setLineDash([Math.round(imageRect.width / 90), Math.round(imageRect.width / 180)]);
      context.strokeRect(
        imageRect.x + rect.x * imageRect.width,
        imageRect.y + rect.y * imageRect.height,
        rect.width * imageRect.width,
        rect.height * imageRect.height,
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
      context.strokeRect(imageRect.x + 1, imageRect.y + 1, imageRect.width - 2, imageRect.height - 2);
    }
    if (draft !== null) {
      stroke(draft, "#facc15");
    }
    if (draftLine !== null) {
      const startX = imageRect.x + draftLine.start.x * imageRect.width;
      const startY = imageRect.y + draftLine.start.y * imageRect.height;
      const endX = imageRect.x + draftLine.end.x * imageRect.width;
      const endY = imageRect.y + draftLine.end.y * imageRect.height;
      context.strokeStyle = "#f2a33a";
      context.fillStyle = "#f2a33a";
      context.lineWidth = Math.max(2, Math.round(imageRect.width / 500));
      context.beginPath();
      context.moveTo(startX, startY);
      context.lineTo(endX, endY);
      context.stroke();
      for (const [x, y] of [[startX, startY], [endX, endY]] as const) {
        context.beginPath();
        context.arc(x, y, Math.max(4, imageRect.width / 220), 0, Math.PI * 2);
        context.fill();
      }
      try {
        const correction = straightenAngle({ x: startX, y: startY }, { x: endX, y: endY });
        context.font = `${Math.max(12, Math.round(imageRect.width / 90))}px Segoe UI`;
        context.fillText(`${correction >= 0 ? "+" : ""}${correction.toFixed(2)}°`, (startX + endX) / 2 + 8, (startY + endY) / 2 - 8);
      } catch {
        // A zero-length draft has no angle yet.
      }
    }
  }, [result, recipe, mode, draft, draftLine, overlayRevision]);

  const selectFrame = useCallback(async (id: string) => {
    setActiveId(id);
    setResult(null);
    setError(null);
    setDraft(null);
    setDraftLine(null);
    draftLineRef.current = null;
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
        previewWorkerRef.current?.registerSource(id, decoded.width, decoded.height, decoded.raster);
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

  useEffect(() => {
    let cancelled = false;
    void window.filmlab.restoreSession().then(async (restored) => {
      if (cancelled || restored === null || restored.frames.length === 0) return;
      const entries = restored.frames.map(({ info }) => ({ info, thumbnail: null, status: "idle" as const }));
      const restoredRecipes = Object.fromEntries(restored.frames.map((frame) => [frame.info.id, frame.recipe]));
      setFrames(entries);
      setRecipes(restoredRecipes);
      setSkipped(new Set(restored.frames.filter((frame) => frame.skipped).map((frame) => frame.info.id)));
      loadThumbnails(restored.frames.map((frame) => frame.info));
      await selectFrame(restored.activeId ?? restored.frames[0]!.info.id);
      if (!cancelled) showToast(`已恢复上次会话：${restored.frames.length} 帧。`);
    }).catch((caught: unknown) => {
      if (!cancelled) setError(`无法恢复上次会话：${caught instanceof Error ? caught.message : String(caught)}`);
    }).finally(() => {
      if (!cancelled) setSessionReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [loadThumbnails, selectFrame, showToast]);

  useEffect(() => {
    if (!sessionReady) return;
    window.clearTimeout(sessionSaveTimerRef.current);
    sessionSaveTimerRef.current = window.setTimeout(() => {
      const sessionFrames = frames.flatMap((frame) => {
        const frameRecipe = recipes[frame.info.id];
        return frameRecipe === undefined
          ? []
          : [{ id: frame.info.id, recipe: frameRecipe, skipped: skipped.has(frame.info.id) }];
      });
      const savedActiveId = activeId !== null && sessionFrames.some((frame) => frame.id === activeId)
        ? activeId
        : undefined;
      void window.filmlab.saveSession({
        frames: sessionFrames,
        ...(savedActiveId === undefined ? {} : { activeId: savedActiveId }),
      }).catch((caught: unknown) => {
        setError(`无法自动保存本地会话：${caught instanceof Error ? caught.message : String(caught)}`);
      });
    }, 500);
    return () => window.clearTimeout(sessionSaveTimerRef.current);
  }, [activeId, frames, recipes, sessionReady, skipped]);

  const handleOpen = useCallback(async (openMode: RollOpenMode) => {
    try {
      const infos = await window.filmlab.openRoll(openMode);
      if (infos === null) return;
      if (infos.length === 0) {
        showToast("所选文件夹中没有支持的图像文件(TIFF/JPEG/PNG)。");
        return;
      }
      setFrames(infos.map((info) => ({ info, thumbnail: null, status: "idle" as const })));
      previewWorkerRef.current?.clear();
      previewCacheRef.current.clear();
      thumbnailRecipeKeysRef.current.clear();
      setSkipped(new Set());
      setSummary(null);
      setRollProgress(null);
      setRecipes(Object.fromEntries(infos.map((info) => [info.id, cloneRecipe(DEFAULT_RECIPE)])));
      loadThumbnails(infos);
      await selectFrame(infos[0]!.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [loadThumbnails, selectFrame, showToast]);

  const removeFrame = useCallback((id: string) => {
    void window.filmlab.releaseFrame(id).catch((caught: unknown) => {
      setError(`无法释放源文件记录：${caught instanceof Error ? caught.message : String(caught)}`);
    });
    previewWorkerRef.current?.release(id);
    previewCacheRef.current.delete(id);
    thumbnailRecipeKeysRef.current.delete(id);
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
    const canvas = imageCanvasRef.current!;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: Math.min(canvas.width, Math.max(0, (event.clientX - bounds.left) * canvas.width / bounds.width)),
      y: Math.min(canvas.height, Math.max(0, (event.clientY - bounds.top) * canvas.height / bounds.height)),
    };
  }, []);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode === "view") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStartRef.current = toImagePoint(event);
    if (mode === "straighten") {
      setDraft(null);
      draftLineRef.current = null;
      setDraftLine(null);
    } else {
      setDraftLine(null);
      draftLineRef.current = null;
    }
  }, [mode, toImagePoint]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragStartRef.current === null) return;
    const canvas = imageCanvasRef.current;
    if (canvas === null) return;
    const point = toImagePoint(event);
    const start = dragStartRef.current;
    if (mode === "straighten") {
      const line: StraightenLine = {
        start: { x: start.x / canvas.width, y: start.y / canvas.height },
        end: { x: point.x / canvas.width, y: point.y / canvas.height },
      };
      draftLineRef.current = line;
      setDraftLine(line);
      return;
    }
    setDraft({
      x: Math.min(start.x, point.x) / canvas.width,
      y: Math.min(start.y, point.y) / canvas.height,
      width: Math.abs(point.x - start.x) / canvas.width,
      height: Math.abs(point.y - start.y) / canvas.height,
    });
  }, [mode, toImagePoint]);

  const handlePointerUp = useCallback(() => {
    dragStartRef.current = null;
    if (mode === "straighten") {
      const line = draftLineRef.current;
      const canvas = imageCanvasRef.current;
      draftLineRef.current = null;
      setDraftLine(null);
      setMode("view");
      if (line === null || canvas === null || recipe === null) return;
      const start = { x: line.start.x * canvas.width, y: line.start.y * canvas.height };
      const end = { x: line.end.x * canvas.width, y: line.end.y * canvas.height };
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      if (length < Math.hypot(canvas.width, canvas.height) * 0.05) {
        showToast("水平参考线过短，请沿应为水平的边缘拖得更长一些。");
        return;
      }
      const correction = straightenAngle(start, end);
      update({
        rotate: normalizeRotation(recipe.rotate + correction),
        crop: undefined,
        baseRoi: undefined,
        neutralRoi: undefined,
        baseMode: "auto",
      });
      showToast("已校正水平；原裁剪、片基和中性选区已清除。");
      return;
    }
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
  }, [mode, recipe, showToast, update]);

  const baseLabel = result === null ? "—" : result.base.method === "roi" ? "ROI 选区" : "自动估算";
  const baseDetail = result === null ? "" : `${(result.base.confidence * 100).toFixed(0)}% 置信度`;
  const batchBusy = exporting !== null && rollProgress !== null;
  const diagnostics = [
    `FilmLab ${appInfo?.version ?? "unknown"}`,
    `Platform ${appInfo?.platform ?? "unknown"}/${appInfo?.arch ?? "unknown"}`,
    `Electron ${appInfo?.electron ?? "unknown"}`,
    `Preview worker ${workerFailed ? "fallback" : workerReady ? "ready" : "starting"}`,
    `Frames ${frames.length}; error ${error === null ? "no" : "yes"}`,
  ].join("\n");

  const copyDiagnostics = (): void => {
    void navigator.clipboard.writeText(diagnostics).then(
      () => showToast("诊断信息已复制；其中不包含文件路径或图像内容。"),
      () => showToast("无法访问剪贴板，请手动复制诊断信息。"),
    );
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand"><FilmCanisterIcon className="brand-icon" />FilmLab</span>
        <div className="toolbar-group import-group">
          <button className="btn primary" onClick={() => void handleOpen("files")} disabled={batchBusy || !sessionReady}>导入底片…</button>
          <button className="btn" onClick={() => void handleOpen("folder")} disabled={batchBusy || !sessionReady}>导入文件夹…</button>
        </div>
        <span className="topbar-sep" />
        {rollProgress !== null && (
          <span className="roll-progress">
            导出 {rollProgress.done}/{rollProgress.total} · {rollProgress.fileName}
            <button className="btn ghost" onClick={() => void window.filmlab.cancelRollExport()}>取消</button>
          </span>
        )}
        <div className="toolbar-group export-group">
          <span className="toolbar-label">导出当前</span>
          <button className="btn" disabled={activeId === null || exporting !== null} onClick={() => void handleExportSingle("tiff")}>
            {exporting === "tiff" && rollProgress === null ? "导出中…" : "TIFF"}
          </button>
          <button className="btn" disabled={activeId === null || exporting !== null} onClick={() => void handleExportSingle("jpeg")}>
            {exporting === "jpeg" && rollProgress === null ? "导出中…" : "JPEG"}
          </button>
        </div>
        {frames.length > 1 && (
          <div className="toolbar-group export-group">
            <span className="toolbar-label">导出整卷</span>
            <button className="btn" disabled={exporting !== null} onClick={() => void handleExportRoll("tiff")}>
              {batchBusy && exporting === "tiff" ? "导出中…" : "TIFF"}
            </button>
            <button className="btn" disabled={exporting !== null} onClick={() => void handleExportRoll("jpeg")}>
              {batchBusy && exporting === "jpeg" ? "导出中…" : "JPEG"}
            </button>
          </div>
        )}
        <button
          className="btn ghost"
          disabled={activeId === null}
          onClick={() => update({ ...DEFAULT_RECIPE, baseRoi: undefined })}
        >
          复位当前帧
        </button>
        <button className="btn ghost" onClick={() => setAboutOpen(true)}>关于</button>
      </header>

      <main className="layout">
        {frames.length > 1 && (
          <Filmstrip
            frames={frames}
            activeId={activeId}
            skipped={skipped}
            recipes={recipes}
            workerFailed={workerFailed}
            onSelect={(id) => void selectFrame(id)}
            onRemove={removeFrame}
            onToggleSkip={toggleSkip}
          />
        )}

        <div className="workspace">
          {preview === null ? (
            <div className="empty">
              <FilmCanisterIcon className="empty-icon" />
              <h1>负片 → 正像</h1>
              <p>选择一张或多张底片，自动检测片基、反转密度并还原正像。</p>
              <div className="empty-actions">
                <button className="btn primary large" disabled={!sessionReady} onClick={() => void handleOpen("files")}>
                  {sessionReady ? "导入底片…" : "正在恢复会话…"}
                </button>
                <button className="btn large" disabled={!sessionReady} onClick={() => void handleOpen("folder")}>导入文件夹…</button>
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
                    { value: "straighten", label: "水平校正" },
                    { value: "base-roi", label: "框选片基" },
                    { value: "neutral-roi", label: "框选中性高密度" },
                    { value: "crop", label: "框选裁剪" },
                  ]}
                />
                <span className="modebar-hint">
                  {mode === "view"
                    ? "选择一种工具后在画面上拖拽。"
                    : mode === "straighten"
                      ? "沿画面中应为水平的边缘拖一条参考线。"
                      : "在画面上拖拽出选区。"}
                </span>
              </div>
            </>
          )}
        </div>

        {recipe !== null && preview !== null && (
          <AdjustmentPanel
            recipe={recipe}
            mode={mode}
            frameCount={frames.length}
            baseLabel={baseLabel}
            baseDetail={baseDetail}
            update={update}
            setMode={setMode}
            applyRecipeToAll={applyRecipeToAll}
            showToast={showToast}
          />
        )}
      </main>

      {preview !== null && (
        <footer className="statusbar">
          <span>{preview.fileName} · {preview.width}×{preview.height} 预览 · {preview.depth} 位{preview.hasIcc ? " · 带 ICC" : " · 无 ICC"}</span>
          <span>会话已在本机自动保存</span>
          {result !== null && (
            <>
              <span>
                Dmin {result.anchors.dmin.toFixed(3)} · Dmax {result.anchors.dmax.toFixed(3)} · 范围 {result.anchors.range.toFixed(3)}
              </span>
              <span>
                去色罩 {result.anchors.neutralization === undefined
                  ? "无校正"
                  : `${NEUTRALIZATION_LABEL[result.anchors.neutralization.method]} · 改善 ${(result.anchors.neutralization.improvement * 100).toFixed(0)}%`}
                {result.anchors.channelFit === undefined
                  ? " · 斜率 —"
                  : ` · 斜率 ${result.anchors.channelFit.slope.map((value) => value.toFixed(3)).join("/")}`}
              </span>
              {result.autoGains !== undefined && (
                <span>自动白平衡 {result.autoGains.map((value) => value.toFixed(2)).join("/")}</span>
              )}
              {result.autoGains === undefined && (
                <span>手动色温 {recipe?.temperatureKelvin.toFixed(0)} K</span>
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

      {aboutOpen && (
        <AboutDialog info={appInfo} diagnostics={diagnostics} onCopy={copyDiagnostics} onClose={() => setAboutOpen(false)} />
      )}
    </div>
  );
}
