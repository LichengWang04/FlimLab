import {
  Aperture,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Crop,
  Download,
  FileImage,
  Film,
  FolderOpen,
  GripVertical,
  HelpCircle,
  Image,
  Layers,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pipette,
  Redo2,
  RefreshCw,
  RotateCcw,
  Ruler,
  Settings2,
  Sparkles,
  Trash2,
  Undo2,
  ZoomIn,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
} from "react";

import type {
  PreviewMode,
  PreviewResult,
  PreviewView,
  CalibrationProfileSummary,
  CalibrationProfileVersionSummary,
  ColorCardCaptureContext,
  BatchJobSummary,
  GpuPipelinePayload,
  MasterExportFormat,
  MasterTiffExportResult,
  ProcessingRecipe,
  ProjectLoadResult,
  ProjectSessionSummary,
  RecentProjectSummary,
  SourceAsset,
  ColorTrust,
  UpdateStatus,
} from "../../shared/contracts.ts";
import { defaultProcessingRecipe } from "../../shared/contracts.ts";
import {
  demoFrameId,
  type FilmRoll,
  type ProjectPreset,
  type ProjectRecipe,
  type WorkspaceProjectDraft,
} from "../../shared/project.ts";
import { estimateAlignmentFromRgba } from "./alignment.ts";
import { getFilmLabApi } from "./bridge.ts";
import { estimateFilmFrameCropFromRgba } from "./film-frame.ts";
import {
  createPreviewCanvasRenderer,
  type PreviewCanvasRenderer,
  type PreviewRenderBackend,
} from "./gpu-preview.ts";
import {
  computeGeometryLayout,
  fitPreviewIntoBounds,
  resolvePreviewDisplaySize,
  type PreviewDisplaySize,
} from "./preview-layout.ts";
import { renderGpuMasterInTiles, type GpuFilmFrame } from "./gpu-film-pipeline.ts";
import {
  createFramePrecomputePlan,
  createFramePrecomputePlanKey,
  createPrecomputeSettingsKey,
  type FramePrecomputePlanItem,
} from "./precompute-plan.ts";
import { ProjectSaveQueue } from "./project-save-queue.ts";
import { computeWaveform, drawWaveform, type WaveformFrame } from "./waveform.ts";
import {
  createNeutralFrameRecipe,
  resolveFrameRecipe,
  withFrameRecipe,
  withRollFrameRecipe,
  withoutFrameRecipe,
} from "./frame-recipes.ts";
import {
  previewPerformanceProfile,
  processingForInteractivePreview,
  straightenFromReferenceLine,
  type RulerPoint,
  type StraightenReferenceResult,
} from "./preview-interaction.ts";

type PreviewQuality = "quick" | "refining" | "settled";
type GeometryTask = "crop" | null;

const modeLabels: Record<PreviewMode, string> = {
  generic: "默认模式",
  calibrated: "色卡校准",
};

const viewLabels: Record<PreviewView, string> = {
  positive: "正像",
  transmission: "负片",
  density: "密度",
};

const masterExportChoices: readonly {
  readonly format: MasterExportFormat;
  readonly label: string;
  readonly detail: string;
}[] = [
  { format: "tiff", label: "TIFF", detail: "16-bit sRGB 编码 · 无损" },
  { format: "jpeg", label: "JPG", detail: "8-bit sRGB 编码 · 质量 95" },
  { format: "heif", label: "HEIF", detail: "10-bit sRGB 编码 · AVIF" },
  { format: "dng", label: "DNG", detail: "16-bit 线性 sRGB · 仅设备匹配" },
];

type ToneState = {
  exposureStops: number;
  contrast: number;
  highlightCompression: number;
  saturation: number;
};

type RecipeSnapshot = {
  readonly mode: PreviewMode;
  readonly view: PreviewView;
  readonly tone: ToneState;
  readonly calibrationProfileId?: string;
  readonly processing: ProcessingRecipe;
};

type RollDialogState =
  | { readonly kind: "create"; readonly initialTitle: string }
  | { readonly kind: "rename"; readonly rollId: string; readonly initialTitle: string }
  | { readonly kind: "delete"; readonly rollId: string; readonly rollTitle: string };

type FrameDeleteDialogState = {
  readonly frameId: string;
  readonly label: string;
  readonly isDemo: boolean;
};

type WorkspaceFrame =
  | { readonly id: typeof demoFrameId; readonly kind: "demo" }
  | { readonly id: string; readonly kind: "asset"; readonly asset: SourceAsset };

type CropHandle = "move" | "north" | "south" | "east" | "west" | "north-east" | "north-west" | "south-east" | "south-west";

type CropBounds = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

const initialFilmRoll: FilmRoll = {
  id: "default-roll",
  title: "未命名胶卷",
  assets: [],
  frameOrder: [],
};
const frameRecipeSyncDelayMs = 160;

export function App(): ReactNode {
  const api = getFilmLabApi();
  const [mode, setMode] = useState<PreviewMode>("generic");
  const [view, setView] = useState<PreviewView>("positive");
  const [tone, setTone] = useState<ToneState>({
    exposureStops: 0,
    contrast: 1,
    highlightCompression: 0,
    saturation: 1,
  });
  const [processing, setProcessing] = useState<ProcessingRecipe>(() => cloneDefaultProcessing());
  const [isCropEditing, setIsCropEditing] = useState(false);
  const [isBaseSampling, setIsBaseSampling] = useState(false);
  const [isDmaxSampling, setIsDmaxSampling] = useState(false);
  const [isDmaxApplying, setIsDmaxApplying] = useState(false);
  const [dmaxSampleRoi, setDmaxSampleRoi] = useState<ProcessingRecipe["baseRoi"]>({
    x: 0.4,
    y: 0.35,
    width: 0.2,
    height: 0.2,
  });
  const [isWhiteBalanceSampling, setIsWhiteBalanceSampling] = useState(false);
  const [isWhiteBalanceApplying, setIsWhiteBalanceApplying] = useState(false);
  const [isStraightenDrawing, setIsStraightenDrawing] = useState(false);
  const [isBaseEstimating, setIsBaseEstimating] = useState(false);
  const [geometryTask, setGeometryTask] = useState<GeometryTask>(null);
  const [previewRenderBackend, setPreviewRenderBackend] = useState<PreviewRenderBackend | "pending">("pending");
  const [previewFitRevision, setPreviewFitRevision] = useState(0);
  const [gpuToneCapability, setGpuToneCapability] = useState<"unknown" | "supported" | "unsupported">("unknown");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [thumbnailUrls, setThumbnailUrls] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [isRendering, setIsRendering] = useState(true);
  const [previewQuality, setPreviewQuality] = useState<PreviewQuality>("quick");
  const [rolls, setRolls] = useState<readonly FilmRoll[]>([initialFilmRoll]);
  const [activeRollId, setActiveRollId] = useState(initialFilmRoll.id);
  const [activeAssetId, setActiveAssetId] = useState<string | undefined>();
  const [linkedAssetIds, setLinkedAssetIds] = useState<ReadonlySet<string>>(() => new Set());
  const [calibrationProfiles, setCalibrationProfiles] = useState<readonly CalibrationProfileSummary[]>([]);
  const [calibrationProfileId, setCalibrationProfileId] = useState<string | undefined>();
  const [calibrationVersions, setCalibrationVersions] = useState<readonly CalibrationProfileVersionSummary[]>([]);
  const [colorCardAssetId, setColorCardAssetId] = useState<string | undefined>();
  const [calibrationCaptureContext, setCalibrationCaptureContext] = useState<Required<ColorCardCaptureContext>>({
    lens: "",
    filmStock: "",
    process: "",
    illuminationId: "",
  });
  const [projectPresets, setProjectPresets] = useState<readonly ProjectPreset[]>([]);
  const [projectStatus, setProjectStatus] = useState("正在恢复");
  const [projectLoaded, setProjectLoaded] = useState(false);
  const [projectSession, setProjectSession] = useState<ProjectSessionSummary | undefined>();
  const [recentProjects, setRecentProjects] = useState<readonly RecentProjectSummary[]>([]);
  const [isProjectMenuOpen, setIsProjectMenuOpen] = useState(false);
  const [isProjectSwitching, setIsProjectSwitching] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [masterExportFormat, setMasterExportFormat] = useState<MasterExportFormat>("tiff");
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [notice, setNotice] = useState("新胶卷已就绪，可导入 RAW 或 16-bit TIFF 帧。");
  const [undoStack, setUndoStack] = useState<readonly RecipeSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<readonly RecipeSnapshot[]>([]);
  const [batchJob, setBatchJob] = useState<BatchJobSummary | undefined>();
  const [rollMenuId, setRollMenuId] = useState<string | undefined>();
  const [rollDialog, setRollDialog] = useState<RollDialogState | null>(null);
  const [frameDeleteDialog, setFrameDeleteDialog] = useState<FrameDeleteDialogState | null>(null);
  const [isShortcutHelpOpen, setIsShortcutHelpOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({
    state: "idle",
    currentVersion: "—",
  });
  const [draggedFrameId, setDraggedFrameId] = useState<string | undefined>();
  const [dropTargetFrameId, setDropTargetFrameId] = useState<string | undefined>();
  const [librarySplit, setLibrarySplit] = useState(loadLibrarySplit);
  const [isResizingLibrary, setIsResizingLibrary] = useState(false);
  const revision = useRef(0);
  const previewGeneration = useRef(0);
  const precomputeGeneration = useRef(0);
  const precomputedPreviews = useRef(new Map<string, PreviewResult>());
  const precomputeInFlight = useRef(new Map<string, Promise<PreviewResult>>());
  const precomputePlanRef = useRef<readonly FramePrecomputePlanItem[]>([]);
  /** Full-resolution GPU source payloads, keyed by sourceKey, so repeated
   * master exports reuse the pixel arrays the renderer already holds
   * instead of re-cloning ~160 MB over IPC every time. Bounded LRU. */
  const gpuSourceCacheRef = useRef(new Map<string, GpuSourceCacheEntry>());
  const thumbnailUrlsRef = useRef(new Map<string, string>());
  const saveRevision = useRef(0);
  const projectSaveQueue = useRef(new ProjectSaveQueue());
  const projectAutosaveTimer = useRef<number | undefined>(undefined);
  const latestProjectDraftRef = useRef<WorkspaceProjectDraft | undefined>(undefined);
  const projectSessionRef = useRef<ProjectSessionSummary | undefined>(undefined);
  const whiteBalanceSampleGeneration = useRef(0);
  const activeSelectionRef = useRef<{ readonly rollId: string; readonly assetId?: string }>({
    rollId: initialFilmRoll.id,
  });
  const rollMenuRef = useRef<HTMLDivElement | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const projectMenuRef = useRef<HTMLDivElement | null>(null);
  const librarySectionsRef = useRef<HTMLDivElement | null>(null);
  const activeRoll = rolls.find((roll) => roll.id === activeRollId) ?? rolls[0] ?? initialFilmRoll;
  projectSessionRef.current = projectSession;
  activeSelectionRef.current = { rollId: activeRollId, assetId: activeAssetId };
  const assets = activeRoll.assets;
  const frames = useMemo(() => resolveFrames(activeRoll), [activeRoll]);
  const projectTitle = activeRoll.title;
  const latestProjectDraft = useMemo<WorkspaceProjectDraft>(() => {
    const recipe: ProjectRecipe = {
      mode,
      view,
      tone: { ...tone },
      calibrationProfileId,
      processing: cloneProcessing(processing),
    };
    return {
      rolls: activeAssetId === undefined
        ? rolls
        : withRollFrameRecipe(rolls, activeRollId, activeAssetId, recipe),
      activeRollId,
      recipe,
      presets: projectPresets,
    };
  }, [activeAssetId, activeRollId, calibrationProfileId, mode, processing, projectPresets, rolls, tone, view]);
  latestProjectDraftRef.current = latestProjectDraft;
  const activeAssetNeedsRelink = activeAssetId !== undefined
    && activeAssetId !== demoFrameId
    && !linkedAssetIds.has(activeAssetId);
  const currentMasterExportLabel = masterExportChoices.find((choice) => choice.format === masterExportFormat)?.label ?? "TIFF";
  const activeColorTrust = resolveActiveColorTrust(mode, preview);
  const dngBlockedReason = mode !== "calibrated" || calibrationProfileId === undefined
    ? "DNG 色彩母版需要先选择校准配置"
    : activeColorTrust.reason === "camera-mismatch"
      || activeColorTrust.reason === "source-camera-unavailable"
      || activeColorTrust.reason === "profile-camera-unavailable"
      ? "DNG 色彩母版需要源文件相机与校准配置匹配"
      : undefined;
  const exportPrerequisiteBlockedReason = isExporting
    ? "正在导出图像"
    : preview === null
      ? isRendering ? "正在生成预览，完成后即可导出" : "请先选择一张照片并生成预览"
      : activeAssetNeedsRelink
        ? "当前帧的源文件尚未连接，请先使用“重连源文件”"
        : undefined;
  const exportBlockedReason = exportPrerequisiteBlockedReason
    ?? (masterExportFormat === "dng" && activeAssetId !== demoFrameId ? dngBlockedReason : undefined);
  const previewNeedsRelink = activeAssetNeedsRelink;
  const previewProcessing = useMemo(
    () => processingForInteractivePreview(processing, isCropEditing),
    [processing, isCropEditing],
  );
  // Tracks how many times each asset's source file was relinked. Precompute
  // cache keys do not carry the decode generation, so an in-flight decode
  // that was started before a relink must not write its stale pixels back
  // into the neighbour cache.
  const assetEpochRef = useRef(new Map<string, number>());
  const previewDisplaySize = useMemo(
    () => preview === null
      ? null
      : resolvePreviewDisplaySize(preview, previewProcessing.geometry),
    [preview, previewProcessing],
  );
  const waveform = useMemo<WaveformFrame | null>(() => {
    if (preview === null || preview.rgba.byteLength === 0) return null;
    return computeWaveform(preview.rgba, preview.width, preview.height);
  }, [preview]);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveformRef = useRef<WaveformFrame | null>(null);
  waveformRef.current = waveform;
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (canvas === null) return;
    // The inspector section can be collapsed/expanded and the window resized;
    // redraw whenever the canvas element size changes so the waveform stays
    // sharp instead of stretching a stale bitmap.
    const redraw = (): void => drawWaveform(canvas, waveformRef.current);
    redraw();
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (canvas === null) return;
    drawWaveform(canvas, waveform);
  }, [waveform]);
  const fullGpuPreviewActive = previewRenderBackend === "webgl2-pipeline"
    && preview?.gpuPipeline !== undefined;
  const previewRequestKey = JSON.stringify({
    activeAssetId,
    previewNeedsRelink,
    mode,
    // Once the source texture is resident, view, tone, geometry and restoration
    // are shader uniforms/passes. Keeping them out of the worker key avoids
    // cloning the full Float32 source back over IPC for every control change.
    view: fullGpuPreviewActive ? null : view,
    tone: fullGpuPreviewActive || (view === "positive" && gpuToneCapability !== "unsupported")
      ? null
      : tone,
    calibrationProfileId,
    dmaxOverride: activeRoll.manualDmax?.value ?? null,
    dmaxChannelRange: activeRoll.manualDmax?.channelRange ?? null,
    processing: fullGpuPreviewActive
      ? {
          baseRoi: previewProcessing.baseRoi,
          filmBase: previewProcessing.filmBase,
          // The GPU film transform is supplied by the worker payload rather
          // than reconstructed from live renderer uniforms.
          channelGains: previewProcessing.channelGains ?? [1, 1, 1],
          autoNeutralDmax: previewProcessing.autoNeutralDmax ?? false,
          preSaturation: previewProcessing.preSaturation ?? 1.08,
        }
      : previewProcessing,
    // Relinking an already-linked asset does not change its renderer-safe ID.
    // Include the session-only epoch so the current preview is re-decoded.
    sourceEpoch: activeAssetId === undefined
      ? 0
      : (assetEpochRef.current.get(activeAssetId) ?? 0),
  });
  const precomputeSettingsKey = createPrecomputeSettingsKey(
    mode,
    calibrationProfileId,
    previewProcessing,
    activeRoll.manualDmax?.value,
    activeRoll.manualDmax?.channelRange,
  );
  const precomputePlan = useMemo(
    () => createFramePrecomputePlan(activeRoll, activeAssetId, linkedAssetIds),
    [activeAssetId, activeRoll, linkedAssetIds],
  );
  precomputePlanRef.current = precomputePlan;
  const precomputeQueueKey = useMemo(
    () => createFramePrecomputePlanKey(precomputePlan),
    [precomputePlan],
  );
  const isGeometryAnalyzing = geometryTask !== null;
  const handlePreviewRenderBackendChange = useCallback((
    backend: PreviewRenderBackend,
    hasLinearScene: boolean,
  ): void => {
    setPreviewRenderBackend(backend);
    if (hasLinearScene) {
      setGpuToneCapability(
        backend === "webgl2-pipeline" || backend === "webgl2-linear"
          ? "supported"
          : "unsupported",
      );
    }
  }, []);
  const storePrecomputedPreview = useCallback((
    assetId: string,
    settingsKey: string,
    result: PreviewResult,
  ): void => {
    const cache = precomputedPreviews.current;
    const key = assetId + "|" + settingsKey;
    const compactResult = result.sceneLinear === undefined
      ? result
      : { ...result, sceneLinear: undefined };
    cache.delete(key);
    cache.set(key, compactResult);
    // A 1280px GPU source plus fallback is roughly 16 MiB. Keep the renderer
    // cache bounded while retaining enough neighbouring frames for fluid film
    // strip navigation.
    while (cache.size > 12) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }, []);
  const publishThumbnail = useCallback(async (
    frameId: string,
    result: PreviewResult,
  ): Promise<void> => {
    if (thumbnailUrlsRef.current.has(frameId)) return;
    let url: string;
    try {
      url = createThumbnailDataUrl(result);
    } catch (error: unknown) {
      document.documentElement.dataset.thumbnailStatus = error instanceof Error
        ? "error:" + error.message
        : "error";
      return;
    }
    if (thumbnailUrlsRef.current.has(frameId)) {
      return;
    }
    thumbnailUrlsRef.current.set(frameId, url);
    setThumbnailUrls(new Map(thumbnailUrlsRef.current));
    document.documentElement.dataset.thumbnailStatus = "ready:" + frameId;
  }, []);

  const applyLoadedProject = useCallback((loaded: ProjectLoadResult): void => {
    const project = loaded.project;
    const restoredRoll = project.rolls.find((roll) => roll.id === project.activeRollId) ?? project.rolls[0];
    const restoredFrameId = restoredRoll?.frameOrder[0];
    const restoredRecipe = restoredRoll === undefined
      ? project.recipe
      : resolveFrameRecipe(restoredRoll, restoredFrameId, project.recipe);
    precomputedPreviews.current.clear();
    precomputeInFlight.current.clear();
    thumbnailUrlsRef.current.clear();
    for (const asset of project.rolls.flatMap((roll) => roll.assets)) {
      assetEpochRef.current.set(asset.id, (assetEpochRef.current.get(asset.id) ?? 0) + 1);
    }
    setThumbnailUrls(new Map());
    setPreview(null);
    setRolls(project.rolls);
    setActiveRollId(project.activeRollId);
    setLinkedAssetIds(new Set(loaded.relinkedAssetIds));
    setActiveAssetId(restoredFrameId);
    setMode(restoredRecipe.mode);
    setView(restoredRecipe.view);
    setTone({ ...restoredRecipe.tone });
    setCalibrationProfileId(restoredRecipe.calibrationProfileId);
    setProcessing(cloneProcessing(restoredRecipe.processing));
    setProjectPresets(project.presets);
    setProjectSession(loaded.session);
    setRecentProjects(loaded.recentProjects);
    setUndoStack([]);
    setRedoStack([]);
    setProjectStatus(loaded.session.pendingAction === "migration"
      ? "等待迁移确认"
      : loaded.session.pendingAction === "recovery"
        ? "等待恢复确认"
        : loaded.session.readOnly ? "只读" : "已保存");
    setNotice(loaded.session.pendingAction === "migration"
      ? `项目来自 schema v${loaded.session.migratedFromVersion ?? "旧版"}，已只读打开；确认迁移后才会写入 v8。`
      : loaded.session.pendingAction === "recovery"
        ? "主项目文件已损坏，当前已从最近有效备份只读恢复；确认恢复后才会覆盖主文件。"
        : loaded.session.readOnly
          ? "项目已只读打开；可以编辑预览，但必须使用“另存为”才能持久化。"
          : loaded.missingAssets.length > 0
            ? "项目已打开；仍有 " + loaded.missingAssets.length + " 个源文件需要扫描目录重连。"
            : "项目已打开 · " + loaded.session.name
              + (loaded.restoredCalibrationProfileIds.length === 0
                ? ""
                : ` · 已恢复 ${loaded.restoredCalibrationProfileIds.length} 个校准快照`));
    setProjectLoaded(true);
    setIsProjectMenuOpen(false);
  }, []);

  useEffect(() => {
    let active = true;
    void api
      .loadProject()
      .then((loaded) => {
        if (active) applyLoadedProject(loaded);
      })
      .catch((error: unknown) => {
        if (active) {
          setProjectStatus("无法恢复");
          setNotice(error instanceof Error ? error.message : "项目无法恢复");
        }
      });

    return () => {
      active = false;
    };
  }, [api, applyLoadedProject]);

  useEffect(() => {
    if (!projectLoaded || activeAssetId === undefined) return;
    const nextRecipe: ProjectRecipe = {
      mode,
      view,
      tone: { ...tone },
      calibrationProfileId,
      processing: cloneProcessing(processing),
    };
    const timer = window.setTimeout(() => {
      setRolls((current) => withRollFrameRecipe(
        current,
        activeRollId,
        activeAssetId,
        nextRecipe,
      ));
    }, frameRecipeSyncDelayMs);
    return () => window.clearTimeout(timer);
  }, [
    activeAssetId,
    activeRollId,
    calibrationProfileId,
    mode,
    processing,
    projectLoaded,
    tone,
    view,
  ]);

  useEffect(() => {
    if (rollMenuId === undefined) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!rollMenuRef.current?.contains(event.target as Node)) {
        setRollMenuId(undefined);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setRollMenuId(undefined);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [rollMenuId]);

  useEffect(() => {
    if (!isExportMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!exportMenuRef.current?.contains(event.target as Node)) setIsExportMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setIsExportMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isExportMenuOpen]);

  useEffect(() => {
    if (!isProjectMenuOpen) return;
    const close = (event: PointerEvent): void => {
      if (!projectMenuRef.current?.contains(event.target as Node)) setIsProjectMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setIsProjectMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isProjectMenuOpen]);

  useEffect(() => {
    whiteBalanceSampleGeneration.current += 1;
    setIsCropEditing(false);
    setIsBaseSampling(false);
    setIsDmaxSampling(false);
    setIsDmaxApplying(false);
    setIsWhiteBalanceSampling(false);
    setIsWhiteBalanceApplying(false);
    setIsStraightenDrawing(false);
    setUndoStack([]);
    setRedoStack([]);
  }, [activeAssetId, activeRollId]);

  useEffect(() => {
    if (!isCropEditing && !isBaseSampling && !isDmaxSampling && !isWhiteBalanceSampling && !isStraightenDrawing) return;
    const finishOnKeyboard = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (isStraightenDrawing && event.key === "Escape") {
        setIsStraightenDrawing(false);
        setNotice("已取消直尺拉直。角度保持不变。");
        return;
      }
      if (isWhiteBalanceSampling && event.key === "Escape") {
        setIsWhiteBalanceSampling(false);
        setNotice("已取消片基白平衡取样，当前白平衡保持不变。");
        return;
      }
      if (isDmaxSampling && event.key === "Escape") {
        setIsDmaxSampling(false);
        setNotice("已取消手动 Dmax 取样，当前整卷设置不变。");
        return;
      }
      if (event.key === "Enter" && isWhiteBalanceSampling) {
        void finishWhiteBalanceSampling();
        return;
      }
      if (event.key === "Enter" && isDmaxSampling) {
        void finishDmaxSampling();
        return;
      }
      if (event.key === "Enter" || event.key === "Escape") {
        setIsCropEditing(false);
        setIsBaseSampling(false);
        setIsDmaxSampling(false);
        setNotice(isBaseSampling
          ? "未曝光片基已从裁切画面取样；Dmin/Dmax 已重新计算。"
          : "裁切已应用到预览与母版导出。");
      }
    };
    document.addEventListener("keydown", finishOnKeyboard);
    return () => document.removeEventListener("keydown", finishOnKeyboard);
  }, [isBaseSampling, isCropEditing, isDmaxSampling, isStraightenDrawing, isWhiteBalanceSampling]);

  useEffect(() => {
    try {
      window.localStorage.setItem("filmlab.librarySplit", String(librarySplit));
    } catch {
      // The layout remains usable when storage is unavailable.
    }
  }, [librarySplit]);

  useEffect(() => {
    if (!isResizingLibrary) return;
    const resize = (event: PointerEvent): void => {
      const container = librarySectionsRef.current;
      if (container === null) return;
      const bounds = container.getBoundingClientRect();
      const percentage = ((event.clientY - bounds.top) / Math.max(1, bounds.height)) * 100;
      setLibrarySplit(clamp(percentage, 20, 72));
    };
    const finish = (): void => setIsResizingLibrary(false);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish, { once: true });
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finish);
    };
  }, [isResizingLibrary]);

  useEffect(() => {
    let active = true;
    void api.listCalibrationProfiles()
      .then((profiles) => {
        if (active) {
          setCalibrationProfiles(profiles);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setNotice(error instanceof Error ? error.message : "无法读取本机标定配置");
        }
      });
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    let active = true;
    const unsubscribe = api.onUpdateStatus((status) => {
      if (active) setUpdateStatus(status);
    });
    void api.getUpdateStatus()
      .then((status) => {
        if (active) setUpdateStatus(status);
      })
      .catch((error: unknown) => {
        if (active) setNotice(error instanceof Error ? error.message : "无法读取更新状态");
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  useEffect(() => {
    if (!projectLoaded || projectSession === undefined || projectSession.readOnly) return;
    const nextSaveRevision = saveRevision.current + 1;
    saveRevision.current = nextSaveRevision;
    if (projectAutosaveTimer.current !== undefined) window.clearTimeout(projectAutosaveTimer.current);
    projectAutosaveTimer.current = window.setTimeout(() => {
      projectAutosaveTimer.current = undefined;
      setProjectStatus("保存中");
      void projectSaveQueue.current
        .enqueue(() => api.saveProject(projectSession.id, latestProjectDraft))
        .then((result) => {
          // Only replace the session object when the backup count actually
          // changed. The effect below depends on the session identity, so an
          // unconditional spread here would retrigger a save after every
          // successful save and loop indefinitely.
          setProjectSession((current) => current?.id === projectSession.id && current.backupCount !== result.backupCount
            ? { ...current, backupCount: result.backupCount }
            : current);
          if (saveRevision.current === nextSaveRevision) {
            setProjectStatus("已保存");
          }
        })
        .catch((error: unknown) => {
          if (saveRevision.current === nextSaveRevision) {
            setProjectStatus("保存失败");
            setNotice(error instanceof Error ? error.message : "项目无法保存");
          }
        });
    }, 550);

    return () => {
      if (projectAutosaveTimer.current !== undefined) {
        window.clearTimeout(projectAutosaveTimer.current);
        projectAutosaveTimer.current = undefined;
      }
    };
    // Depend on the session's primitive identity fields rather than the
    // session object: save completion swaps the object (backupCount), which
    // would otherwise reschedule this effect and turn autosave into a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, latestProjectDraft, projectLoaded, projectSession?.id, projectSession?.readOnly]);

  const flushProject = useCallback(async (): Promise<void> => {
    if (projectAutosaveTimer.current !== undefined) {
      window.clearTimeout(projectAutosaveTimer.current);
      projectAutosaveTimer.current = undefined;
    }
    await projectSaveQueue.current.flush();
    const session = projectSessionRef.current;
    const draft = latestProjectDraftRef.current;
    if (
      session === undefined
      || draft === undefined
      || session.readOnly
      || session.pendingAction !== undefined
    ) return;
    const result = await projectSaveQueue.current.enqueue(() => api.saveProject(session.id, draft));
    setProjectSession((current) => current?.id === session.id
      ? { ...current, backupCount: result.backupCount }
      : current);
  }, [api]);

  useEffect(() => api.onRequestClose(() => {
    void flushProject()
      .catch((error: unknown) => {
        console.error("FilmLab final project save failed", error);
      })
      .finally(() => api.confirmClose());
  }), [api, flushProject]);

  useEffect(() => {
    const generation = previewGeneration.current + 1;
    previewGeneration.current = generation;
    if (activeAssetId === undefined || previewNeedsRelink) {
      setPreview(null);
      setIsRendering(false);
      setPreviewQuality("quick");
      return;
    }
    const assetId = activeAssetId;
    const useGpuInteractive = gpuToneCapability !== "unsupported";
    const previewCacheKey = assetId + "|" + precomputeSettingsKey;
    const cached = precomputedPreviews.current.get(previewCacheKey);
    setIsRendering(true);
    if (cached !== undefined) {
      setPreview(cached);
      setPreviewQuality(
        useGpuInteractive && cached.gpuPipeline !== undefined
          ? "settled"
          : "quick",
      );
      if (useGpuInteractive && cached.gpuPipeline !== undefined) {
        // The background result already contains the settled decoder-linear
        // source and all shader metadata. Re-decoding it in the foreground
        // would only duplicate RAW unpacking and texture upload.
        setIsRendering(false);
        void publishThumbnail(assetId, cached);
        setNotice("已载入预计算 GPU 预览 · 切换无需重新解码");
        return;
      }
    } else {
      setPreviewQuality("quick");
    }
    let refineTimer: number | undefined;
    let stopped = false;

    const renderAt = async (maxEdge: number, quality: "quick" | "settled"): Promise<void> => {
      const nextRevision = revision.current + 1;
      revision.current = nextRevision;
      const requestStartedAt = performance.now();
      try {
        const result = await api.renderPreview({
          revision: nextRevision,
          assetId,
          maxEdge,
          mode,
          view,
          tone,
          calibrationProfileId,
          processing: previewProcessing,
          dmaxOverride: activeRoll.manualDmax?.value,
          dmaxChannelRange: activeRoll.manualDmax?.channelRange,
          gpuInteractive: useGpuInteractive,
          gpuReuseSourceKey: useGpuInteractive
            ? preview?.gpuPipeline?.sourceKey
            : undefined,
        });
        if (stopped || generation !== previewGeneration.current) return;
        const totalElapsedMs = Math.round(performance.now() - requestStartedAt);
        if (quality === "quick") {
          storePrecomputedPreview(assetId, precomputeSettingsKey, result);
        }
        void publishThumbnail(assetId, result);
        setPreview(result);
        // Bayer previews carry the full-resolution source; keep a bounded
        // copy so master exports can skip re-sending it over IPC.
        if (result.gpuPipeline?.sourceBayer !== undefined) {
          storeGpuSourcePayload(gpuSourceCacheRef.current, result.gpuPipeline);
        }
        setPreviewQuality(quality);
        setIsRendering(false);
        const baseSampleTotal = result.base.sampleCount + result.base.rejectedCount;
        setNotice(baseSampleTotal > 0 && result.base.rejectedCount / baseSampleTotal >= 0.25
          ? "片基采样区不够均匀，请重新选择纯净、未曝光的片基区域。"
          : quality === "quick"
            ? "快速预览已更新 · 总耗时 " + totalElapsedMs + " ms · 处理 " + result.elapsedMs + " ms；停止操作后自动细化。"
            : "高质量预览已更新 · 总耗时 " + totalElapsedMs + " ms · "
              + (useGpuInteractive ? "GPU 准备 " : "CPU 处理 ")
              + result.elapsedMs + " ms");
        if (quality === "quick") {
          refineTimer = window.setTimeout(() => {
            if (stopped || generation !== previewGeneration.current) return;
            setPreviewQuality("refining");
            setIsRendering(true);
            void renderAt(previewPerformanceProfile.settledMaxEdge, "settled");
          }, previewPerformanceProfile.refineDelayMs);
        }
      } catch (error: unknown) {
        if (stopped || generation !== previewGeneration.current) return;
        setIsRendering(false);
        setNotice(error instanceof Error ? error.message : "预览计算失败");
      }
    };

    const quickTimer = window.setTimeout(() => {
      void (async () => {
        // A neighbour may already be decoding in the low-priority worker.
        // Adopt that exact Promise instead of starting a second 61 MP decode
        // in the foreground utility process.
        const pendingWarmup = precomputeInFlight.current.get(previewCacheKey);
        let prepared = precomputedPreviews.current.get(previewCacheKey);
        if (prepared === undefined && pendingWarmup !== undefined) {
          setNotice("正在完成已启动的后台预计算 · 窗口仍可继续操作");
          try {
            prepared = await pendingWarmup;
          } catch {
            // Fall through to the foreground renderer only after the
            // background request has failed, never while it is still active.
          }
        }
        if (stopped || generation !== previewGeneration.current) return;
        if (prepared !== undefined) {
          storePrecomputedPreview(assetId, precomputeSettingsKey, prepared);
          void publishThumbnail(assetId, prepared);
          setPreview(prepared);
          if (useGpuInteractive && prepared.gpuPipeline !== undefined) {
            setPreviewQuality("settled");
            setIsRendering(false);
            setNotice("已接管后台预计算 GPU 预览 · 未重复解码");
            return;
          }
          setPreviewQuality("quick");
        }
        if (useGpuInteractive) {
          // RAW unpacking dominates the first frame. Request the settled source
          // once and let the GPU draw it immediately instead of decoding and
          // uploading separate quick and settled rasters.
          void renderAt(previewPerformanceProfile.settledMaxEdge, "settled");
          return;
        }
        void renderAt(
          prepared === undefined
            ? previewPerformanceProfile.quickMaxEdge
            : previewPerformanceProfile.settledMaxEdge,
          prepared === undefined ? "quick" : "settled",
        );
      })();
    }, cached === undefined ? previewPerformanceProfile.inputDebounceMs : 80);

    return () => {
      stopped = true;
      window.clearTimeout(quickTimer);
      if (refineTimer !== undefined) window.clearTimeout(refineTimer);
    };
  }, [
    api,
    precomputeSettingsKey,
    previewRequestKey,
    publishThumbnail,
    storePrecomputedPreview,
  ]);

  useEffect(() => {
    const generation = precomputeGeneration.current + 1;
    precomputeGeneration.current = generation;
    if (
      !projectLoaded
      || isRendering
      || isGeometryAnalyzing
      || isExporting
      || previewQuality !== "settled"
    ) return;
    let stopped = false;
    const eligible = precomputePlanRef.current;

    const run = async (): Promise<void> => {
      for (const item of eligible) {
        if (stopped || generation !== precomputeGeneration.current) return;
        const frameRecipe = item.recipe;
        const framePreviewProcessing = processingForInteractivePreview(frameRecipe.processing, false);
        const frameSettingsKey = item.settingsKey;
        const cacheKey = item.frameId + "|" + frameSettingsKey;
        const existing = precomputedPreviews.current.get(cacheKey);
        if (existing !== undefined) {
          await publishThumbnail(item.frameId, existing);
          continue;
        }
        await waitForBackgroundTurn();
        if (stopped || generation !== precomputeGeneration.current) return;
        let pending = precomputeInFlight.current.get(cacheKey);
        if (pending === undefined) {
          const nextRevision = revision.current + 1;
          revision.current = nextRevision;
          pending = api.precomputePreview({
            revision: nextRevision,
            assetId: item.frameId,
            maxEdge: previewPerformanceProfile.prewarmMaxEdge,
            mode: frameRecipe.mode,
            view: frameRecipe.view,
            tone: frameRecipe.tone,
            calibrationProfileId: frameRecipe.calibrationProfileId,
            processing: framePreviewProcessing,
            dmaxOverride: item.dmaxOverride,
            dmaxChannelRange: item.dmaxChannelRange,
            gpuInteractive: true,
          });
          precomputeInFlight.current.set(cacheKey, pending);
        }
        const frameEpoch = assetEpochRef.current.get(item.frameId) ?? 0;
        try {
          const result = await pending;
          if (precomputeInFlight.current.get(cacheKey) === pending) {
            precomputeInFlight.current.delete(cacheKey);
          }
          // A relink while this decode was in flight means its pixels belong
          // to the previous source file. The cache key cannot tell them
          // apart, so drop the stale result instead of poisoning the cache.
          if ((assetEpochRef.current.get(item.frameId) ?? 0) !== frameEpoch) {
            continue;
          }
          // Cache a completed warm-up even when the active frame changed while
          // it was running. The immutable cache key still proves compatibility.
          storePrecomputedPreview(item.frameId, frameSettingsKey, result);
          if (stopped || generation !== precomputeGeneration.current) return;
          await publishThumbnail(item.frameId, result);
        } catch {
          if (precomputeInFlight.current.get(cacheKey) === pending) {
            precomputeInFlight.current.delete(cacheKey);
          }
          // A missing/relinked source or a superseded background request must
          // never interrupt the active preview or surface as a blocking notice.
        }
      }
    };
    void run();
    return () => {
      stopped = true;
    };
  }, [
    api,
    isExporting,
    isGeometryAnalyzing,
    isRendering,
    precomputeQueueKey,
    projectLoaded,
    publishThumbnail,
    storePrecomputedPreview,
    previewQuality,
  ]);

  useEffect(() => {
    if (batchJob === undefined || ["completed", "cancelled", "failed"].includes(batchJob.state)) {
      return;
    }
    const timer = window.setInterval(() => {
      void api.getBatchJob(batchJob.id).then((next) => {
        if (next !== undefined) setBatchJob(next);
      }).catch((error: unknown) => setNotice(error instanceof Error ? error.message : "无法读取批处理状态"));
    }, 450);
    return () => window.clearInterval(timer);
  }, [api, batchJob]);

  useEffect(() => {
    if (calibrationProfileId === undefined) {
      setCalibrationVersions([]);
      return;
    }
    let cancelled = false;
    void api.listCalibrationProfileVersions(calibrationProfileId).then((versions) => {
      if (!cancelled) setCalibrationVersions(versions);
    }).catch((error: unknown) => {
      if (!cancelled) setNotice(error instanceof Error ? error.message : "无法读取标定配置版本");
    });
    return () => { cancelled = true; };
  }, [api, calibrationProfileId, calibrationProfiles]);

  const updateRollTitle = (rollId: string, title: string): void => {
    setRolls((current) => current.map((roll) => roll.id === rollId ? { ...roll, title } : roll));
  };

  const stageFramePreview = (frameId: string | undefined, settingsKey: string): void => {
    if (frameId === undefined) {
      setPreview(null);
      setIsRendering(false);
      return;
    }
    const key = frameId + "|" + settingsKey;
    const cached = precomputedPreviews.current.get(key);
    if (cached !== undefined) {
      precomputedPreviews.current.delete(key);
      precomputedPreviews.current.set(key, cached);
    }
    setPreview(cached ?? null);
    setPreviewQuality("quick");
    setIsRendering(true);
  };

  const invalidateFrameCaches = (frameIds: readonly string[]): void => {
    const ids = new Set(frameIds);
    for (const key of precomputedPreviews.current.keys()) {
      if (ids.has(key.slice(0, key.indexOf("|")))) precomputedPreviews.current.delete(key);
    }
    let thumbnailsChanged = false;
    for (const frameId of ids) {
      const url = thumbnailUrlsRef.current.get(frameId);
      if (url === undefined) continue;
      thumbnailUrlsRef.current.delete(frameId);
      thumbnailsChanged = true;
    }
    if (thumbnailsChanged) setThumbnailUrls(new Map(thumbnailUrlsRef.current));
  };

  const persistActiveFrameRecipe = (): void => {
    if (activeAssetId === undefined) return;
    const snapshot = cloneProjectRecipe(captureRecipe());
    setRolls((current) => withRollFrameRecipe(
      current,
      activeRollId,
      activeAssetId,
      snapshot,
    ));
  };

  const selectRoll = (roll: FilmRoll): void => {
    setRollMenuId(undefined);
    if (roll.id === activeRollId) return;
    persistActiveFrameRecipe();
    const targetFrameId = roll.frameOrder[0];
    const targetRecipe = resolveFrameRecipe(roll, targetFrameId);
    applyRecipe(targetRecipe);
    const rollSettingsKey = createPrecomputeSettingsKey(
      targetRecipe.mode,
      targetRecipe.calibrationProfileId,
      targetRecipe.processing,
      roll.manualDmax?.value,
      roll.manualDmax?.channelRange,
    );
    stageFramePreview(targetFrameId, rollSettingsKey);
    setActiveRollId(roll.id);
    setActiveAssetId(targetFrameId);
    setColorCardAssetId(undefined);
    setNotice("已切换到胶卷 · " + roll.title + (roll.uniformRecipe === undefined ? "" : " · 已套用整卷统一反转"));
  };

  const selectFrame = (frameId: string): void => {
    if (frameId === activeAssetId) return;
    persistActiveFrameRecipe();
    const targetRecipe = resolveFrameRecipe(activeRoll, frameId);
    applyRecipe(targetRecipe);
    const frameSettingsKey = createPrecomputeSettingsKey(
      targetRecipe.mode,
      targetRecipe.calibrationProfileId,
      targetRecipe.processing,
      activeRoll.manualDmax?.value,
      activeRoll.manualDmax?.channelRange,
    );
    stageFramePreview(frameId, frameSettingsKey);
    setActiveAssetId(frameId);
    if (frameId !== demoFrameId && !linkedAssetIds.has(frameId)) {
      setNotice("该帧尚未连接本地源文件，请使用“重连源文件”。");
    } else if (activeRoll.uniformRecipe !== undefined) {
      setNotice("已套用整卷统一反转 · 来源 " + describeFrame(activeRoll, activeRoll.uniformRecipe.sourceFrameId));
    }
  };

  const createRoll = (title: string): void => {
    persistActiveFrameRecipe();
    const roll: FilmRoll = {
      id: crypto.randomUUID(),
      title: title.trim(),
      assets: [],
      frameOrder: [],
    };
    setRolls((current) => [...current, roll]);
    applyRecipe(createNeutralFrameRecipe());
    setActiveRollId(roll.id);
    setActiveAssetId(undefined);
    setColorCardAssetId(undefined);
    setRollDialog(null);
    setNotice("已新建胶卷 · " + roll.title + "，可继续导入帧。");
  };

  const duplicateRoll = (rollId: string): void => {
    const source = rolls.find((roll) => roll.id === rollId);
    if (source === undefined) return;
    persistActiveFrameRecipe();
    const sourceRecipes = { ...source.recipesByFrameId };
    if (source.id === activeRollId && activeAssetId !== undefined && source.uniformRecipe === undefined) {
      sourceRecipes[activeAssetId] = cloneProjectRecipe(captureRecipe());
    }
    const duplicate: FilmRoll = {
      id: crypto.randomUUID(),
      title: createUniqueRollTitle(source.title + " 副本", rolls),
      assets: [...source.assets],
      frameOrder: [...source.frameOrder],
      recipesByFrameId: Object.keys(sourceRecipes).length === 0
        ? undefined
        : Object.fromEntries(Object.entries(sourceRecipes).map(([frameId, recipe]) => [
            frameId,
            cloneProjectRecipe(recipe),
          ])),
      uniformRecipe: source.uniformRecipe === undefined
        ? undefined
        : {
            sourceFrameId: source.uniformRecipe.sourceFrameId,
            recipe: cloneProjectRecipe(source.uniformRecipe.recipe),
          },
      manualDmax: source.manualDmax === undefined
        ? undefined
        : { ...source.manualDmax },
    };
    setRolls((current) => {
      const index = current.findIndex((roll) => roll.id === rollId);
      return [...current.slice(0, index + 1), duplicate, ...current.slice(index + 1)];
    });
    applyRecipe(resolveFrameRecipe(duplicate, duplicate.frameOrder[0]));
    setActiveRollId(duplicate.id);
    setActiveAssetId(duplicate.frameOrder[0]);
    setColorCardAssetId(undefined);
    setRollMenuId(undefined);
    setNotice("已复制胶卷 · " + duplicate.title);
  };

  const deleteRoll = (rollId: string): void => {
    if (rolls.length <= 1) return;
    const index = rolls.findIndex((roll) => roll.id === rollId);
    const removed = rolls[index];
    if (index < 0 || removed === undefined) return;
    const nextRoll = rolls[index + 1] ?? rolls[index - 1];
    setRolls((current) => current.filter((roll) => roll.id !== rollId));
    if (activeRollId === rollId && nextRoll !== undefined) {
      applyRecipe(resolveFrameRecipe(nextRoll, nextRoll.frameOrder[0]));
      setActiveRollId(nextRoll.id);
      setActiveAssetId(nextRoll.frameOrder[0]);
      setColorCardAssetId(undefined);
    }
    setRollDialog(null);
    setRollMenuId(undefined);
    setNotice("已删除胶卷 · " + removed.title);
  };

  const confirmRollDialog = (title: string): void => {
    if (rollDialog === null) return;
    if (rollDialog.kind === "create") {
      createRoll(title);
    } else if (rollDialog.kind === "rename") {
      updateRollTitle(rollDialog.rollId, title.trim());
      setRollDialog(null);
      setNotice("胶卷已重命名 · " + title.trim());
    } else {
      deleteRoll(rollDialog.rollId);
    }
  };

  const deleteFrame = (frameId: string): void => {
    const frameIndex = activeRoll.frameOrder.indexOf(frameId);
    if (frameIndex < 0) return;
    const nextOrder = activeRoll.frameOrder.filter((id) => id !== frameId);
    setRolls((current) => current.map((roll) => {
      if (roll.id !== activeRollId) return roll;
      const withoutRecipe = withoutFrameRecipe(roll, frameId);
      return {
          ...withoutRecipe,
          assets: frameId === demoFrameId ? roll.assets : roll.assets.filter((asset) => asset.id !== frameId),
          frameOrder: roll.frameOrder.filter((id) => id !== frameId),
          uniformRecipe: roll.uniformRecipe?.sourceFrameId === frameId ? undefined : roll.uniformRecipe,
          manualDmax: roll.manualDmax?.sourceFrameId === frameId ? undefined : roll.manualDmax,
        };
    }));
    if (activeAssetId === frameId) {
      const nextFrameId = nextOrder[Math.min(frameIndex, nextOrder.length - 1)];
      const nextRoll = withoutFrameRecipe(activeRoll, frameId);
      applyRecipe(resolveFrameRecipe(
        { ...nextRoll, frameOrder: nextOrder },
        nextFrameId,
      ));
      setActiveAssetId(nextFrameId);
    }
    invalidateFrameCaches([frameId]);
    if (colorCardAssetId === frameId) setColorCardAssetId(undefined);
    setFrameDeleteDialog(null);
    setNotice(frameId === demoFrameId ? "演示负片已从当前胶卷删除。" : "帧已从胶卷移除；磁盘源文件未删除。");
  };

  const reorderFrame = (sourceId: string, targetId: string): void => {
    if (sourceId === targetId) return;
    setRolls((current) => current.map((roll) => {
      if (roll.id !== activeRollId) return roll;
      const sourceIndex = roll.frameOrder.indexOf(sourceId);
      const targetIndex = roll.frameOrder.indexOf(targetId);
      if (sourceIndex < 0 || targetIndex < 0) return roll;
      const order = [...roll.frameOrder];
      const [moved] = order.splice(sourceIndex, 1);
      if (moved === undefined) return roll;
      order.splice(targetIndex, 0, moved);
      return { ...roll, frameOrder: order };
    }));
  };

  const startFrameDrag = (event: ReactDragEvent<HTMLElement>, frameId: string): void => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", frameId);
    setDraggedFrameId(frameId);
  };

  const moveFrameOver = (event: ReactDragEvent<HTMLElement>, frameId: string): void => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTargetFrameId(frameId);
  };

  const dropFrame = (event: ReactDragEvent<HTMLElement>, targetId: string): void => {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData("text/plain") || draggedFrameId;
    if (sourceId !== undefined && sourceId !== targetId) {
      reorderFrame(sourceId, targetId);
      setNotice("帧顺序已更新并将自动保存。");
    }
    setDraggedFrameId(undefined);
    setDropTargetFrameId(undefined);
  };

  const finishFrameDrag = (): void => {
    setDraggedFrameId(undefined);
    setDropTargetFrameId(undefined);
  };

  const importSources = async (): Promise<void> => {
    try {
      setNotice("选择源文件后将计算完整内容指纹，用于下次启动时自动重新连接。");
      const selected = await api.selectSourceFiles();
      if (selected.length === 0) {
        return;
      }
      persistActiveFrameRecipe();
      setRolls((current) => current.map((roll) => {
        if (roll.id !== activeRollId) return roll;
        const existingIds = new Set(roll.assets.map((asset) => asset.id));
        const additions = selected.filter((asset) => !existingIds.has(asset.id));
        const recipesByFrameId = { ...roll.recipesByFrameId };
        for (const asset of additions) {
          recipesByFrameId[asset.id] = createNeutralFrameRecipe();
        }
        return {
          ...roll,
          assets: [...roll.assets, ...additions],
          frameOrder: [...roll.frameOrder, ...additions.map((asset) => asset.id)],
          recipesByFrameId,
        };
      }));
      const selectedRecipe = activeRoll.frameOrder.includes(selected[0].id)
        ? resolveFrameRecipe(activeRoll, selected[0].id)
        : createNeutralFrameRecipe();
      applyRecipe(selectedRecipe);
      setPreview(null);
      setPreviewQuality("quick");
      setIsRendering(true);
      setActiveAssetId(selected[0].id);
      setLinkedAssetIds((current) => new Set([...current, ...selected.map((asset) => asset.id)]));
      setNotice("已登记 " + selected.length + " 个源文件，正在由独立图像进程解码。");
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : "无法导入源文件");
    }
  };

  function captureRecipe(): RecipeSnapshot {
    return {
      mode,
      view,
      tone: { ...tone },
      calibrationProfileId,
      processing: cloneProcessing(processing),
    };
  }

  function applyRecipe(recipe: RecipeSnapshot): void {
    setMode(recipe.mode);
    setView(recipe.view);
    setTone({ ...recipe.tone });
    setCalibrationProfileId(recipe.calibrationProfileId);
    setProcessing(cloneProcessing(recipe.processing));
  }

  const applyCurrentRecipeToRoll = (): void => {
    if (activeAssetId === undefined || !activeRoll.frameOrder.includes(activeAssetId)) {
      setNotice("请先选择一帧作为整卷反转来源。");
      return;
    }
    const uniformRecipe = {
      sourceFrameId: activeAssetId,
      recipe: cloneProjectRecipe(captureRecipe()),
    };
    setRolls((current) => current.map((roll) => roll.id === activeRollId
      ? { ...roll, uniformRecipe }
      : roll));
    setRollMenuId(undefined);
    setNotice(
      "已将 "
      + describeFrame(activeRoll, activeAssetId)
      + " 的反转配方套用到整卷 "
      + activeRoll.frameOrder.length
      + " 帧。",
    );
  };

  const clearRollUniformRecipe = (): void => {
    if (activeRoll.uniformRecipe === undefined) return;
    const currentRecipe = cloneProjectRecipe(captureRecipe());
    setRolls((current) => current.map((roll) => {
      if (roll.id !== activeRollId) return roll;
      const { uniformRecipe: _removed, ...rest } = roll;
      return activeAssetId === undefined
        ? rest
        : {
            ...rest,
            recipesByFrameId: {
              ...rest.recipesByFrameId,
              [activeAssetId]: currentRecipe,
            },
          };
    }));
    setRollMenuId(undefined);
    setNotice("已取消整卷统一反转；当前画面配方保持不变。");
  };

  const recordRecipeChange = (): void => {
    const snapshot = captureRecipe();
    setUndoStack((current) => [...current, snapshot].slice(-80));
    setRedoStack([]);
  };

  const undoRecipe = (): void => {
    const previous = undoStack.at(-1);
    if (previous === undefined) return;
    const current = captureRecipe();
    setUndoStack((stack) => stack.slice(0, -1));
    setRedoStack((stack) => [current, ...stack].slice(0, 80));
    applyRecipe(previous);
  };

  const redoRecipe = (): void => {
    const next = redoStack[0];
    if (next === undefined) return;
    const current = captureRecipe();
    setRedoStack((stack) => stack.slice(1));
    setUndoStack((stack) => [...stack, current].slice(-80));
    applyRecipe(next);
  };

  const changeMode = (nextMode: PreviewMode): void => {
    if (nextMode === mode) return;
    recordRecipeChange();
    setMode(nextMode);
  };

  const changeView = (nextView: PreviewView): void => {
    if (nextView === view) return;
    recordRecipeChange();
    setView(nextView);
  };

  const updateProcessing = (update: (current: ProcessingRecipe) => ProcessingRecipe): void => {
    recordRecipeChange();
    setProcessing((current) => update(current));
  };

  const beginStraightenDrawing = (): void => {
    if (preview === null) {
      setNotice("预览就绪后才能使用直尺拉直。");
      return;
    }
    setIsCropEditing(false);
    setIsBaseSampling(false);
    setIsDmaxSampling(false);
    setIsWhiteBalanceSampling(false);
    setIsStraightenDrawing(true);
    setNotice("沿画面中应当水平或垂直的边缘拖出参考线；松开后将自动拉直，Esc 可取消。");
  };

  const cancelStraightenDrawing = (): void => {
    setIsStraightenDrawing(false);
    setNotice("已取消直尺拉直。角度保持不变。");
  };

  const commitStraightenReference = (result: StraightenReferenceResult): void => {
    setIsStraightenDrawing(false);
    if (Math.abs(result.correctionDegrees) < 0.01) {
      setNotice("参考线已经与" + (result.axis === "horizontal" ? "水平" : "垂直") + "方向平行，无需旋转。");
      return;
    }
    recordRecipeChange();
    const straighten = Math.round(result.straightenDegrees * 100) / 100;
    setProcessing((current) => ({
      ...current,
      geometry: { ...current.geometry, straighten },
    }));
    setNotice(
      "已按" + (result.axis === "horizontal" ? "水平" : "垂直") + "参考线拉直 "
      + Math.abs(result.correctionDegrees).toFixed(2) + "°"
      + (result.clamped ? "；校正已限制在 ±15° 安全范围内。" : "。"),
    );
  };

  const beginCropEditing = (): void => {
    if (processing.geometry.crop === undefined) {
      updateProcessing((current) => ({
        ...current,
        geometry: { ...current.geometry, crop: { x: 0.04, y: 0.04, width: 0.92, height: 0.92 } },
      }));
    }
    setIsStraightenDrawing(false);
    setIsBaseSampling(false);
    setIsDmaxSampling(false);
    setIsWhiteBalanceSampling(false);
    setIsCropEditing(true);
    setNotice("拖动裁切框或八个手柄调整构图，完成后按 Enter 或点击“完成”。");
  };

  const finishCropEditing = (): void => {
    setIsCropEditing(false);
    setNotice("裁切已应用到预览与母版导出。");
  };

  const beginBaseSampling = (): void => {
    if (preview === null) {
      setNotice("预览就绪后才能选择未曝光片基。");
      return;
    }
    if (processing.filmBase !== undefined) {
      recordRecipeChange();
      setProcessing((current) => {
        const { filmBase: _removed, ...rest } = current;
        return rest;
      });
    }
    setIsCropEditing(false);
    setIsStraightenDrawing(false);
    setIsWhiteBalanceSampling(false);
    setIsDmaxSampling(false);
    setIsBaseSampling(true);
    setNotice("请在裁切后的画面中拖出一块均匀、未曝光的片基；按 Enter 或 Esc 完成。");
  };

  const finishBaseSampling = (): void => {
    setIsBaseSampling(false);
    setNotice("未曝光片基已从裁切画面取样；Dmin/Dmax 已重新计算。");
  };

  const beginDmaxSampling = (): void => {
    if (preview === null || activeAssetId === undefined || previewNeedsRelink) {
      setNotice("预览就绪并连接源文件后，才能取样 Dmax。");
      return;
    }
    setIsCropEditing(false);
    setIsBaseSampling(false);
    setIsWhiteBalanceSampling(false);
    setIsStraightenDrawing(false);
    setDmaxSampleRoi({ x: 0.4, y: 0.35, width: 0.2, height: 0.2 });
    setIsDmaxSampling(true);
    setNotice("请在负片画面中拖出一块包含最高密度细节的区域；按 Enter 或双击完成，结果将应用到整卷。");
  };

  async function finishDmaxSampling(): Promise<void> {
    if (activeAssetId === undefined || previewNeedsRelink || isDmaxApplying) {
      setIsDmaxSampling(false);
      return;
    }
    const owner = { rollId: activeRollId, assetId: activeAssetId };
    const sampleRevision = revision.current + 1;
    revision.current = sampleRevision;
    const sampleRoi = { ...dmaxSampleRoi };
    setIsDmaxSampling(false);
    setIsDmaxApplying(true);
    setNotice("正在从取样区域计算 Dmax，并准备整卷应用…");
    try {
      const result = await api.renderPreview({
        revision: sampleRevision,
        assetId: owner.assetId,
        maxEdge: previewPerformanceProfile.analysisMaxEdge,
        mode,
        view: "density",
        tone,
        calibrationProfileId,
        processing: previewProcessing,
        dmaxSampleRoi: sampleRoi,
      });
      const currentOwner = activeSelectionRef.current;
      if (
        currentOwner.rollId !== owner.rollId
        || currentOwner.assetId !== owner.assetId
        || result.revision !== sampleRevision
      ) return;
      if (!Number.isFinite(result.density.dmax) || result.density.dmax <= result.density.dmin + 0.01) {
        throw new Error("Dmax 取样区域密度范围过小，请选择更暗的负片细节。");
      }
      // The calibrated path keeps its absolute density domain and ignores
      // per-channel Dmax ranges, so only standard mode locks them in.
      const lockedChannelRange = mode === "generic" ? result.density.channelRange : undefined;
      const manualDmax = {
        value: result.density.dmax,
        sourceFrameId: owner.assetId,
        ...(lockedChannelRange === undefined ? {} : { channelRange: lockedChannelRange }),
      };
      setRolls((current) => current.map((roll) => roll.id === owner.rollId
        ? { ...roll, manualDmax }
        : roll));
      setNotice(
        "手动 Dmax 已启用并应用到整卷 · "
        + result.density.dmax.toFixed(3)
        + " D · 来源 "
        + describeFrame(activeRoll, owner.assetId)
        + (lockedChannelRange === undefined ? "" : " · 已同时锁定 RGB 密度锚点"),
      );
    } catch (error: unknown) {
      if (activeSelectionRef.current.rollId === owner.rollId && activeSelectionRef.current.assetId === owner.assetId) {
        setNotice(error instanceof Error ? error.message : "Dmax 取样失败");
      }
    } finally {
      setIsDmaxApplying(false);
    }
  }

  const clearManualDmax = (): void => {
    if (activeRoll.manualDmax === undefined) return;
    setRolls((current) => current.map((roll) => {
      if (roll.id !== activeRollId) return roll;
      const { manualDmax: _removed, ...rest } = roll;
      return rest;
    }));
    setIsDmaxSampling(false);
    setNotice("已恢复自动 Dmax；当前胶卷各帧将重新按自身画面估算。");
  };

  const beginWhiteBalanceSampling = (): void => {
    if (preview === null || activeAssetId === undefined || previewNeedsRelink) {
      setNotice("预览就绪后才能吸取片基白平衡。");
      return;
    }
    whiteBalanceSampleGeneration.current += 1;
    setIsCropEditing(false);
    setIsBaseSampling(false);
    setIsStraightenDrawing(false);
    setIsDmaxSampling(false);
    setIsWhiteBalanceSampling(true);
    setNotice("请框选均匀、未曝光的片基。取样会在线性透射数据中完成，不受当前曝光、对比度或饱和度影响。");
  };

  async function finishWhiteBalanceSampling(): Promise<void> {
    if (activeAssetId === undefined || previewNeedsRelink || isWhiteBalanceApplying) {
      setIsWhiteBalanceSampling(false);
      return;
    }
    const generation = whiteBalanceSampleGeneration.current + 1;
    whiteBalanceSampleGeneration.current = generation;
    const owner = { rollId: activeRollId, assetId: activeAssetId };
    const previousRecipe = captureRecipe();
    const sampleProcessing = cloneProcessing(processing);
    const { filmBase: _previousFilmBase, ...processingWithoutReference } = sampleProcessing;
    const sampleRevision = revision.current + 1;
    revision.current = sampleRevision;
    setIsWhiteBalanceSampling(false);
    setIsWhiteBalanceApplying(true);
    setNotice("正在从线性透射数据计算片基白平衡…");
    try {
      const result = await api.renderPreview({
        revision: sampleRevision,
        assetId: owner.assetId,
        maxEdge: previewPerformanceProfile.quickMaxEdge,
        mode,
        view: "transmission",
        tone,
        calibrationProfileId,
        processing: processingWithoutReference,
      });
      const currentOwner = activeSelectionRef.current;
      if (
        whiteBalanceSampleGeneration.current !== generation
        || currentOwner.rollId !== owner.rollId
        || currentOwner.assetId !== owner.assetId
        || result.revision !== sampleRevision
      ) {
        return;
      }
      setUndoStack((current) => [...current, previousRecipe].slice(-80));
      setRedoStack([]);
      setProcessing((current) => ({
        ...current,
        baseRoi: { ...sampleProcessing.baseRoi },
        filmBase: {
          kind: "reference",
          rgb: [...result.base.rgb] as [number, number, number],
          origin: "sampled",
          confidence: result.base.confidence,
          sourceFrameId: owner.assetId,
        },
      }));
      setNotice(
        "片基白平衡已应用 · RGB "
        + result.base.rgb.map((value) => value.toFixed(3)).join(" / ")
        + " · 置信度 "
        + Math.round(result.base.confidence * 100)
        + "%",
      );
    } catch (error: unknown) {
      if (whiteBalanceSampleGeneration.current === generation) {
        setNotice(error instanceof Error ? error.message : "片基白平衡取样失败。");
      }
    } finally {
      if (whiteBalanceSampleGeneration.current === generation) {
        setIsWhiteBalanceApplying(false);
      }
    }
  }

  const freezeCurrentFilmBase = (): void => {
    if (preview === null || activeAssetId === undefined || preview.base.method !== "roi") {
      setNotice("请先在含未曝光边缘的画面中完成片基 ROI 取样。");
      return;
    }
    recordRecipeChange();
    setProcessing((current) => ({
      ...current,
      filmBase: {
        kind: "reference",
        rgb: [...preview.base.rgb] as [number, number, number],
        origin: "sampled",
        confidence: preview.base.confidence,
        sourceFrameId: activeAssetId,
      },
    }));
    setIsBaseSampling(false);
    setNotice("当前实测片基已锁定；可切换到无边框帧，或将配方套用至整卷。");
  };

  const estimateBorderlessFilmBase = async (): Promise<void> => {
    if (activeAssetId === undefined || previewNeedsRelink || isBaseEstimating) {
      setNotice("当前帧尚未建立可用于片基估算的线性预览。");
      return;
    }
    const owner = { rollId: activeRollId, assetId: activeAssetId };
    setIsBaseEstimating(true);
    setIsBaseSampling(false);
    setIsDmaxSampling(false);
    setIsWhiteBalanceSampling(false);
    setNotice("正在从裁切画面的高透射上包络估算片基；该结果不能替代同卷实测 Dmin…");
    try {
      const estimateRevision = revision.current + 1;
      revision.current = estimateRevision;
      const result = await api.renderPreview({
        revision: estimateRevision,
        assetId: activeAssetId,
        maxEdge: previewPerformanceProfile.settledMaxEdge,
        mode,
        view: "transmission",
        tone,
        calibrationProfileId,
        processing: { ...cloneProcessing(processing), filmBase: { kind: "automatic" } },
      });
      if (result.base.method !== "automatic") {
        throw new Error("图像进程没有返回自动片基估算结果。");
      }
      const currentOwner = activeSelectionRef.current;
      if (
        currentOwner.rollId !== owner.rollId
        || currentOwner.assetId !== owner.assetId
        || result.revision !== estimateRevision
      ) return;
      recordRecipeChange();
      setProcessing((current) => ({
        ...current,
        filmBase: {
          kind: "reference",
          rgb: [...result.base.rgb] as [number, number, number],
          origin: "estimated",
          confidence: result.base.confidence,
          sourceFrameId: owner.assetId,
        },
      }));
      setNotice(
        "无边框片基估算已冻结 · 置信度 "
        + Math.round(result.base.confidence * 100)
        + "% · 建议用同卷未曝光片基替换并复核颜色。",
      );
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : "无边框片基估算失败。");
    } finally {
      setIsBaseEstimating(false);
    }
  };

  const clearFilmBaseReference = (): void => {
    if (processing.filmBase === undefined) return;
    recordRecipeChange();
    setProcessing((current) => {
      const { filmBase: _removed, ...rest } = current;
      return rest;
    });
    setNotice("已恢复画内 ROI 片基采样；请确保裁切画面仍包含未曝光胶片边缘。");
  };

  const renderGeometryAnalysisPreview = async (recipe: ProcessingRecipe): Promise<PreviewResult> => {
    if (activeAssetId === undefined || previewNeedsRelink) {
      throw new Error("当前帧尚未建立可分析的预览。");
    }
    const nextRevision = revision.current + 1;
    revision.current = nextRevision;
    const result = await api.renderPreview({
      revision: nextRevision,
      assetId: activeAssetId,
      maxEdge: previewPerformanceProfile.analysisMaxEdge,
      mode,
      view: "transmission",
      tone,
      calibrationProfileId,
      processing: {
        ...recipe,
        geometry: { ...recipe.geometry, crop: undefined },
      },
    });
    // The owner/generation guard runs in the caller; here we additionally
    // reject a stale echo so crop/straighten flows never apply analysis
    // computed for an older request revision.
    if (result.revision !== nextRevision) {
      throw new Error("几何分析预览已过期，请重试。");
    }
    return result;
  };

  const autoCrop = async (): Promise<void> => {
    if (preview === null) {
      setNotice("预览就绪后才能自动裁切。");
      return;
    }
    const owner = { rollId: activeRollId, assetId: activeAssetId };
    setIsStraightenDrawing(false);
    setGeometryTask("crop");
    setNotice("正在识别成像区域与片基边缘…");
    try {
      const uncropped: ProcessingRecipe = {
        ...processing,
        geometry: { ...processing.geometry, crop: undefined },
      };
      let analysis = await renderGeometryAnalysisPreview(uncropped);
      const alignment = estimateAlignmentFromRgba(analysis.rgba, analysis.width, analysis.height);
      const currentAngle = uncropped.geometry.straighten ?? 0;
      const alignedAngle = alignment.confidence >= 0.14 && Math.abs(alignment.correctionDegrees) >= 0.06
        ? Math.round(clamp(currentAngle + alignment.correctionDegrees, -15, 15) * 100) / 100
        : currentAngle;
      const aligned: ProcessingRecipe = {
        ...uncropped,
        geometry: { ...uncropped.geometry, straighten: alignedAngle },
      };
      if (alignedAngle !== currentAngle) {
        analysis = await renderGeometryAnalysisPreview(aligned);
      }
      const currentOwner = activeSelectionRef.current;
      if (currentOwner.rollId !== owner.rollId || currentOwner.assetId !== owner.assetId) return;
      const estimate = estimateFilmFrameCropFromRgba(analysis.rgba, analysis.width, analysis.height);
      if (estimate.confidence < 0.22) {
        setNotice("自动裁切未找到完整、稳定的四边片框；请先手动靠近边缘后再试。");
        return;
      }
      recordRecipeChange();
      setProcessing({
        ...aligned,
        geometry: { ...aligned.geometry, crop: estimate.crop },
      });
      setIsBaseSampling(false);
      setIsWhiteBalanceSampling(false);
      setIsCropEditing(true);
      setNotice("已按成像区内边界自动裁切 · 置信度 " + Math.round(estimate.confidence * 100) + "%");
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : "自动裁切分析失败。");
    } finally {
      setGeometryTask(null);
    }
  };

  const relinkSources = async (): Promise<void> => {
    try {
      const result = await api.relinkProjectSources(assets);
      if (result.relinkedAssets.length > 0) {
        const replacements = new Map(result.relinkedAssets.map((asset) => [asset.id, asset]));
        setRolls((current) => current.map((roll) => ({
          ...roll,
          assets: roll.assets.map((asset) => replacements.get(asset.id) ?? asset),
        })));
      }
      invalidateFrameCaches(result.relinkedAssetIds);
      for (const assetId of result.relinkedAssetIds) {
        assetEpochRef.current.set(assetId, (assetEpochRef.current.get(assetId) ?? 0) + 1);
      }
      if (activeAssetId !== undefined && result.relinkedAssetIds.includes(activeAssetId)) {
        setPreview(null);
        setPreviewQuality("quick");
        setIsRendering(true);
      }
      setLinkedAssetIds((current) => new Set([...current, ...result.relinkedAssetIds]));
      setNotice(result.missingAssets.length === 0
        ? "已按来源身份重新连接 " + result.relinkedAssetIds.length + " 个项目源文件"
        : "已按来源身份重新连接 " + result.relinkedAssetIds.length + " 个源文件；仍缺少 " + result.missingAssets.length + " 个");
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : "无法重新连接项目源文件");
    }
  };

  const startBatch = async (): Promise<void> => {
    const assetIds = frames.flatMap((frame) => frame.kind === "asset" ? [frame.asset.id] : []);
    if (assetIds.length === 0) {
      setNotice("请先导入至少一个 RAW 或 16-bit TIFF 源文件");
      return;
    }
    const missingCount = assetIds.filter((assetId) => !linkedAssetIds.has(assetId)).length;
    if (missingCount > 0) {
      setNotice("批处理前请先重新连接 " + missingCount + " 个源文件。");
      return;
    }
    try {
      const batchItems = assetIds.map((assetId) => {
        const recipe = activeRoll.uniformRecipe?.recipe
          ?? (assetId === activeAssetId ? captureRecipe() : resolveFrameRecipe(activeRoll, assetId));
        return {
          assetId,
          mode: recipe.mode,
          tone: { ...recipe.tone },
          calibrationProfileId: recipe.calibrationProfileId,
          processing: cloneProcessing(recipe.processing),
          dmaxOverride: activeRoll.manualDmax?.value,
          dmaxChannelRange: activeRoll.manualDmax?.channelRange,
        };
      });
      if (masterExportFormat === "dng" && batchItems.some((item) => item.mode !== "calibrated" || item.calibrationProfileId === undefined)) {
        setNotice("DNG 批处理要求每一帧都使用校准配置；请先统一整卷配方。");
        return;
      }
      const job = await api.startBatchExport({ format: masterExportFormat, items: batchItems });
      if (job !== undefined) {
        setBatchJob(job);
        setNotice(describeMasterExportFormat(job.format) + " 批处理已加入队列 · 0/" + job.total);
      }
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : "无法启动批处理");
    }
  };

  const exportPreview = async (): Promise<void> => {
    if (preview === null || activeAssetId === undefined || isExporting) return;
    setIsExporting(true);
    try {
      const nextRevision = revision.current + 1;
      revision.current = nextRevision;
      const exportFrame = await api.renderPreview({
        revision: nextRevision,
        assetId: activeAssetId,
        maxEdge: previewPerformanceProfile.settledMaxEdge,
        mode,
        view,
        tone,
        calibrationProfileId,
        processing,
        dmaxOverride: activeRoll.manualDmax?.value,
        dmaxChannelRange: activeRoll.manualDmax?.channelRange,
      });
      const png = await encodePreviewPng(exportFrame);
      const result = await api.exportPreviewPng({ suggestedFileName: projectTitle + "-preview.png", png });
      setNotice(result.saved ? "已导出 PNG 预览 · " + (result.fileName ?? "已保存") : "已取消导出");
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : "无法导出预览");
    } finally {
      setIsExporting(false);
    }
  };

  const exportMasterTiff = async (format: MasterExportFormat = masterExportFormat): Promise<void> => {
    if (activeAssetId === undefined || activeAssetId === demoFrameId || !linkedAssetIds.has(activeAssetId) || isExporting) return;
    if (format === "dng" && dngBlockedReason !== undefined) {
      setNotice(dngBlockedReason);
      return;
    }
    setIsExportMenuOpen(false);
    setMasterExportFormat(format);
    setIsExporting(true);
    let gpuSessionId: string | undefined;
    try {
      const source = assets.find((asset) => asset.id === activeAssetId);
      const request = {
        assetId: activeAssetId,
        suggestedFileName: makeMasterFileName(projectTitle, source?.name, format),
        format,
        mode,
        tone,
        calibrationProfileId,
        processing,
        dmaxOverride: activeRoll.manualDmax?.value,
        dmaxChannelRange: activeRoll.manualDmax?.channelRange,
      } as const;
      setNotice("正在准备全分辨率 GPU 母版…");
      let result: MasterTiffExportResult;
      try {
        revision.current += 1;
        const cachedSourceKey = preview?.gpuPipeline?.sourceKey;
        const sourceFrame = await api.renderPreview({
          revision: revision.current,
          assetId: activeAssetId,
          maxEdge: 32_768,
          mode,
          view: "positive",
          tone,
          calibrationProfileId,
          processing,
          dmaxOverride: activeRoll.manualDmax?.value,
          dmaxChannelRange: activeRoll.manualDmax?.channelRange,
          gpuInteractive: true,
          gpuSourceOnly: true,
          // Skip the multi-hundred-megabyte source re-clone when the
          // renderer already holds this exact payload from an earlier
          // preview or export; the worker still refreshes the analysis
          // metadata at full resolution.
          gpuReuseSourceKey: cachedSourceKey !== undefined && gpuSourceCacheRef.current.has(cachedSourceKey)
            ? cachedSourceKey
            : undefined,
        });
        if (sourceFrame.gpuPipeline === undefined || sourceFrame.displayWhitePoint === undefined) {
          throw new Error("GPU 母版源数据不可用。");
        }
        storeGpuSourcePayload(gpuSourceCacheRef.current, sourceFrame.gpuPipeline);
        const sourcePipeline = spliceGpuSourcePayload(gpuSourceCacheRef.current, sourceFrame.gpuPipeline);
        if (sourcePipeline.sourceBayer === undefined && sourcePipeline.sourceLinear === undefined) {
          throw new Error("GPU 母版源数据不可用。");
        }
        const layout = computeGeometryLayout(
          sourcePipeline.sourceWidth,
          sourcePipeline.sourceHeight,
          processing.geometry,
        );
        const rowsPerStrip = 256;
        const begin = await api.beginGpuMasterTiff({
          ...request,
          width: layout.outputWidth,
          height: layout.outputHeight,
          rowsPerStrip,
          processingMetadata: { demosaic: "edge-aware-bayer-v2", gpuBackend: "WebGL2" },
        });
        if (!begin.saved || begin.sessionId === undefined) {
          setNotice("已取消导出");
          return;
        }
        gpuSessionId = begin.sessionId;
        const gpuFrame: GpuFilmFrame = {
          pipeline: sourcePipeline,
          processing,
          mode,
          view: "positive",
          tone,
          displayWhitePoint: sourceFrame.displayWhitePoint,
        };
        await renderGpuMasterInTiles(gpuFrame, {
          tileHeight: rowsPerStrip,
          collectPixels: false,
          transfer: format === "dng" ? "linear" : "srgb",
          onProgress: (completed, total) => setNotice("GPU 母版处理中 · " + Math.round(completed / total * 100) + "%"),
          onTile: (tile) => api.appendGpuMasterTiffStrip({
            sessionId: begin.sessionId!,
            outputY: tile.outputY,
            width: tile.width,
            height: tile.height,
            rgb16: tile.rgb16,
          }),
        });
        result = await api.finishGpuMasterTiff(begin.sessionId);
        gpuSessionId = undefined;
      } catch (gpuError: unknown) {
        if (gpuSessionId !== undefined) {
          setNotice("GPU 母版不可用，正在使用同一路径进行 CPU 确定性回退…");
          result = await api.fallbackGpuMasterTiff(gpuSessionId);
          gpuSessionId = undefined;
        } else {
          setNotice("GPU 母版不可用，正在切换到 CPU 确定性输出…");
          result = await api.exportMasterTiff(request);
        }
        console.warn("[FilmLab] GPU master fell back to CPU", gpuError);
      }
      setNotice(result.saved
        ? "已导出 " + describeMasterExportFormat(format) + " · " + describeColorTrust(result.colorTrust ?? activeColorTrust) + " · " + (result.fileName ?? "已保存")
        : "已取消导出");
    } catch (error: unknown) {
      if (gpuSessionId !== undefined) await api.cancelGpuMasterTiff(gpuSessionId).catch(() => undefined);
      setNotice(error instanceof Error ? error.message : "无法导出图像");
    } finally {
      setIsExporting(false);
    }
  };

  const savePreset = (): void => {
    const label = window.prompt("预设名称", "自定胶片配方")?.trim();
    if (label === undefined || label.length === 0) return;
    const recipe = captureRecipe();
    const preset: ProjectPreset = { id: crypto.randomUUID(), label: label.slice(0, 80), recipe };
    setProjectPresets((current) => [preset, ...current.filter((item) => item.label !== preset.label)].slice(0, 100));
    setNotice("已保存项目预设 · " + preset.label);
  };

  const applyPreset = (id: string): void => {
    const preset = projectPresets.find((item) => item.id === id);
    if (preset === undefined) return;
    recordRecipeChange();
    applyRecipe(preset.recipe);
    setNotice("已应用项目预设 · " + preset.label);
  };

  const importCalibrationProfile = async (): Promise<void> => {
    try {
      const profile = await api.importCalibrationProfile();
      if (profile === undefined) {
        return;
      }
      setCalibrationProfiles((current) => [
        profile,
        ...current.filter((item) => item.id !== profile.id),
      ]);
      recordRecipeChange();
      setCalibrationProfileId(profile.id);
      setMode("calibrated");
      setNotice("已导入色卡标定配置 · " + profile.label);
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : "无法导入色卡标定配置");
    }
  };

  const exportCalibrationProfile = async (): Promise<void> => {
    if (calibrationProfileId === undefined) return;
    try {
      const result = await api.exportCalibrationProfile(calibrationProfileId);
      setNotice(result.saved ? "已导出标定配置 · " + (result.fileName ?? "已保存") : "已取消导出标定配置");
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : "无法导出标定配置");
    }
  };

  const deleteCalibrationProfile = async (): Promise<void> => {
    if (calibrationProfileId === undefined) return;
    const profile = calibrationProfiles.find((item) => item.id === calibrationProfileId);
    if (!window.confirm("删除标定配置“" + (profile?.label ?? calibrationProfileId) + "”及其所有历史版本？项目内已保存的快照不会被删除。")) return;
    try {
      if (await api.deleteCalibrationProfile(calibrationProfileId)) {
        setCalibrationProfiles((current) => current.filter((item) => item.id !== calibrationProfileId));
        setCalibrationProfileId(undefined);
        setCalibrationVersions([]);
        if (mode === "calibrated") setMode("generic");
        setNotice("已删除标定配置及其本机历史版本");
      }
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : "无法删除标定配置");
    }
  };

  const restoreCalibrationVersion = async (version: string): Promise<void> => {
    if (calibrationProfileId === undefined || version.length === 0) return;
    try {
      const restored = await api.restoreCalibrationProfileVersion(calibrationProfileId, version);
      setCalibrationProfiles((current) => [restored, ...current.filter((item) => item.id !== restored.id)]);
      setNotice("已恢复标定配置版本 v" + restored.version);
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : "无法恢复标定配置版本");
    }
  };

  const generateColorCardCalibration = async (): Promise<void> => {
    if (colorCardAssetId === undefined) {
      setNotice("请选择已导入、已校正的 6×4 ColorChecker 色卡照片");
      return;
    }
    if (!linkedAssetIds.has(colorCardAssetId)) {
      setNotice("色卡照片尚未连接本地源文件，请先重新连接。");
      return;
    }
    try {
      const cardRecipe = colorCardAssetId === activeAssetId
        ? captureRecipe()
        : resolveFrameRecipe(activeRoll, colorCardAssetId);
      const result = await api.generateCalibrationFromColorCard(
        colorCardAssetId,
        cardRecipe.processing,
        {
          lens: calibrationCaptureContext.lens.trim() || undefined,
          filmStock: calibrationCaptureContext.filmStock.trim() || undefined,
          process: calibrationCaptureContext.process.trim() || undefined,
          illuminationId: calibrationCaptureContext.illuminationId.trim() || undefined,
        },
      );
      setCalibrationProfiles((current) => [result.profile, ...current.filter((item) => item.id !== result.profile.id)]);
      recordRecipeChange();
      setCalibrationProfileId(result.profile.id);
      setMode("calibrated");
      setNotice("色卡识别、采样与拟合已生成配置 · " + result.usedPatchCount + "/" + result.detectedPatchCount + " 色块");
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : "色卡自动标定失败");
    }
  };

  const activeAsset = assets.find((asset) => asset.id === activeAssetId);
  const activeSourceLabel = activeAssetId === undefined
    ? "未选择帧"
    : activeAsset === undefined ? "演示样张" : activeAsset.name;

  const updateTonePreview = (key: keyof ToneState, value: number): void => {
    setTone((current) => current[key] === value ? current : { ...current, [key]: value });
  };

  const updateChannelGain = (channel: 0 | 1 | 2, value: number): void => {
    setProcessing((current) => {
      const gains = [...(current.channelGains ?? [1, 1, 1])] as [number, number, number];
      if (gains[channel] === value) return current;
      gains[channel] = value;
      return { ...current, channelGains: gains };
    });
  };

  const updatePreSaturation = (value: number): void => {
    setProcessing((current) => current.preSaturation === value ? current : { ...current, preSaturation: value });
  };

  const refreshCalibrationProfiles = async (): Promise<void> => {
    setCalibrationProfiles(await api.listCalibrationProfiles());
  };

  const runProjectSwitch = async (
    operation: () => Promise<ProjectLoadResult | undefined>,
  ): Promise<void> => {
    if (isProjectSwitching) return;
    setIsProjectSwitching(true);
    setProjectStatus("切换中");
    try {
      await flushProject();
      const loaded = await operation();
      if (loaded === undefined) {
        setProjectStatus(projectSessionRef.current?.readOnly ? "只读" : "已保存");
        return;
      }
      applyLoadedProject(loaded);
      await refreshCalibrationProfiles();
    } catch (error: unknown) {
      setProjectStatus(projectSessionRef.current?.readOnly ? "只读" : "保存失败");
      setNotice(error instanceof Error ? error.message : "项目操作失败");
    } finally {
      setIsProjectSwitching(false);
    }
  };

  const saveProjectAs = async (): Promise<void> => {
    const session = projectSessionRef.current;
    const draft = latestProjectDraftRef.current;
    if (session === undefined || draft === undefined || isProjectSwitching) return;
    await runProjectSwitch(() => api.saveProjectAs(session.id, draft));
  };

  const confirmProjectPendingAction = async (): Promise<void> => {
    const session = projectSessionRef.current;
    const draft = latestProjectDraftRef.current;
    if (session?.pendingAction === undefined || draft === undefined || isProjectSwitching) return;
    setIsProjectSwitching(true);
    try {
      const loaded = await api.confirmProjectPendingAction(session.id, draft);
      applyLoadedProject(loaded);
      await refreshCalibrationProfiles();
      setNotice(session.pendingAction === "migration"
        ? "项目迁移已确认；原文件已备份，当前项目已保存为 schema v8。"
        : "备份恢复已确认；损坏主文件已保留在备份目录。"
      );
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : "无法确认项目操作");
    } finally {
      setIsProjectSwitching(false);
    }
  };

  const createManualProjectBackup = async (): Promise<void> => {
    const session = projectSessionRef.current;
    if (session === undefined || isProjectSwitching) return;
    setIsProjectSwitching(true);
    try {
      await flushProject();
      const result = await api.createProjectBackup(session.id);
      setProjectSession((current) => current === undefined ? current : { ...current, backupCount: result.backupCount });
      setNotice(result.created
        ? `项目备份已创建 · 当前 ${result.backupCount} 份`
        : "项目尚未落盘，没有可备份的内容。");
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : "无法创建项目备份");
    } finally {
      setIsProjectSwitching(false);
      setIsProjectMenuOpen(false);
    }
  };

  const checkForUpdates = async (): Promise<void> => {
    try {
      setUpdateStatus(await api.checkForUpdates());
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : "无法检查更新");
    }
  };

  const installUpdate = async (): Promise<void> => {
    try {
      await flushProject();
      await api.installUpdate();
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : "无法安装更新");
    }
  };

  const rollbackUpdate = async (): Promise<void> => {
    try {
      await flushProject();
      await api.rollbackUpdate();
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : "无法回滚版本");
    }
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      const target = event.target;
      const isTextEntry = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable);
      if (event.key === "F1") {
        event.preventDefault();
        setIsShortcutHelpOpen((current) => !current);
        return;
      }
      if (event.key === "Escape" && isShortcutHelpOpen) {
        event.preventDefault();
        setIsShortcutHelpOpen(false);
        return;
      }
      if (isTextEntry) return;
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === "o") {
        event.preventDefault();
        if (event.shiftKey) void runProjectSwitch(() => api.openProject(false));
        else void importSources();
        return;
      }
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void flushProject()
          .then(() => {
            const readOnly = projectSessionRef.current?.readOnly === true;
            setProjectStatus(readOnly ? "只读" : "已保存");
            setNotice(readOnly ? "当前项目为只读；请使用“另存为”保存修改。" : "项目已立即保存。");
          })
          .catch((error: unknown) => setNotice(error instanceof Error ? error.message : "项目保存失败"));
        return;
      }
      if (command && event.key.toLowerCase() === "e") {
        event.preventDefault();
        if (event.shiftKey) void startBatch();
        else if (activeAssetId === demoFrameId) void exportPreview();
        else if (exportBlockedReason === undefined) void exportMasterTiff();
        else setNotice(exportBlockedReason);
        return;
      }
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoRecipe();
        else undoRecipe();
        return;
      }
      if (command && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoRecipe();
        return;
      }
      if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        const index = frames.findIndex((frame) => frame.id === activeAssetId);
        const delta = event.key === "ArrowLeft" ? -1 : 1;
        const next = frames[index + delta];
        if (next !== undefined) selectFrame(next.id);
      }
    };
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  });

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-workspace">跳到主工作区</a>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Aperture size={18} strokeWidth={1.8} />
          </div>
          <div>
            <strong>FilmLab</strong>
            <span>Negative workspace</span>
          </div>
        </div>

        <div className="project-title">
          <span>{projectSession?.name ?? "Projects"}</span>
          <ChevronDown size={14} />
          <span className="project-separator">/</span>
          <input
            className="project-name"
            aria-label="项目名称"
            value={projectTitle}
            maxLength={80}
            onChange={(event) => updateRollTitle(activeRoll.id, event.currentTarget.value)}
          />
          <span className={projectStatus === "保存失败" ? "project-status is-error" : "project-status"}>
            {projectStatus}
          </span>
        </div>

        <div className="top-actions">
          <button className="icon-button" type="button" aria-label="撤销" aria-keyshortcuts="Control+Z Meta+Z" title="撤销（Ctrl/⌘+Z）" disabled={undoStack.length === 0} onClick={undoRecipe}>
            <Undo2 size={16} />
          </button>
          <button className="icon-button" type="button" aria-label="重做" aria-keyshortcuts="Control+Y Meta+Y Control+Shift+Z Meta+Shift+Z" title="重做（Ctrl/⌘+Y）" disabled={redoStack.length === 0} onClick={redoRecipe}>
            <Redo2 size={16} />
          </button>
          <span className="top-divider" />
          <button className="secondary-button" type="button" aria-keyshortcuts="Control+O Meta+O" title="导入帧（Ctrl/⌘+O）" onClick={() => void importSources()}>
            <FolderOpen size={16} />
            导入帧
          </button>
          <button className="secondary-button" type="button" disabled={assets.length === 0} onClick={() => void relinkSources()} title="扫描所选目录及子目录，按内容指纹重新连接">
            扫描目录重连
          </button>
          <button className="secondary-button" type="button" aria-keyshortcuts="Control+Shift+E Meta+Shift+E" title="批量导出（Ctrl/⌘+Shift+E）" disabled={assets.length === 0 || batchJob?.state === "running" || batchJob?.state === "queued"} onClick={() => void startBatch()}>
            批处理
          </button>
          <div className="export-menu-shell" ref={exportMenuRef}>
            <div className="export-split-button">
              <button
                className={"primary-button export-primary-action" + (exportBlockedReason !== undefined && !isExporting ? " is-unavailable" : "")}
                type="button"
                aria-label={activeAssetId === demoFrameId ? "导出预览" : "导出 " + currentMasterExportLabel}
                aria-busy={isExporting}
                aria-keyshortcuts="Control+E Meta+E"
                aria-disabled={exportBlockedReason !== undefined}
                disabled={isExporting}
                title={exportBlockedReason}
                onClick={() => {
                  if (exportBlockedReason !== undefined) {
                    setNotice(exportBlockedReason);
                    return;
                  }
                  if (activeAssetId === demoFrameId) void exportPreview();
                  else void exportMasterTiff();
                }}
              >
                <Download size={16} />
                {isExporting ? "导出中" : activeAssetId === demoFrameId ? "导出预览" : "导出 " + currentMasterExportLabel}
              </button>
              {activeAssetId === demoFrameId ? null : (
                <button
                  className="export-format-trigger"
                  type="button"
                  aria-label="选择导出格式"
                  aria-haspopup="menu"
                  aria-expanded={isExportMenuOpen}
                  disabled={exportPrerequisiteBlockedReason !== undefined}
                  title={exportPrerequisiteBlockedReason ?? "选择 TIFF、JPG、HEIF 或 DNG"}
                  onClick={() => setIsExportMenuOpen((current) => !current)}
                >
                  <ChevronDown size={14} />
                </button>
              )}
            </div>
            {isExportMenuOpen && activeAssetId !== demoFrameId ? (
              <div className="export-format-menu" role="menu" aria-label="选择导出格式">
                {masterExportChoices.map((choice) => {
                  const unavailableReason = choice.format === "dng" ? dngBlockedReason : undefined;
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      className={choice.format === masterExportFormat ? "is-selected" : undefined}
                      key={choice.format}
                      disabled={unavailableReason !== undefined}
                      title={unavailableReason}
                      onClick={() => void exportMasterTiff(choice.format)}
                    >
                      <span className="export-format-check">{choice.format === masterExportFormat ? <Check size={14} /> : null}</span>
                      <span><strong>{choice.label}</strong><small>{unavailableReason ?? choice.detail}</small></span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
          <div className="project-menu-shell" ref={projectMenuRef}>
            <button
              className={isProjectMenuOpen ? "icon-button is-active" : "icon-button"}
              type="button"
              aria-label="项目操作"
              aria-haspopup="menu"
              aria-expanded={isProjectMenuOpen}
              onClick={() => setIsProjectMenuOpen((current) => !current)}
            >
              <MoreHorizontal size={18} />
            </button>
            {isProjectMenuOpen ? (
              <div className="project-lifecycle-menu" role="menu" aria-label="项目操作">
                <div className="project-menu-summary">
                  <strong>{projectSession?.name ?? "FilmLab 项目"}</strong>
                  <small>
                    {projectSession?.readOnly ? "只读" : "可写"}
                    {projectSession === undefined ? "" : ` · ${projectSession.backupCount} 份备份`}
                  </small>
                </div>
                {projectSession?.pendingAction === undefined ? null : (
                  <button type="button" role="menuitem" disabled={isProjectSwitching} onClick={() => void confirmProjectPendingAction()}>
                    <Check size={15} />
                    {projectSession.pendingAction === "migration" ? "确认迁移到 schema v8" : "确认从备份恢复"}
                  </button>
                )}
                <button type="button" role="menuitem" disabled={isProjectSwitching} onClick={() => void runProjectSwitch(() => api.createProject())}>
                  <FileImage size={15} /> 新建项目
                </button>
                <button type="button" role="menuitem" disabled={isProjectSwitching} onClick={() => void runProjectSwitch(() => api.openProject(false))}>
                  <FolderOpen size={15} /> 打开项目
                </button>
                <button type="button" role="menuitem" disabled={isProjectSwitching} onClick={() => void runProjectSwitch(() => api.openProject(true))}>
                  <FolderOpen size={15} /> 只读打开
                </button>
                <button type="button" role="menuitem" disabled={isProjectSwitching || projectSession === undefined} onClick={() => void saveProjectAs()}>
                  <Copy size={15} /> 另存为
                </button>
                <button type="button" role="menuitem" disabled={isProjectSwitching || projectSession === undefined || projectSession.readOnly} onClick={() => void createManualProjectBackup()}>
                  <Layers size={15} /> 创建备份
                </button>
                <div className="project-menu-summary update-summary" role="status" aria-live="polite">
                  <strong>FilmLab v{updateStatus.currentVersion}</strong>
                  <small>{formatUpdateStatus(updateStatus)}</small>
                </div>
                {updateStatus.state === "downloaded" ? (
                  <button type="button" role="menuitem" onClick={() => void installUpdate()}>
                    <Download size={15} /> 安装 v{updateStatus.availableVersion}
                  </button>
                ) : (
                  <button type="button" role="menuitem" disabled={updateStatus.state === "checking" || updateStatus.state === "downloading" || updateStatus.state === "disabled"} onClick={() => void checkForUpdates()}>
                    <RefreshCw size={15} /> 检查更新
                  </button>
                )}
                {updateStatus.rollbackVersion === undefined ? null : (
                  <button type="button" role="menuitem" onClick={() => void rollbackUpdate()}>
                    <RotateCcw size={15} /> 回滚到 v{updateStatus.rollbackVersion}
                  </button>
                )}
                <button type="button" role="menuitem" onClick={() => {
                  setIsProjectMenuOpen(false);
                  setIsShortcutHelpOpen(true);
                }}>
                  <HelpCircle size={15} /> 快捷键与帮助
                </button>
                {recentProjects.length === 0 ? null : (
                  <div className="recent-projects" aria-label="最近项目">
                    <span>最近项目</span>
                    {recentProjects.map((recent) => (
                      <div className="recent-project-row" key={recent.id}>
                        <button
                          type="button"
                          disabled={!recent.available || isProjectSwitching || recent.id === projectSession?.projectId}
                          onClick={() => void runProjectSwitch(() => api.openRecentProject({ id: recent.id, readOnly: false }))}
                        >
                          <strong>{recent.name}</strong>
                          <small>{recent.available ? new Date(recent.lastOpenedAt).toLocaleString("zh-CN") : "位置不可用"}</small>
                        </button>
                        <button
                          className="recent-readonly"
                          type="button"
                          title="只读打开"
                          disabled={!recent.available || isProjectSwitching}
                          onClick={() => void runProjectSwitch(() => api.openRecentProject({ id: recent.id, readOnly: true }))}
                        >只读</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <aside className="library-panel">
        <div className={isResizingLibrary ? "library-sections is-resizing" : "library-sections"} ref={librarySectionsRef}>
          <section className="library-section roll-section" style={{ flexBasis: librarySplit + "%" }}>
            <div className="panel-heading">
              <span>胶卷 <span className="heading-count">{rolls.length}</span></span>
              <button
                className="icon-button compact"
                type="button"
                aria-label="新建胶卷"
                title="新建胶卷"
                onClick={() => setRollDialog({ kind: "create", initialTitle: createUniqueRollTitle("新胶卷", rolls) })}
              >
                <span>+</span>
              </button>
            </div>

            <div className="roll-list">
              {rolls.map((roll) => {
                const isSelected = roll.id === activeRollId;
                const menuIsOpen = roll.id === rollMenuId;
                const rollThumbnailUrl = thumbnailUrls.get(roll.frameOrder[0] ?? "");
                return (
                  <div
                    className="roll-card-shell"
                    key={roll.id}
                    ref={menuIsOpen ? rollMenuRef : undefined}
                  >
                    <button
                      className={isSelected ? "roll-card is-selected" : "roll-card"}
                      type="button"
                      onClick={() => selectRoll(roll)}
                      aria-current={isSelected ? "true" : undefined}
                    >
                      <span className="roll-thumbnail">
                        {rollThumbnailUrl === undefined
                          ? <Film size={18} />
                          : <img src={rollThumbnailUrl} alt="" />}
                      </span>
                      <span className="roll-copy">
                        <strong>{roll.title.trim() || "未命名胶卷"}</strong>
                        <small>
                          {roll.frameOrder.length} 帧
                          {roll.frameOrder.length === 0 ? " · 空胶卷" : roll.uniformRecipe === undefined ? "" : " · 统一反转"}
                        </small>
                      </span>
                    </button>
                    <button
                      className={menuIsOpen ? "roll-more-button is-open" : "roll-more-button"}
                      type="button"
                      aria-label={roll.title + "的更多操作"}
                      aria-haspopup="menu"
                      aria-expanded={menuIsOpen}
                      onClick={() => setRollMenuId((current) => current === roll.id ? undefined : roll.id)}
                    >
                      <MoreHorizontal size={15} />
                    </button>
                    {menuIsOpen ? (
                      <div className="roll-menu" role="menu" aria-label={roll.title + "操作"}>
                        <button type="button" role="menuitem" onClick={() => {
                          setRollMenuId(undefined);
                          setRollDialog({ kind: "rename", rollId: roll.id, initialTitle: roll.title });
                        }}>
                          <Pencil size={14} />
                          重命名
                        </button>
                        <button type="button" role="menuitem" onClick={() => duplicateRoll(roll.id)}>
                          <Copy size={14} />
                          复制胶卷
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={!isSelected || activeAssetId === undefined}
                          title={!isSelected ? "请先切换到这卷胶卷" : activeAssetId === undefined ? "请先选择一帧" : undefined}
                          onClick={applyCurrentRecipeToRoll}
                        >
                          <Layers size={14} />
                          {roll.uniformRecipe === undefined ? "套用当前帧反转" : "更新整卷反转"}
                        </button>
                        {roll.uniformRecipe === undefined ? null : (
                          <button type="button" role="menuitem" disabled={!isSelected} onClick={clearRollUniformRecipe}>
                            <RotateCcw size={14} />
                            取消统一反转
                          </button>
                        )}
                        <span className="roll-menu-divider" />
                        <button
                          className="is-danger"
                          type="button"
                          role="menuitem"
                          disabled={rolls.length <= 1}
                          title={rolls.length <= 1 ? "工作区至少需要保留一卷胶卷" : undefined}
                          onClick={() => {
                            setRollMenuId(undefined);
                            setRollDialog({ kind: "delete", rollId: roll.id, rollTitle: roll.title });
                          }}
                        >
                          <Trash2 size={14} />
                          删除胶卷
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>

          <div
            className="library-resizer"
            role="separator"
            aria-label="调整胶卷和帧区域高度"
            aria-orientation="horizontal"
            aria-valuemin={20}
            aria-valuemax={72}
            aria-valuenow={Math.round(librarySplit)}
            tabIndex={0}
            onPointerDown={(event) => {
              event.preventDefault();
              setIsResizingLibrary(true);
            }}
            onKeyDown={(event) => {
              if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) event.preventDefault();
              if (event.key === "ArrowUp") setLibrarySplit((value) => clamp(value - 4, 20, 72));
              if (event.key === "ArrowDown") setLibrarySplit((value) => clamp(value + 4, 20, 72));
              if (event.key === "Home") setLibrarySplit(20);
              if (event.key === "End") setLibrarySplit(72);
            }}
          >
            <span />
          </div>

          <section className="library-section frame-section">
            <div className="panel-heading frames-heading">
              <span>帧</span>
              <span className="count-badge">{frames.length}</span>
            </div>
            <div className="frame-list">
              {frames.length === 0 ? (
                <div className="frame-empty">
                  <Film size={20} />
                  <strong>这卷胶卷还没有帧</strong>
                  <span>使用“导入帧”添加 RAW 或 TIFF</span>
                </div>
              ) : frames.map((frame, index) => {
                const thumbnailUrl = thumbnailUrls.get(frame.id);
                return (
                <div
                  className={[
                    "frame-row-shell",
                    draggedFrameId === frame.id ? "is-dragging" : "",
                    dropTargetFrameId === frame.id && draggedFrameId !== frame.id ? "is-drop-target" : "",
                  ].filter(Boolean).join(" ")}
                  draggable
                  key={frame.id}
                  onDragStart={(event) => startFrameDrag(event, frame.id)}
                  onDragOver={(event) => moveFrameOver(event, frame.id)}
                  onDrop={(event) => dropFrame(event, frame.id)}
                  onDragEnd={finishFrameDrag}
                >
                  <span className="frame-drag-handle" title="拖动排序" aria-hidden="true">
                    <GripVertical size={13} />
                  </span>
                  <button
                    className={frame.id === activeAssetId ? "frame-row is-selected" : "frame-row"}
                    type="button"
                    onClick={() => selectFrame(frame.id)}
                  >
                    <span className={frame.kind === "demo" ? "frame-image demo-frame" : "frame-image external-frame"}>
                      {thumbnailUrl === undefined ? null : <img src={thumbnailUrl} alt="" />}
                      <em>{String(index + 1).padStart(2, "0")}</em>
                    </span>
                    <span>
                      <strong>{frame.kind === "demo" ? "演示负片" : frame.asset.name}</strong>
                      <small>{frame.kind === "demo" ? "内建合成样张" : frame.asset.extension + " · 独立处理"}</small>
                    </span>
                  </button>
                  <button
                    className="frame-delete-button"
                    type="button"
                    aria-label={"删除" + (frame.kind === "demo" ? "演示负片" : frame.asset.name)}
                    title="从胶卷中删除"
                    onClick={() => setFrameDeleteDialog({
                      frameId: frame.id,
                      label: frame.kind === "demo" ? "演示负片" : frame.asset.name,
                      isDemo: frame.kind === "demo",
                    })}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                );
              })}
            </div>
          </section>
        </div>

        <div className="library-footer">
          <button className="footer-nav is-selected" type="button">
            <PanelLeft size={16} />
            工作区
          </button>
        </div>
      </aside>

      <main className="workspace" id="main-workspace" tabIndex={-1}>
        <div className="workspace-toolbar">
          <div className="view-switcher" role="tablist" aria-label="预览视图">
            {(Object.keys(viewLabels) as PreviewView[]).map((option) => (
              <button
                className={option === view ? "view-tab is-selected" : "view-tab"}
                type="button"
                role="tab"
                aria-selected={option === view}
                onClick={() => changeView(option)}
                key={option}
              >
                {viewLabels[option]}
              </button>
            ))}
          </div>
          <div className="workspace-tools">
            <button
              className="compact-tool"
              type="button"
              disabled={preview === null}
              onClick={() => {
                setPreviewFitRevision((current) => current + 1);
                setNotice("预览已按画布边界适配显示。");
              }}
            >
              <ZoomIn size={15} />
              适合
            </button>
            <button
              className={isStraightenDrawing ? "compact-tool is-selected" : "compact-tool"}
              type="button"
              aria-pressed={isStraightenDrawing}
              disabled={preview === null || isGeometryAnalyzing}
              onClick={isStraightenDrawing ? cancelStraightenDrawing : beginStraightenDrawing}
            >
              <Ruler size={15} />
              {isStraightenDrawing ? "取消拉直" : "直尺拉直"}
            </button>
            <button className="compact-tool" type="button" aria-busy={geometryTask === "crop"} disabled={preview === null || isGeometryAnalyzing} onClick={() => void autoCrop()}>
              <Sparkles size={15} />
              {geometryTask === "crop" ? "识别中…" : "自动裁切"}
            </button>
            <button
              className={isCropEditing ? "compact-tool is-selected" : "compact-tool"}
              type="button"
              aria-pressed={isCropEditing}
              disabled={preview === null || isGeometryAnalyzing}
              onClick={isCropEditing ? finishCropEditing : beginCropEditing}
            >
              {isCropEditing ? <Check size={15} /> : <Crop size={15} />}
              {isCropEditing ? "完成" : "裁切"}
            </button>
          </div>
        </div>

        <section className="canvas-stage">
          <div className="canvas-frame">
            {activeAssetId === undefined ? (
              <div className="canvas-empty">
                <Film size={26} />
                <strong>当前胶卷没有帧</strong>
                <span>使用顶部“导入帧”添加源文件</span>
              </div>
            ) : previewNeedsRelink ? (
              <div className="canvas-empty">
                <FolderOpen size={26} />
                <strong>源文件需要重新连接</strong>
                <span>项目只保存安全的文件描述，不保存本机绝对路径</span>
                <button className="secondary-button" type="button" onClick={() => void relinkSources()}>
                  <FolderOpen size={14} />
                  重连源文件
                </button>
              </div>
            ) : preview === null ? (
              <div className="canvas-loading">
                <Sparkles size={22} />
                正在建立预览
              </div>
            ) : (
              <PreviewCanvas
                preview={preview}
                displaySize={previewDisplaySize ?? { width: preview.width, height: preview.height }}
                fitRevision={previewFitRevision}
                tone={tone}
                mode={mode}
                view={view}
                processing={previewProcessing}
                crop={processing.geometry.crop}
                cropEditing={isCropEditing}
                baseRoi={processing.baseRoi}
                baseSampling={isBaseSampling || isWhiteBalanceSampling || isDmaxSampling}
                baseSamplingPurpose={isDmaxSampling ? "dmax" : isWhiteBalanceSampling ? "white-balance" : "density"}
                dmaxRoi={dmaxSampleRoi}
                straightenDrawing={isStraightenDrawing}
                currentStraightenDegrees={processing.geometry.straighten ?? 0}
                onRenderBackendChange={handlePreviewRenderBackendChange}
                onCropChange={(crop) => updateProcessing((current) => ({
                  ...current,
                  geometry: { ...current.geometry, crop },
                }))}
                onCropDone={finishCropEditing}
                onBaseRoiChange={(baseRoi) => updateProcessing((current) => ({ ...current, baseRoi }))}
                onDmaxRoiChange={setDmaxSampleRoi}
                onBaseDone={isDmaxSampling
                  ? () => void finishDmaxSampling()
                  : isWhiteBalanceSampling ? () => void finishWhiteBalanceSampling() : finishBaseSampling}
                onStraightenCommit={commitStraightenReference}
                onStraightenInvalid={() => setNotice("参考线太短，请沿清晰的水平或垂直边缘拖出更长的线条。")}
              />
            )}
            <div className="canvas-hud hud-top">
              <span className="hud-status">
                <span className={isRendering || isGeometryAnalyzing || isStraightenDrawing || isWhiteBalanceApplying || isDmaxApplying ? "status-dot is-busy" : "status-dot"} />
                {activeAssetId === undefined
                  ? "等待帧"
                  : previewNeedsRelink
                    ? "等待重连"
                    : isStraightenDrawing
                      ? "绘制拉直参考线"
                      : geometryTask === "crop"
                        ? "识别片框"
                      : isWhiteBalanceSampling
                        ? "吸取片基白平衡"
                      : isWhiteBalanceApplying
                        ? "计算片基白平衡"
                      : isDmaxApplying
                        ? "Dmax"
                      : isDmaxSampling
                        ? "手动 Dmax"
                      : isBaseSampling
                        ? "选择未曝光片基"
                        : isRendering
                          ? previewQuality === "refining" ? "细化预览" : "生成快速预览"
                          : viewLabels[view] + "预览"}
              </span>
              <span>{modeLabels[mode]}{preview?.photonTransfer === undefined ? "" : " · A7R V PTC"}</span>
            </div>
            <div className="canvas-hud hud-bottom">
              <span>{activeSourceLabel} · {previewQuality === "settled" ? "高质量预览" : previewQuality === "refining" ? "正在细化" : "快速预览"}{previewDisplaySize === null ? "" : " · " + previewDisplaySize.width + " × " + previewDisplaySize.height}</span>
              <span>{previewRenderBackend === "webgl2-pipeline"
                ? "GPU 全管线 · 即时"
                : previewRenderBackend === "webgl2-linear"
                  ? "GPU 色调 · 即时"
                : previewRenderBackend === "webgl2"
                  ? "GPU 显示"
                  : previewRenderBackend === "pending"
                    ? "准备 GPU"
                    : "兼容渲染"} · 100%</span>
            </div>
          </div>
        </section>

        <section className="analysis-bar" role="status" aria-label="预览状态" aria-live="polite" aria-atomic="true">
          <div className="analysis-item">
            <span className="analysis-label">Dmin · 片基</span>
            <strong>{preview === null ? "—" : preview.density.dmin.toFixed(3) + " D"}</strong>
          </div>
          <div className="analysis-item">
            <span className="analysis-label">Dmax · 高密度</span>
            <strong>{preview === null ? "—" : preview.density.dmax.toFixed(3) + " D"}</strong>
          </div>
          <div className="analysis-item wide">
            <CircleAlert size={15} />
            <span>{notice}</span>
          </div>
        </section>
      </main>

      <aside className="inspector-panel">
        <div className="inspector-title">
          <div>
            <span className="eyebrow">处理配方</span>
            <strong>{mode === "calibrated"
              ? calibrationProfiles.find((profile) => profile.id === calibrationProfileId)?.label ?? "待选择色卡校准配置"
              : "默认负片反转"}</strong>
          </div>
          <button className="icon-button compact" type="button" aria-label="配方选项">
            <Settings2 size={16} />
          </button>
        </div>

        <InspectorSection title="模式" defaultOpen>
          <div className="mode-stack" role="group" aria-label="反转模式">
            <ModeButton
              active={mode === "generic"}
              label="默认模式"
              detail="片基、密度反转与全局平衡"
              onClick={() => changeMode("generic")}
            />
            <ModeButton
              active={mode === "calibrated"}
              label="色卡校准"
              detail="色卡曲线、矩阵与 3D LUT"
              onClick={() => changeMode("calibrated")}
            />
          </div>
          <div className="profile-actions">
            <select
              className="profile-select"
              aria-label="色卡标定配置"
              value={calibrationProfileId ?? ""}
              onChange={(event) => {
                const id = event.currentTarget.value || undefined;
                recordRecipeChange();
                setCalibrationProfileId(id);
                if (id !== undefined) {
                  setMode("calibrated");
                }
              }}
            >
              <option value="">未选择色卡配置</option>
              {calibrationProfiles.map((profile) => (
                <option value={profile.id} key={profile.id}>{profile.label} · v{profile.version}{profile.hasLut ? " · 3D LUT" : ""}</option>
              ))}
            </select>
            <button className="compact-tool" type="button" onClick={() => void importCalibrationProfile()}>
              导入配置
            </button>
          </div>
          <div className="profile-actions">
            <select
              className="profile-select"
              aria-label="标定配置历史版本"
              value={calibrationVersions.find((version) => version.current)?.version ?? ""}
              disabled={calibrationProfileId === undefined || calibrationVersions.length < 2}
              onChange={(event) => void restoreCalibrationVersion(event.currentTarget.value)}
            >
              {calibrationVersions.length === 0 ? <option value="">没有历史版本</option> : calibrationVersions.map((version) => (
                <option value={version.version} key={version.version}>
                  v{version.version}{version.current ? " · 当前" : " · " + new Date(version.createdAt).toLocaleDateString("zh-CN")}
                </option>
              ))}
            </select>
            <button className="compact-tool" type="button" disabled={calibrationProfileId === undefined} onClick={() => void exportCalibrationProfile()}>导出</button>
            <button className="compact-tool danger" type="button" disabled={calibrationProfileId === undefined} onClick={() => void deleteCalibrationProfile()}>删除</button>
          </div>
          <div className="profile-actions">
            <select className="profile-select" aria-label="色卡照片" value={colorCardAssetId ?? ""} onChange={(event) => setColorCardAssetId(event.currentTarget.value || undefined)}>
              <option value="">选择 6×4 ColorChecker 色卡照片…</option>
              {assets.map((asset) => <option value={asset.id} key={asset.id}>{asset.name}</option>)}
            </select>
            <button className="compact-tool" type="button" disabled={colorCardAssetId === undefined} onClick={() => void generateColorCardCalibration()}>自动识别色卡</button>
          </div>
          <div className="profile-actions calibration-context" aria-label="色卡拍摄上下文">
            <input className="profile-select" aria-label="镜头" placeholder="镜头（可选）" value={calibrationCaptureContext.lens} onChange={(event) => setCalibrationCaptureContext((current) => ({ ...current, lens: event.currentTarget.value }))} />
            <input className="profile-select" aria-label="片种" placeholder="片种（可选）" value={calibrationCaptureContext.filmStock} onChange={(event) => setCalibrationCaptureContext((current) => ({ ...current, filmStock: event.currentTarget.value }))} />
            <input className="profile-select" aria-label="冲洗工艺" placeholder="冲洗（可选）" value={calibrationCaptureContext.process} onChange={(event) => setCalibrationCaptureContext((current) => ({ ...current, process: event.currentTarget.value }))} />
            <input className="profile-select" aria-label="背光标识" placeholder="背光 ID（可选）" value={calibrationCaptureContext.illuminationId} onChange={(event) => setCalibrationCaptureContext((current) => ({ ...current, illuminationId: event.currentTarget.value }))} />
          </div>
          <div className="profile-actions">
            <select className="profile-select" aria-label="项目预设" value="" onChange={(event) => applyPreset(event.currentTarget.value)}>
              <option value="">应用项目预设…</option>
              {projectPresets.map((preset) => <option value={preset.id} key={preset.id}>{preset.label}</option>)}
            </select>
            <button className="compact-tool" type="button" onClick={savePreset}>保存当前预设</button>
          </div>
          <div className={activeRoll.uniformRecipe === undefined ? "roll-recipe-card" : "roll-recipe-card is-active"}>
            <div>
              <strong>整卷统一反转</strong>
              <span>{activeRoll.uniformRecipe === undefined
                ? "以当前帧的完整配方作为整卷处理基准"
                : "来源 " + describeFrame(activeRoll, activeRoll.uniformRecipe.sourceFrameId) + " · " + activeRoll.frameOrder.length + " 帧"}</span>
            </div>
            <div className="roll-recipe-actions">
              <button
                className="compact-tool"
                type="button"
                disabled={activeAssetId === undefined}
                onClick={applyCurrentRecipeToRoll}
              >
                {activeRoll.uniformRecipe === undefined ? "套用至整卷" : "更新"}
              </button>
              {activeRoll.uniformRecipe === undefined ? null : (
                <button className="compact-tool" type="button" onClick={clearRollUniformRecipe}>取消</button>
              )}
            </div>
          </div>
          <p className="section-note">
            {describeColorTrustDetail(activeColorTrust)}
            {preview?.photonTransfer === undefined
              ? ""
              : " 已启用 A7R V ISO 100 PTC 低信噪比正则化；它抑制密集阴影伪色，但不构成色彩校准。"}
          </p>
        </InspectorSection>

        <InspectorSection title="密度锚点" defaultOpen>
          <div className="base-card">
            <div className="base-swatch" />
            <div>
              <strong>未曝光片基</strong>
              <span>{processing.filmBase?.kind === "reference"
                ? processing.filmBase.origin === "sampled"
                  ? "同卷实测参考 · " + (processing.filmBase.sourceFrameId === undefined ? "来源帧未知" : describeFrame(activeRoll, processing.filmBase.sourceFrameId))
                  : "无边框统计估算 · 导出前需复核"
                : "Dmin · 裁切画面内 ROI 取样"}</span>
            </div>
            <button
              className={isBaseSampling ? "compact-tool base-card-action is-selected" : "compact-tool base-card-action"}
              type="button"
              aria-pressed={isBaseSampling}
              disabled={preview === null}
              onClick={isBaseSampling ? finishBaseSampling : beginBaseSampling}
            >
              {isBaseSampling ? <Check size={13} /> : <Pipette size={13} />}
              {isBaseSampling ? "完成" : "选择"}
            </button>
          </div>
          <div className="base-reference-actions">
            {processing.filmBase === undefined ? (
              <button className="compact-tool" type="button" disabled={preview === null || preview.base.method !== "roi"} onClick={freezeCurrentFilmBase}>
                锁定当前片基
              </button>
            ) : (
              <button className="compact-tool" type="button" onClick={clearFilmBaseReference}>恢复画内 ROI</button>
            )}
            <button className="compact-tool" type="button" disabled={activeAssetId === undefined || previewNeedsRelink || isBaseEstimating} onClick={() => void estimateBorderlessFilmBase()}>
              {isBaseEstimating ? "估算中…" : "无边框估算"}
            </button>
          </div>
          <div className="metric-row">
            <span>来源</span>
            <strong>{processing.filmBase?.kind === "reference"
              ? processing.filmBase.origin === "sampled" ? "同卷参考" : "自动估算"
              : "画内 ROI"}</strong>
            <span>置信度</span>
            <strong>{preview === null ? "—" : Math.round(preview.base.confidence * 100) + "%"}</strong>
          </div>
          <div className="metric-row">
            <span>Dmax</span>
            <strong>{preview === null ? "—" : preview.density.dmax.toFixed(3) + " D"}</strong>
            <span>跨度 ΔD</span>
            <strong>{preview === null ? "—" : preview.density.range.toFixed(3) + " D"}</strong>
          </div>
          <div className={activeRoll.manualDmax === undefined ? "base-card" : "base-card is-active"}>
            <div className="base-swatch" />
            <div>
              <strong>手动 Dmax · 整卷</strong>
              <span>{activeRoll.manualDmax === undefined
                ? "默认关闭；从一帧取样后，统一作用于本胶卷所有帧"
                : "已启用 · " + activeRoll.manualDmax.value.toFixed(3) + " D"
                  + (activeRoll.manualDmax.channelRange === undefined ? "" : " · 已锁定 RGB 密度")
                  + " · 来源 " + describeFrame(activeRoll, activeRoll.manualDmax.sourceFrameId)}</span>
            </div>
            <button
              className={isDmaxSampling ? "compact-tool base-card-action is-selected" : "compact-tool base-card-action"}
              type="button"
              aria-pressed={isDmaxSampling}
              disabled={preview === null || isDmaxApplying}
              onClick={isDmaxSampling ? () => void finishDmaxSampling() : beginDmaxSampling}
            >
              {isDmaxApplying ? <Sparkles size={13} /> : isDmaxSampling ? <Check size={13} /> : <Pipette size={13} />}
              {isDmaxApplying ? "计算中" : isDmaxSampling ? "应用" : "取样"}
            </button>
          </div>
          <div className="base-reference-actions">
            <label className="pending-row">
              <span>启用手动 Dmax</span>
              <input
                type="checkbox"
                aria-label="启用手动 Dmax"
                checked={activeRoll.manualDmax !== undefined}
                disabled={isDmaxApplying}
                onChange={(event) => {
                  if (event.currentTarget.checked) beginDmaxSampling();
                  else clearManualDmax();
                }}
              />
            </label>
            <button className="compact-tool" type="button" disabled={activeRoll.manualDmax === undefined} onClick={clearManualDmax}>
              恢复自动 Dmax
            </button>
          </div>
        </InspectorSection>

        <InspectorSection title="色调" defaultOpen>
          <div className="base-card">
            <div className="base-swatch" />
            <div>
              <strong>片基白平衡</strong>
              <span>{processing.filmBase?.kind === "reference" && processing.filmBase.origin === "sampled"
                ? "已按未曝光片基中和扫描光源与片基色"
                : "吸取未曝光片基，建立每张照片独立的白平衡起点"}</span>
            </div>
            <button
              className={isWhiteBalanceSampling ? "compact-tool base-card-action is-selected" : "compact-tool base-card-action"}
              type="button"
              aria-pressed={isWhiteBalanceSampling}
              disabled={preview === null || isWhiteBalanceApplying}
              onClick={isWhiteBalanceSampling ? () => void finishWhiteBalanceSampling() : beginWhiteBalanceSampling}
            >
              {isWhiteBalanceApplying
                ? <Sparkles size={13} />
                : isWhiteBalanceSampling ? <Check size={13} /> : <Pipette size={13} />}
              {isWhiteBalanceApplying ? "计算中" : isWhiteBalanceSampling ? "应用" : "吸取片基"}
            </button>
          </div>
          <div className="metric-row">
            <span>片基 RGB</span>
            <strong>{processing.filmBase?.kind === "reference"
              ? processing.filmBase.rgb.map((value) => value.toFixed(3)).join(" / ")
              : preview === null ? "—" : preview.base.rgb.map((value) => value.toFixed(3)).join(" / ")}</strong>
            <button
              className="compact-tool"
              type="button"
              disabled={processing.filmBase === undefined}
              onClick={clearFilmBaseReference}
            >
              重置
            </button>
          </div>
          <InteractiveSlider
            label="曝光"
            value={tone.exposureStops}
            min={-2}
            max={2}
            step={0.05}
            display={(value) => value.toFixed(2) + " EV"}
            onBegin={recordRecipeChange}
            onPreview={(value) => updateTonePreview("exposureStops", value)}
            onCommit={(value) => updateTonePreview("exposureStops", value)}
            onCancel={(value) => updateTonePreview("exposureStops", value)}
          />
          <InteractiveSlider
            label="对比度"
            value={tone.contrast}
            min={0.65}
            max={1.8}
            step={0.01}
            display={(value) => value.toFixed(2)}
            onBegin={recordRecipeChange}
            onPreview={(value) => updateTonePreview("contrast", value)}
            onCommit={(value) => updateTonePreview("contrast", value)}
            onCancel={(value) => updateTonePreview("contrast", value)}
          />
          <InteractiveSlider
            label="高光压缩"
            value={tone.highlightCompression}
            min={0}
            max={2}
            step={0.05}
            display={(value) => value.toFixed(2)}
            onBegin={recordRecipeChange}
            onPreview={(value) => updateTonePreview("highlightCompression", value)}
            onCommit={(value) => updateTonePreview("highlightCompression", value)}
            onCancel={(value) => updateTonePreview("highlightCompression", value)}
          />
          <InteractiveSlider
            label="饱和度"
            value={tone.saturation}
            min={0}
            max={1.6}
            step={0.02}
            display={(value) => value.toFixed(2)}
            onBegin={recordRecipeChange}
            onPreview={(value) => updateTonePreview("saturation", value)}
            onCommit={(value) => updateTonePreview("saturation", value)}
            onCancel={(value) => updateTonePreview("saturation", value)}
          />
          <InteractiveSlider
            label="R 通道"
            value={processing.channelGains?.[0] ?? 1}
            min={0.5}
            max={2}
            step={0.01}
            display={(value) => "×" + value.toFixed(2)}
            onBegin={recordRecipeChange}
            onPreview={(value) => updateChannelGain(0, value)}
            onCommit={(value) => updateChannelGain(0, value)}
            onCancel={(value) => updateChannelGain(0, value)}
          />
          <InteractiveSlider
            label="G 通道"
            value={processing.channelGains?.[1] ?? 1}
            min={0.5}
            max={2}
            step={0.01}
            display={(value) => "×" + value.toFixed(2)}
            onBegin={recordRecipeChange}
            onPreview={(value) => updateChannelGain(1, value)}
            onCommit={(value) => updateChannelGain(1, value)}
            onCancel={(value) => updateChannelGain(1, value)}
          />
          <InteractiveSlider
            label="B 通道"
            value={processing.channelGains?.[2] ?? 1}
            min={0.5}
            max={2}
            step={0.01}
            display={(value) => "×" + value.toFixed(2)}
            onBegin={recordRecipeChange}
            onPreview={(value) => updateChannelGain(2, value)}
            onCommit={(value) => updateChannelGain(2, value)}
            onCancel={(value) => updateChannelGain(2, value)}
          />
          <InteractiveSlider
            label="预饱和"
            value={processing.preSaturation ?? 1.08}
            min={0.5}
            max={1.5}
            step={0.01}
            display={(value) => "×" + value.toFixed(2)}
            onBegin={recordRecipeChange}
            onPreview={updatePreSaturation}
            onCommit={updatePreSaturation}
            onCancel={updatePreSaturation}
          />
          <div className="base-reference-actions">
            <button
              className="compact-tool"
              type="button"
              disabled={
                tone.exposureStops === 0
                && tone.contrast === 1
                && tone.highlightCompression === 0
                && tone.saturation === 1
                && (processing.channelGains?.every((gain) => gain === 1) ?? true)
                && (processing.preSaturation ?? 1.08) === 1.08
              }
              onClick={() => {
                recordRecipeChange();
                setTone({
                  exposureStops: 0,
                  contrast: 1,
                  highlightCompression: 0,
                  saturation: 1,
                });
                setProcessing((current) => ({ ...current, channelGains: [1, 1, 1], preSaturation: 1.08 }));
                setNotice("当前照片的曝光、对比度、高光、饱和度、RGB 通道与预饱和已恢复默认；源图像色彩数据未被修改。");
              }}
            >
              重置色调
            </button>
          </div>
          <p className="section-note">
            曝光、对比度、高光与饱和度均为当前照片的非破坏性相对调整；RGB 通道增益叠加在模式默认白平衡之上（默认 ×1.00）。新导入照片从中性值开始，源图像色彩数据保持不变。
          </p>
        </InspectorSection>

        <InspectorSection title="波形" defaultOpen>
          <div className="waveform-panel">
            <canvas
              ref={waveformCanvasRef}
              className="waveform-canvas"
              aria-label="波形图"
            />
          </div>
          <p className="section-note">
            亮度（白色）与 R/G/B 通道叠加波形，采样自最终显示像素；调整通道增益、曝光或饱和度时同步更新。
          </p>
        </InspectorSection>

        <InspectorSection title="几何">
          <ProcessingInspector
            processing={processing}
            previewAvailable={preview !== null}
            cropEditing={isCropEditing}
            geometryTask={geometryTask}
            straightenDrawing={isStraightenDrawing}
            onCropEditingChange={(editing) => editing ? beginCropEditing() : finishCropEditing()}
            onAutoCrop={() => void autoCrop()}
            onStraightenDrawingChange={(drawing) => drawing ? beginStraightenDrawing() : cancelStraightenDrawing()}
            onChange={updateProcessing}
          />
          <p className="section-note">几何调整完成后，再从最终画面选取片基并计算 Dmin/Dmax。</p>
        </InspectorSection>

        <InspectorSection title="修复与导出" defaultOpen>
          <label className="slider-control">
            <span><span>母版格式</span><output>{currentMasterExportLabel}</output></span>
            <select
              aria-label="母版格式"
              value={masterExportFormat}
              onChange={(event) => setMasterExportFormat(event.currentTarget.value as MasterExportFormat)}
            >
              {masterExportChoices.map((choice) => <option key={choice.format} value={choice.format}>{choice.label}</option>)}
            </select>
          </label>
          <RestorationInspector processing={processing} onBegin={recordRecipeChange} onUpdate={setProcessing} />
          {batchJob === undefined ? null : (
            <div className="batch-status" aria-live="polite">
              <div className="batch-status-heading">
                <strong>{describeMasterExportFormat(batchJob.format)} 批处理</strong>
                <span>{batchJob.completed}/{batchJob.total}</span>
              </div>
              <p className="section-note">
                {batchJob.state === "failed"
                  ? batchJob.error ?? ("有 " + batchJob.failedAssetIds.length + " 个任务失败")
                  : batchJob.state === "completed"
                    ? "批处理已完成。"
                    : batchJob.state === "cancelled"
                      ? "批处理已取消。"
                      : batchJob.currentAssetId === undefined
                        ? "正在等待任务…"
                        : "正在处理 " + batchJob.currentAssetId}
              </p>
              {batchJob.state === "queued" || batchJob.state === "running" ? (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={batchJob.cancelRequested}
                  onClick={() => {
                    void api.cancelBatchJob(batchJob.id).then((next) => {
                      if (next !== undefined) setBatchJob(next);
                    }).catch((error: unknown) => setNotice(error instanceof Error ? error.message : "无法取消批处理"));
                  }}
                >
                  {batchJob.cancelRequested ? "正在取消…" : "取消批处理"}
                </button>
              ) : null}
            </div>
          )}
        </InspectorSection>

      </aside>

      <footer className="filmstrip">
        <div className="filmstrip-title">
          <Film size={16} />
          <span>胶片栏</span>
          <span className="count-badge">{frames.length}</span>
        </div>
        <div className="filmstrip-items">
          {frames.map((frame, index) => {
            const thumbnailUrl = thumbnailUrls.get(frame.id);
            return (
            <button
              className={[
                "strip-frame",
                frame.id === activeAssetId ? "is-selected" : "",
                draggedFrameId === frame.id ? "is-dragging" : "",
                dropTargetFrameId === frame.id && draggedFrameId !== frame.id ? "is-drop-target" : "",
              ].filter(Boolean).join(" ")}
              type="button"
              draggable
              key={frame.id}
              onClick={() => selectFrame(frame.id)}
              onDragStart={(event) => startFrameDrag(event, frame.id)}
              onDragOver={(event) => moveFrameOver(event, frame.id)}
              onDrop={(event) => dropFrame(event, frame.id)}
              onDragEnd={finishFrameDrag}
            >
              <span className={frame.kind === "demo" ? "strip-preview demo-strip" : "strip-preview external-strip"}>
                {thumbnailUrl !== undefined
                  ? <img src={thumbnailUrl} alt="" />
                  : frame.kind === "asset" ? <FileImage size={16} /> : null}
              </span>
              <strong>{String(index + 1).padStart(2, "0")}</strong>
            </button>
            );
          })}
          <button className="strip-frame add-frame" type="button" onClick={() => void importSources()}>
            <span className="strip-preview">
              <Image size={16} />
            </span>
            <strong>添加</strong>
          </button>
        </div>
      </footer>
      {rollDialog === null ? null : (
        <RollDialog
          key={rollDialog.kind + ("rollId" in rollDialog ? "-" + rollDialog.rollId : "")}
          dialog={rollDialog}
          onCancel={() => setRollDialog(null)}
          onConfirm={confirmRollDialog}
        />
      )}
      {frameDeleteDialog === null ? null : (
        <FrameDeleteDialog
          dialog={frameDeleteDialog}
          onCancel={() => setFrameDeleteDialog(null)}
          onConfirm={() => deleteFrame(frameDeleteDialog.frameId)}
        />
      )}
      {isShortcutHelpOpen ? <ShortcutHelpDialog onClose={() => setIsShortcutHelpOpen(false)} /> : null}
    </div>
  );
}

function formatUpdateStatus(status: UpdateStatus): string {
  if (status.message !== undefined) return status.message;
  switch (status.state) {
    case "disabled": return "开发构建不检查更新";
    case "checking": return "正在检查更新";
    case "up-to-date": return "已经是最新版本";
    case "available": return `发现 v${status.availableVersion ?? "新版本"}`;
    case "downloading": return `正在下载 ${Math.round(status.downloadPercent ?? 0)}%`;
    case "downloaded": return `v${status.availableVersion ?? "新版本"} 已就绪`;
    case "error": return "更新检查失败";
    default: return "自动更新已启用";
  }
}

function ShortcutHelpDialog({ onClose }: { readonly onClose: () => void }): ReactNode {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section className="shortcut-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-dialog-title">
        <div className="dialog-copy">
          <h2 id="shortcut-dialog-title">快捷键与帮助</h2>
          <p>Windows/Linux 使用 Ctrl，macOS 使用 ⌘。完整流程见随安装包附带的 resources/docs/user-manual.md。</p>
        </div>
        <dl className="shortcut-list">
          <div><dt>导入帧</dt><dd>Ctrl/⌘ + O</dd></div>
          <div><dt>打开项目</dt><dd>Ctrl/⌘ + Shift + O</dd></div>
          <div><dt>立即保存</dt><dd>Ctrl/⌘ + S</dd></div>
          <div><dt>导出当前帧</dt><dd>Ctrl/⌘ + E</dd></div>
          <div><dt>批量导出</dt><dd>Ctrl/⌘ + Shift + E</dd></div>
          <div><dt>撤销 / 重做</dt><dd>Ctrl/⌘ + Z / Y</dd></div>
          <div><dt>前 / 后一帧</dt><dd>Alt + ← / →</dd></div>
          <div><dt>打开本帮助</dt><dd>F1</dd></div>
        </dl>
        <div className="dialog-actions">
          <button className="primary-button" type="button" autoFocus onClick={onClose}>关闭</button>
        </div>
      </section>
    </div>
  );
}

function FrameDeleteDialog({
  dialog,
  onCancel,
  onConfirm,
}: {
  readonly dialog: FrameDeleteDialogState;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactNode {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onCancel]);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <form className="roll-dialog" role="dialog" aria-modal="true" aria-labelledby="frame-delete-dialog-title" onSubmit={(event) => {
        event.preventDefault();
        onConfirm();
      }}>
        <div className="dialog-icon is-danger">
          <Trash2 size={18} />
        </div>
        <div className="dialog-copy">
          <h2 id="frame-delete-dialog-title">删除帧？</h2>
          <p>
            “{dialog.label}”将从当前胶卷移除。
            {dialog.isDemo ? "之后仍可新建胶卷获得新的演示帧。" : "磁盘上的源文件不会被删除。"}
          </p>
        </div>
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
          <button className="danger-button" type="submit" autoFocus>删除帧</button>
        </div>
      </form>
    </div>
  );
}

function RollDialog({
  dialog,
  onCancel,
  onConfirm,
}: {
  readonly dialog: RollDialogState;
  readonly onCancel: () => void;
  readonly onConfirm: (title: string) => void;
}): ReactNode {
  const [title, setTitle] = useState(dialog.kind === "delete" ? "" : dialog.initialTitle);
  const normalizedTitle = title.trim();
  const isDelete = dialog.kind === "delete";

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onCancel]);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <form className="roll-dialog" role="dialog" aria-modal="true" aria-labelledby="roll-dialog-title" onSubmit={(event) => {
        event.preventDefault();
        if (isDelete || normalizedTitle.length > 0) onConfirm(normalizedTitle);
      }}>
        <div className={isDelete ? "dialog-icon is-danger" : "dialog-icon"}>
          {isDelete ? <Trash2 size={18} /> : <Film size={18} />}
        </div>
        <div className="dialog-copy">
          <h2 id="roll-dialog-title">
            {dialog.kind === "create" ? "新建胶卷" : dialog.kind === "rename" ? "重命名胶卷" : "删除胶卷？"}
          </h2>
          {isDelete ? (
            <p>“{dialog.rollTitle}”及其工作区记录将被删除。源文件不会从磁盘移除。</p>
          ) : (
            <label>
              胶卷名称
              <input
                autoFocus
                maxLength={80}
                value={title}
                onChange={(event) => setTitle(event.currentTarget.value)}
                placeholder="例如：Portra 400 · 上海"
              />
            </label>
          )}
        </div>
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
          <button
            className={isDelete ? "danger-button" : "primary-button"}
            type="submit"
            disabled={!isDelete && normalizedTitle.length === 0}
          >
            {isDelete ? "删除胶卷" : dialog.kind === "create" ? "创建胶卷" : "保存名称"}
          </button>
        </div>
      </form>
    </div>
  );
}

function createUniqueRollTitle(base: string, rolls: readonly FilmRoll[]): string {
  const names = new Set(rolls.map((roll) => roll.title.trim().toLocaleLowerCase()));
  if (!names.has(base.toLocaleLowerCase())) return base;
  let suffix = 2;
  while (names.has((base + " " + suffix).toLocaleLowerCase())) suffix += 1;
  return base + " " + suffix;
}

function resolveFrames(roll: FilmRoll): readonly WorkspaceFrame[] {
  const assets = new Map(roll.assets.map((asset) => [asset.id, asset]));
  return roll.frameOrder.flatMap((id): readonly WorkspaceFrame[] => {
    if (id === demoFrameId) return [{ id: demoFrameId, kind: "demo" }];
    const asset = assets.get(id);
    return asset === undefined ? [] : [{ id, kind: "asset", asset }];
  });
}

function waitForBackgroundTurn(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => resolve(), { timeout: 500 });
      return;
    }
    window.setTimeout(resolve, 80);
  });
}

function createThumbnailDataUrl(preview: PreviewResult): string {
  if (
    preview.width <= 0
    || preview.height <= 0
    || preview.rgba.length !== preview.width * preview.height * 4
  ) {
    throw new Error("缩略图源像素无效。");
  }
  const maximumWidth = 192;
  const maximumHeight = 128;
  const scale = Math.min(maximumWidth / preview.width, maximumHeight / preview.height, 1);
  const width = Math.max(1, Math.round(preview.width * scale));
  const height = Math.max(1, Math.round(preview.height * scale));
  const thumbnail = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(preview.height - 1, Math.floor((y + 0.5) * preview.height / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(preview.width - 1, Math.floor((x + 0.5) * preview.width / width));
      const sourceOffset = (sourceY * preview.width + sourceX) * 4;
      const targetOffset = (y * width + x) * 4;
      thumbnail[targetOffset] = preview.rgba[sourceOffset];
      thumbnail[targetOffset + 1] = preview.rgba[sourceOffset + 1];
      thumbnail[targetOffset + 2] = preview.rgba[sourceOffset + 2];
      thumbnail[targetOffset + 3] = 255;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (context === null) throw new Error("浏览器无法创建缩略图画布。");
  context.putImageData(new ImageData(thumbnail, width, height), 0, 0);
  return canvas.toDataURL("image/webp", 0.76);
}

function loadLibrarySplit(): number {
  try {
    const saved = Number(window.localStorage.getItem("filmlab.librarySplit"));
    return Number.isFinite(saved) && saved >= 20 && saved <= 72 ? saved : 36;
  } catch {
    return 36;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

async function encodePreviewPng(preview: PreviewResult): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = preview.width;
  canvas.height = preview.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (context === null) {
    throw new Error("浏览器无法创建 PNG 导出画布。");
  }
  const pixels = new ImageData(
    asClampedView(preview.rgba),
    preview.width,
    preview.height,
  );
  context.putImageData(pixels, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value === null) {
        reject(new Error("无法编码 PNG 预览。"));
      } else {
        resolve(value);
      }
    }, "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function makeMasterFileName(
  projectTitle: string,
  sourceName: string | undefined,
  format: MasterExportFormat,
): string {
  const frame = sourceName === undefined
    ? "positive"
    : sourceName.replace(/\.[^.]+$/, "");
  const project = projectTitle.trim() || "filmlab";
  const extension = format === "jpeg" ? "jpg" : format === "heif" ? "avif" : format;
  return project + "-" + frame + "-positive." + extension;
}

function describeMasterExportFormat(format: MasterExportFormat): string {
  switch (format) {
    case "jpeg": return "JPG · 8-bit sRGB 编码 · 质量 95";
    case "heif": return "HEIF（AVIF）· 10-bit sRGB 编码";
    case "dng": return "DNG · 16-bit 线性 sRGB 色彩母版";
    default: return "TIFF · 16-bit sRGB 编码 · ICC · 无损";
  }
}

function resolveActiveColorTrust(mode: PreviewMode, preview: PreviewResult | null): ColorTrust {
  if (mode === "generic") return { level: "uncalibrated", reason: "generic-mode" };
  return preview?.colorTrust.level === "profile-unverified" || preview?.colorTrust.level === "device-matched"
    ? preview.colorTrust
    : { level: "profile-unverified", reason: "calibration-profile-missing" };
}

function describeColorTrust(trust: ColorTrust): string {
  switch (trust.level) {
    case "device-matched": return "设备匹配色彩";
    case "profile-unverified": return "校准配置已应用 · 设备未验证";
    default: return "未设备校准 · 仅显示编码";
  }
}

function describeColorTrustDetail(trust: ColorTrust): string {
  if (trust.level === "device-matched") {
    return "相机型号与 RAW 解码/去马赛克链均匹配当前校准配置，可声明为设备匹配色彩输出。";
  }
  if (trust.level === "uncalibrated") {
    return "默认模式用于浏览和分享，没有相机色彩表征；输出仅采用 sRGB 显示编码。";
  }
  switch (trust.reason) {
    case "camera-mismatch":
      return "已应用校准配置，但源文件相机与配置不匹配，不能声明为设备匹配色彩。";
    case "decoder-mismatch":
      return "已应用校准配置，但 RAW 解码或去马赛克链不匹配，不能声明为设备匹配色彩。";
    case "source-camera-unavailable":
      return "已应用校准配置，但源文件缺少可验证的相机型号，设备匹配状态未知。";
    case "decoder-unavailable":
      return "已应用校准配置，但源文件缺少可验证的解码器指纹，设备匹配状态未知。";
    case "capture-context-unavailable":
      return "已应用校准配置，但配置缺少镜头、片种、冲洗或背光信息，不能声明设备匹配。";
    default:
      return "校准配置已应用，但完整设备匹配条件尚未验证，不能声明颜色准确性。";
  }
}

function asClampedView(source: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  return new Uint8ClampedArray(source.buffer as ArrayBuffer, source.byteOffset, source.byteLength);
}

function fitPreviewCanvas(
  canvas: HTMLCanvasElement,
  logicalWidth: number,
  logicalHeight: number,
): void {
  const parent = canvas.parentElement;
  if (parent === null || parent.clientWidth <= 0 || parent.clientHeight <= 0) return;
  const fit = fitPreviewIntoBounds(
    logicalWidth,
    logicalHeight,
    parent.clientWidth,
    parent.clientHeight,
  );
  const width = Math.round(fit.width * 1_000) / 1_000 + "px";
  const height = Math.round(fit.height * 1_000) / 1_000 + "px";
  if (canvas.style.width !== width) canvas.style.width = width;
  if (canvas.style.height !== height) canvas.style.height = height;
  if (canvas.style.aspectRatio !== "") canvas.style.aspectRatio = "";
}

function updateCropBounds(
  canvas: HTMLCanvasElement,
  setBounds: Dispatch<SetStateAction<CropBounds | null>>,
): void {
  const parent = canvas.parentElement;
  if (parent === null) return;
  const canvasRect = canvas.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  const next: CropBounds = {
    left: canvasRect.left - parentRect.left,
    top: canvasRect.top - parentRect.top,
    width: canvasRect.width,
    height: canvasRect.height,
  };
  setBounds((current) => (
    current !== null
    && Math.abs(current.left - next.left) < 0.05
    && Math.abs(current.top - next.top) < 0.05
    && Math.abs(current.width - next.width) < 0.05
    && Math.abs(current.height - next.height) < 0.05
      ? current
      : next
  ));
}

function PreviewCanvas({
  preview,
  displaySize,
  fitRevision,
  tone,
  mode,
  view,
  processing,
  crop,
  cropEditing,
  baseRoi,
  baseSampling,
  baseSamplingPurpose,
  dmaxRoi,
  straightenDrawing,
  currentStraightenDegrees,
  onRenderBackendChange,
  onCropChange,
  onCropDone,
  onBaseRoiChange,
  onDmaxRoiChange,
  onBaseDone,
  onStraightenCommit,
  onStraightenInvalid,
}: {
  readonly preview: PreviewResult;
  readonly displaySize: PreviewDisplaySize;
  readonly fitRevision: number;
  readonly tone: ToneState;
  readonly mode: PreviewMode;
  readonly view: PreviewView;
  readonly processing: ProcessingRecipe;
  readonly crop?: NonNullable<ProcessingRecipe["geometry"]["crop"]>;
  readonly cropEditing: boolean;
  readonly baseRoi: ProcessingRecipe["baseRoi"];
  readonly baseSampling: boolean;
  readonly baseSamplingPurpose: "density" | "white-balance" | "dmax";
  readonly dmaxRoi: ProcessingRecipe["baseRoi"];
  readonly straightenDrawing: boolean;
  readonly currentStraightenDegrees: number;
  readonly onRenderBackendChange: (backend: PreviewRenderBackend, hasLinearScene: boolean) => void;
  readonly onCropChange: (crop: NonNullable<ProcessingRecipe["geometry"]["crop"]>) => void;
  readonly onCropDone: () => void;
  readonly onBaseRoiChange: (roi: ProcessingRecipe["baseRoi"]) => void;
  readonly onDmaxRoiChange: (roi: ProcessingRecipe["baseRoi"]) => void;
  readonly onBaseDone: () => void;
  readonly onStraightenCommit: (result: StraightenReferenceResult) => void;
  readonly onStraightenInvalid: () => void;
}): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<PreviewCanvasRenderer | null>(null);
  const displaySizeRef = useRef(displaySize);
  const [renderBackend, setRenderBackend] = useState<PreviewRenderBackend>("2d");
  const [cropBounds, setCropBounds] = useState<CropBounds | null>(null);
  const [viewportRevision, setViewportRevision] = useState(0);
  displaySizeRef.current = displaySize;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const renderer = rendererRef.current ?? createPreviewCanvasRenderer(canvas);
    rendererRef.current = renderer;
    const backend = renderer.render({
      width: preview.width,
      height: preview.height,
      rgba: preview.rgba,
      sceneLinear: preview.sceneLinear,
      displayWhitePoint: preview.displayWhitePoint,
      gpuPipeline: preview.gpuPipeline,
      processing,
      mode,
      view,
      tone,
    });
    fitPreviewCanvas(canvas, displaySize.width, displaySize.height);
    updateCropBounds(canvas, setCropBounds);
    setRenderBackend(backend);
    onRenderBackendChange(
      backend,
      preview.sceneLinear !== undefined || preview.gpuPipeline !== undefined,
    );
  }, [
    displaySize.height,
    displaySize.width,
    mode,
    onRenderBackendChange,
    preview,
    processing,
    tone,
    view,
    viewportRevision,
  ]);

  useEffect(() => () => {
    rendererRef.current?.dispose();
    rendererRef.current = null;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (canvas === null || canvas === undefined || parent === null || parent === undefined) return;
    let previousWidth = parent.clientWidth;
    let previousHeight = parent.clientHeight;
    const updateLayout = (): void => {
      const nextWidth = parent.clientWidth;
      const nextHeight = parent.clientHeight;
      fitPreviewCanvas(
        canvas,
        displaySizeRef.current.width,
        displaySizeRef.current.height,
      );
      updateCropBounds(canvas, setCropBounds);
      if (
        Math.abs(nextWidth - previousWidth) >= 1
        || Math.abs(nextHeight - previousHeight) >= 1
      ) {
        previousWidth = nextWidth;
        previousHeight = nextHeight;
        setViewportRevision((current) => current + 1);
      }
    };
    const observer = new ResizeObserver(updateLayout);
    observer.observe(parent);
    updateLayout();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    fitPreviewCanvas(canvas, displaySize.width, displaySize.height);
    updateCropBounds(canvas, setCropBounds);
  }, [displaySize.height, displaySize.width, fitRevision]);

  return (
    <>
      <canvas
        className="preview-canvas"
        ref={canvasRef}
        data-render-backend={renderBackend}
        data-logical-width={displaySize.width}
        data-logical-height={displaySize.height}
        data-fit-revision={fitRevision}
        title={renderBackend === "webgl2-pipeline"
          ? "GPU 全管线预览"
          : renderBackend === "webgl2-linear"
            ? "GPU 线性色调预览"
          : renderBackend === "webgl2"
            ? "GPU 显示预览"
            : "兼容预览"}
        aria-label="胶片处理预览"
      />
      {cropEditing && crop !== undefined && cropBounds !== null ? (
        <CropOverlay
          bounds={cropBounds}
          crop={crop}
          sourceWidth={displaySize.width}
          sourceHeight={displaySize.height}
          onChange={onCropChange}
          onDone={onCropDone}
        />
      ) : null}
      {baseSampling && cropBounds !== null ? (
        <BaseRoiOverlay
          bounds={cropBounds}
          roi={baseSamplingPurpose === "dmax" ? dmaxRoi : baseRoi}
          purpose={baseSamplingPurpose}
          sourceWidth={displaySize.width}
          sourceHeight={displaySize.height}
          onChange={baseSamplingPurpose === "dmax" ? onDmaxRoiChange : onBaseRoiChange}
          onDone={onBaseDone}
        />
      ) : null}
      {straightenDrawing && cropBounds !== null ? (
        <StraightenRulerOverlay
          bounds={cropBounds}
          currentStraightenDegrees={currentStraightenDegrees}
          onCommit={onStraightenCommit}
          onInvalid={onStraightenInvalid}
        />
      ) : null}
    </>
  );
}

function StraightenRulerOverlay({
  bounds,
  currentStraightenDegrees,
  onCommit,
  onInvalid,
}: {
  readonly bounds: CropBounds;
  readonly currentStraightenDegrees: number;
  readonly onCommit: (result: StraightenReferenceResult) => void;
  readonly onInvalid: () => void;
}): ReactNode {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [line, setLine] = useState<{ readonly start: RulerPoint; readonly end: RulerPoint } | null>(null);
  const lineRef = useRef<{ readonly start: RulerPoint; readonly end: RulerPoint } | null>(null);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const pointFromEvent = (event: ReactPointerEvent<HTMLDivElement>): RulerPoint => {
    const rectangle = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp(event.clientX - rectangle.left, 0, rectangle.width),
      y: clamp(event.clientY - rectangle.top, 0, rectangle.height),
    };
  };
  const begin = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    lineRef.current = { start: point, end: point };
    setLine(lineRef.current);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = lineRef.current;
    if (current === null) return;
    event.preventDefault();
    lineRef.current = { start: current.start, end: pointFromEvent(event) };
    setLine(lineRef.current);
  };
  const finish = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = lineRef.current;
    if (current === null) return;
    event.preventDefault();
    const completed = { start: current.start, end: pointFromEvent(event) };
    lineRef.current = null;
    setLine(null);
    const result = straightenFromReferenceLine(completed.start, completed.end, currentStraightenDegrees);
    if (result === undefined) onInvalid();
    else onCommit(result);
  };
  const cancel = (): void => {
    lineRef.current = null;
    setLine(null);
  };

  const result = line === null
    ? undefined
    : straightenFromReferenceLine(line.start, line.end, currentStraightenDegrees);
  const rootStyle: CSSProperties = {
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
  };
  const labelStyle: CSSProperties | undefined = line === null
    ? undefined
    : {
        left: (line.start.x + line.end.x) * 0.5,
        top: (line.start.y + line.end.y) * 0.5,
      };

  return (
    <div
      ref={rootRef}
      className="straighten-ruler-overlay"
      style={rootStyle}
      tabIndex={0}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={cancel}
      aria-label="拖动绘制水平或垂直拉直参考线"
    >
      {line === null ? null : (
        <>
          <svg className="straighten-ruler-line" viewBox={`0 0 ${bounds.width} ${bounds.height}`} preserveAspectRatio="none" aria-hidden="true">
            <line x1={line.start.x} y1={line.start.y} x2={line.end.x} y2={line.end.y} />
            <circle cx={line.start.x} cy={line.start.y} r="4" />
            <circle cx={line.end.x} cy={line.end.y} r="4" />
          </svg>
          <span className="straighten-ruler-angle" style={labelStyle}>
            {result === undefined
              ? "继续拖动"
              : (result.axis === "horizontal" ? "水平参考" : "垂直参考") + " · " + Math.abs(result.lineAngleDegrees).toFixed(1) + "°"}
          </span>
        </>
      )}
      <span className="straighten-ruler-hint"><Ruler size={13} /> 沿应当水平或垂直的边缘拖线</span>
    </div>
  );
}

function BaseRoiOverlay({
  bounds,
  roi,
  purpose,
  sourceWidth,
  sourceHeight,
  onChange,
  onDone,
}: {
  readonly bounds: CropBounds;
  readonly roi: ProcessingRecipe["baseRoi"];
  readonly purpose: "density" | "white-balance" | "dmax";
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly onChange: (roi: ProcessingRecipe["baseRoi"]) => void;
  readonly onDone: () => void;
}): ReactNode {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState(roi);
  const draftRef = useRef(roi);
  const dragRef = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const paintFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (dragRef.current !== null) return;
    setDraft(roi);
    draftRef.current = roi;
  }, [roi]);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => () => {
    if (paintFrameRef.current !== null) window.cancelAnimationFrame(paintFrameRef.current);
  }, []);

  const scheduleDraftPaint = (next: ProcessingRecipe["baseRoi"]): void => {
    draftRef.current = next;
    if (paintFrameRef.current !== null) return;
    paintFrameRef.current = window.requestAnimationFrame(() => {
      paintFrameRef.current = null;
      setDraft(draftRef.current);
    });
  };

  const pointerPosition = (event: ReactPointerEvent<HTMLDivElement>): { readonly x: number; readonly y: number } => {
    const rectangle = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rectangle.left) / Math.max(1, rectangle.width), 0, 1),
      y: clamp((event.clientY - rectangle.top) / Math.max(1, rectangle.height), 0, 1),
    };
  };
  const beginSelection = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointerPosition(event);
    dragRef.current = point;
    const next = boundedRoi({ x: point.x, y: point.y, width: 0.01, height: 0.01 });
    scheduleDraftPaint(next);
  };
  const moveSelection = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = dragRef.current;
    if (start === null) return;
    event.preventDefault();
    const point = pointerPosition(event);
    const minimumWidth = Math.min(0.08, 8 / Math.max(1, sourceWidth));
    const minimumHeight = Math.min(0.08, 8 / Math.max(1, sourceHeight));
    const left = Math.min(start.x, point.x);
    const top = Math.min(start.y, point.y);
    const next = boundedRoi({
      x: left,
      y: top,
      width: Math.max(minimumWidth, Math.abs(point.x - start.x)),
      height: Math.max(minimumHeight, Math.abs(point.y - start.y)),
    });
    scheduleDraftPaint(next);
  };
  const finishSelection = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === null) return;
    event.preventDefault();
    dragRef.current = null;
    if (paintFrameRef.current !== null) {
      window.cancelAnimationFrame(paintFrameRef.current);
      paintFrameRef.current = null;
      setDraft(draftRef.current);
    }
    onChange(draftRef.current);
  };

  const rootStyle: CSSProperties = {
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
  };
  const roiStyle: CSSProperties = {
    left: draft.x * 100 + "%",
    top: draft.y * 100 + "%",
    width: draft.width * 100 + "%",
    height: draft.height * 100 + "%",
  };

  return (
    <div
      ref={rootRef}
      className="base-roi-overlay"
      style={rootStyle}
      tabIndex={0}
      onPointerDown={beginSelection}
      onPointerMove={moveSelection}
      onPointerUp={finishSelection}
      onPointerCancel={finishSelection}
      onDoubleClick={onDone}
      aria-label={purpose === "white-balance"
        ? "在裁切画面中拖动选择白平衡片基"
        : purpose === "dmax"
          ? "在裁切画面中拖动选择手动 Dmax 区域"
          : "在裁切画面中拖动选择未曝光片基"}
    >
      <div className="base-roi-box" style={roiStyle}>
        <span className="base-roi-label">
          {purpose === "white-balance" ? "白平衡片基" : purpose === "dmax" ? "手动 Dmax" : "Dmin 片基"} · {Math.max(1, Math.round(sourceWidth * draft.width))} × {Math.max(1, Math.round(sourceHeight * draft.height))}
        </span>
      </div>
      <span className="base-roi-hint">
        {purpose === "white-balance"
          ? "拖出均匀、未曝光的片基以中和底色"
          : purpose === "dmax"
            ? "拖出包含最高密度细节的区域作为整卷 Dmax 参考"
            : "拖出均匀、未曝光的片基区域"}
      </span>
    </div>
  );
}

function CropOverlay({
  bounds,
  crop,
  sourceWidth,
  sourceHeight,
  onChange,
  onDone,
}: {
  readonly bounds: CropBounds;
  readonly crop: NonNullable<ProcessingRecipe["geometry"]["crop"]>;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly onChange: (crop: NonNullable<ProcessingRecipe["geometry"]["crop"]>) => void;
  readonly onDone: () => void;
}): ReactNode {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState(crop);
  const draftRef = useRef(crop);
  const dragRef = useRef<{
    readonly handle: CropHandle;
    readonly startX: number;
    readonly startY: number;
    readonly crop: NonNullable<ProcessingRecipe["geometry"]["crop"]>;
  } | null>(null);
  const paintFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (dragRef.current !== null) return;
    setDraft(crop);
    draftRef.current = crop;
  }, [crop]);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => () => {
    if (paintFrameRef.current !== null) window.cancelAnimationFrame(paintFrameRef.current);
  }, []);

  const scheduleDraftPaint = (next: NonNullable<ProcessingRecipe["geometry"]["crop"]>): void => {
    draftRef.current = next;
    if (paintFrameRef.current !== null) return;
    paintFrameRef.current = window.requestAnimationFrame(() => {
      paintFrameRef.current = null;
      setDraft(draftRef.current);
    });
  };

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, handle: CropHandle): void => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { handle, startX: event.clientX, startY: event.clientY, crop: draftRef.current };
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = dragRef.current;
    if (active === null) return;
    event.preventDefault();
    const next = resizeCrop(
      active.crop,
      active.handle,
      (event.clientX - active.startX) / bounds.width,
      (event.clientY - active.startY) / bounds.height,
      Math.min(0.2, 32 / bounds.width),
      Math.min(0.2, 32 / bounds.height),
    );
    scheduleDraftPaint(next);
  };
  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === null) return;
    event.preventDefault();
    dragRef.current = null;
    if (paintFrameRef.current !== null) {
      window.cancelAnimationFrame(paintFrameRef.current);
      paintFrameRef.current = null;
      setDraft(draftRef.current);
    }
    onChange(draftRef.current);
  };
  const moveWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const directions: Record<string, readonly [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (direction === undefined) return;
    event.preventDefault();
    const distance = event.shiftKey ? 10 : 1;
    const next = resizeCrop(
      draftRef.current,
      "move",
      direction[0] * distance / Math.max(1, sourceWidth),
      direction[1] * distance / Math.max(1, sourceHeight),
      Math.min(0.2, 32 / bounds.width),
      Math.min(0.2, 32 / bounds.height),
    );
    draftRef.current = next;
    setDraft(next);
    onChange(next);
  };

  const left = draft.x * 100;
  const top = draft.y * 100;
  const right = (draft.x + draft.width) * 100;
  const bottom = (draft.y + draft.height) * 100;
  const rootStyle: CSSProperties = {
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
  };
  const cropStyle: CSSProperties = { left: left + "%", top: top + "%", width: draft.width * 100 + "%", height: draft.height * 100 + "%" };
  const handles: readonly CropHandle[] = ["north-west", "north", "north-east", "east", "south-east", "south", "south-west", "west"];

  return (
    <div
      ref={rootRef}
      className="crop-editor-overlay"
      style={rootStyle}
      tabIndex={0}
      onKeyDown={moveWithKeyboard}
      onPointerMove={moveDrag}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      aria-label="拖动裁切区域"
    >
      <span className="crop-shade crop-shade-top" style={{ height: top + "%" }} />
      <span className="crop-shade crop-shade-bottom" style={{ top: bottom + "%" }} />
      <span className="crop-shade crop-shade-left" style={{ top: top + "%", width: left + "%", height: draft.height * 100 + "%" }} />
      <span className="crop-shade crop-shade-right" style={{ top: top + "%", left: right + "%", height: draft.height * 100 + "%" }} />
      <div
        className="crop-box"
        style={cropStyle}
        onPointerDown={(event) => beginDrag(event, "move")}
        onDoubleClick={onDone}
      >
        <span className="crop-grid crop-grid-v crop-grid-one" />
        <span className="crop-grid crop-grid-v crop-grid-two" />
        <span className="crop-grid crop-grid-h crop-grid-one" />
        <span className="crop-grid crop-grid-h crop-grid-two" />
        <span className="crop-size">
          {Math.max(1, Math.round(sourceWidth * draft.width))} × {Math.max(1, Math.round(sourceHeight * draft.height))}
        </span>
        {handles.map((handle) => (
          <button
            className={"crop-handle crop-handle-" + handle}
            type="button"
            aria-label={cropHandleLabel(handle)}
            onPointerDown={(event) => beginDrag(event, handle)}
            key={handle}
          />
        ))}
      </div>
    </div>
  );
}

function InspectorSection({
  title,
  children,
  defaultOpen = false,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={open ? "inspector-section is-open" : "inspector-section"}>
      <button className="section-toggle" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span>{title}</span>
        <ChevronDown size={15} />
      </button>
      {open ? <div className="section-content">{children}</div> : null}
    </section>
  );
}

function ModeButton({
  active,
  label,
  detail,
  onClick,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly detail: string;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <button className={active ? "mode-button is-selected" : "mode-button"} type="button" aria-pressed={active} onClick={onClick}>
      <span className="radio-indicator" />
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </button>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly display: string;
  readonly onChange: (value: number) => void;
}): ReactNode {
  return (
    <label className="slider-control">
      <span>
        <span>{label}</span>
        <output>{display}</output>
      </span>
      <input
        type="range"
        aria-label={label}
        aria-valuetext={display}
        value={value}
        min={min}
        max={max}
        step={step}
        onInput={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

function RestorationInspector({
  processing,
  onBegin,
  onUpdate,
}: {
  readonly processing: ProcessingRecipe;
  /** Records one undo snapshot per drag interaction, not per input tick. */
  readonly onBegin: () => void;
  readonly onUpdate: (update: (current: ProcessingRecipe) => ProcessingRecipe) => void;
}): ReactNode {
  const restoration = processing.restoration;
  const setToggle = (key: "dust" | "scratches", enabled: boolean): void => {
    onBegin();
    onUpdate((current) => ({
      ...current,
      restoration: { ...current.restoration, [key]: enabled },
    }));
  };
  return (
    <div className="mode-stack">
      <label className="pending-row"><span>自动除尘</span><input type="checkbox" checked={restoration.dust} onChange={(event) => setToggle("dust", event.currentTarget.checked)} /></label>
      <label className="pending-row"><span>划痕修复</span><input type="checkbox" checked={restoration.scratches} onChange={(event) => setToggle("scratches", event.currentTarget.checked)} /></label>
      <InteractiveSlider label="保边降噪" value={restoration.denoise} min={0} max={1} step={0.05} display={(value) => value.toFixed(2)} onBegin={onBegin} onPreview={(value) => onUpdate((current) => ({ ...current, restoration: { ...current.restoration, denoise: value } }))} onCommit={(value) => onUpdate((current) => ({ ...current, restoration: { ...current.restoration, denoise: value } }))} onCancel={(value) => onUpdate((current) => ({ ...current, restoration: { ...current.restoration, denoise: value } }))} />
      <InteractiveSlider label="锐化" value={restoration.sharpen} min={0} max={2} step={0.05} display={(value) => value.toFixed(2)} onBegin={onBegin} onPreview={(value) => onUpdate((current) => ({ ...current, restoration: { ...current.restoration, sharpen: value } }))} onCommit={(value) => onUpdate((current) => ({ ...current, restoration: { ...current.restoration, sharpen: value } }))} onCancel={(value) => onUpdate((current) => ({ ...current, restoration: { ...current.restoration, sharpen: value } }))} />
    </div>
  );
}

function InteractiveSlider({
  label,
  value,
  min,
  max,
  step,
  display,
  onBegin,
  onPreview,
  onCommit,
  onCancel,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly display: (value: number) => string;
  readonly onBegin?: (value: number) => void;
  readonly onPreview: (value: number) => void;
  readonly onCommit: (value: number) => void;
  readonly onCancel: (value: number) => void;
}): ReactNode {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const originRef = useRef(value);
  const interactingRef = useRef(false);
  const previewFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (interactingRef.current) return;
    draftRef.current = value;
    setDraft(value);
  }, [value]);

  useEffect(() => () => {
    if (previewFrameRef.current !== null) window.cancelAnimationFrame(previewFrameRef.current);
  }, []);

  const begin = (): void => {
    if (interactingRef.current) return;
    interactingRef.current = true;
    originRef.current = value;
    draftRef.current = value;
    setDraft(value);
    onBegin?.(value);
  };
  const update = (next: number): void => {
    begin();
    draftRef.current = next;
    setDraft(next);
    if (previewFrameRef.current === null) {
      previewFrameRef.current = window.requestAnimationFrame(() => {
        previewFrameRef.current = null;
        onPreview(draftRef.current);
      });
    }
  };
  const commit = (): void => {
    if (!interactingRef.current) return;
    interactingRef.current = false;
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    onCommit(draftRef.current);
  };
  const cancel = (): void => {
    if (!interactingRef.current) return;
    interactingRef.current = false;
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    draftRef.current = originRef.current;
    setDraft(originRef.current);
    onCancel(originRef.current);
  };

  return (
    <label className="slider-control interactive-slider">
      <span>
        <span>{label}</span>
        <output>{display(draft)}</output>
      </span>
      <input
        type="range"
        aria-label={label}
        aria-valuetext={display(draft)}
        value={draft}
        min={min}
        max={max}
        step={step}
        onPointerDown={begin}
        onPointerUp={commit}
        onPointerCancel={cancel}
        onKeyUp={commit}
        onBlur={commit}
        onInput={(event) => update(Number(event.currentTarget.value))}
      />
    </label>
  );
}

function ProcessingInspector({
  processing,
  previewAvailable,
  cropEditing,
  geometryTask,
  straightenDrawing,
  onCropEditingChange,
  onAutoCrop,
  onStraightenDrawingChange,
  onChange,
}: {
  readonly processing: ProcessingRecipe;
  readonly previewAvailable: boolean;
  readonly cropEditing: boolean;
  readonly geometryTask: GeometryTask;
  readonly straightenDrawing: boolean;
  readonly onCropEditingChange: (editing: boolean) => void;
  readonly onAutoCrop: () => void;
  readonly onStraightenDrawingChange: (drawing: boolean) => void;
  readonly onChange: (update: (current: ProcessingRecipe) => ProcessingRecipe) => void;
}): ReactNode {
  const geometry = processing.geometry;
  const setBase = (key: "x" | "y" | "width" | "height", value: number): void => {
    onChange((current) => ({ ...current, baseRoi: boundedRoi({ ...current.baseRoi, [key]: value }) }));
  };
  const setCrop = (enabled: boolean): void => {
    if (enabled) {
      onCropEditingChange(true);
      return;
    }
    onChange((current) => ({ ...current, geometry: { ...current.geometry, crop: undefined } }));
    onCropEditingChange(false);
  };
  const setPerspective = (enabled: boolean): void => onChange((current) => ({
    ...current,
    geometry: {
      ...current.geometry,
      perspective: enabled ? (current.geometry.perspective ?? defaultPerspective()) : undefined,
    },
  }));
  const updateCorner = (corner: keyof NonNullable<ProcessingRecipe["geometry"]["perspective"]>, axis: "x" | "y", value: number): void => onChange((current) => {
    const perspective = current.geometry.perspective ?? defaultPerspective();
    return {
      ...current,
      geometry: {
        ...current.geometry,
        perspective: { ...perspective, [corner]: { ...perspective[corner], [axis]: clampUnit(value) } },
      },
    };
  });
  const setRotation = (rotation: 0 | 90 | 180 | 270): void => {
    onChange((current) => ({
      ...current,
      geometry: { ...current.geometry, rotation },
    }));
  };
  return (
    <div className="mode-stack">
      <label className="slider-control">
        <span><span>方向</span><output>{geometry.rotation}°</output></span>
        <select aria-label="方向" value={geometry.rotation} onChange={(event) => setRotation(Number(event.currentTarget.value) as 0 | 90 | 180 | 270)}>
          <option value={0}>0°</option><option value={90}>90°</option><option value={180}>180°</option><option value={270}>270°</option>
        </select>
      </label>
      <div className="geometry-actions">
        <button
          className={straightenDrawing ? "secondary-button is-selected" : "secondary-button"}
          type="button"
          aria-pressed={straightenDrawing}
          disabled={!previewAvailable || geometryTask !== null}
          onClick={() => onStraightenDrawingChange(!straightenDrawing)}
        >
          <Ruler size={14} />
          {straightenDrawing ? "取消拉直" : "直尺拉直 · " + (geometry.straighten ?? 0).toFixed(2) + "°"}
        </button>
        <button className="secondary-button" type="button" aria-busy={geometryTask === "crop"} disabled={!previewAvailable || geometryTask !== null} onClick={onAutoCrop}>
          <Crop size={14} />
          {geometryTask === "crop" ? "识别中…" : "自动裁切"}
        </button>
        <button className="secondary-button" type="button" disabled={Math.abs(geometry.straighten ?? 0) < 0.001} onClick={() => onChange((current) => ({ ...current, geometry: { ...current.geometry, straighten: 0 } }))}>
          <RotateCcw size={14} />
          重置角度
        </button>
        <button className="secondary-button" type="button" disabled={geometry.crop === undefined} onClick={() => {
          onChange((current) => ({ ...current, geometry: { ...current.geometry, crop: undefined } }));
          onCropEditingChange(false);
        }}>
          <Crop size={14} />
          重置裁切
        </button>
      </div>
      <div className="crop-control-row">
        <label className="pending-row">
          <span>裁切</span>
          <input type="checkbox" checked={geometry.crop !== undefined} onChange={(event) => setCrop(event.currentTarget.checked)} />
        </label>
        <button className={cropEditing ? "compact-tool is-selected" : "compact-tool"} type="button" aria-pressed={cropEditing} disabled={geometry.crop === undefined} onClick={() => onCropEditingChange(!cropEditing)}>
          {cropEditing ? <Check size={13} /> : <Crop size={13} />}
          {cropEditing ? "完成" : "编辑裁切"}
        </button>
      </div>
      {geometry.crop === undefined ? null : (
        <p className="section-note crop-summary">
          保留宽度 {(geometry.crop.width * 100).toFixed(1)}% · 高度 {(geometry.crop.height * 100).toFixed(1)}% · 方向键微移，Shift 加速
        </p>
      )}
      <label className="pending-row"><span>透视校正</span><input type="checkbox" checked={geometry.perspective !== undefined} onChange={(event) => setPerspective(event.currentTarget.checked)} /></label>
      <label className="pending-row" title="仅在确实保留中性高密度片段时启用；否则可能把主体高光误当作中性参考。"><span>自动中和 Dmax</span><input type="checkbox" checked={processing.autoNeutralDmax === true} onChange={(event) => onChange((current) => ({ ...current, autoNeutralDmax: event.currentTarget.checked }))} /></label>
      {geometry.perspective === undefined ? null : (
        <details className="section-note">
          <summary>调整四角</summary>
          {(["topLeft", "topRight", "bottomRight", "bottomLeft"] as const).map((corner) => (
            <div className="metric-row" key={corner}>
              <span>{corner}</span>
              <input aria-label={corner + " x"} type="number" min={0} max={1} step={0.01} value={geometry.perspective?.[corner].x ?? 0} onChange={(event) => updateCorner(corner, "x", Number(event.currentTarget.value))} />
              <input aria-label={corner + " y"} type="number" min={0} max={1} step={0.01} value={geometry.perspective?.[corner].y ?? 0} onChange={(event) => updateCorner(corner, "y", Number(event.currentTarget.value))} />
            </div>
          ))}
        </details>
      )}
      <details className="advanced-geometry">
        <summary>片基 ROI（高级）</summary>
        <NumberRow label="X" value={processing.baseRoi.x} min={0} max={0.99} step={0.01} onChange={(value) => setBase("x", value)} />
        <NumberRow label="Y" value={processing.baseRoi.y} min={0} max={0.99} step={0.01} onChange={(value) => setBase("y", value)} />
        <NumberRow label="宽" value={processing.baseRoi.width} min={0.01} max={1} step={0.01} onChange={(value) => setBase("width", value)} />
        <NumberRow label="高" value={processing.baseRoi.height} min={0.01} max={1} step={0.01} onChange={(value) => setBase("height", value)} />
      </details>
    </div>
  );
}

function NumberRow({ label, value, min, max, step, onChange }: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly onChange: (value: number) => void;
}): ReactNode {
  return <label className="metric-row"><span>{label}</span><input type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.currentTarget.value))} /></label>;
}

function defaultPerspective(): NonNullable<ProcessingRecipe["geometry"]["perspective"]> {
  return {
    topLeft: { x: 0, y: 0 }, topRight: { x: 1, y: 0 },
    bottomRight: { x: 1, y: 1 }, bottomLeft: { x: 0, y: 1 },
  };
}

function resizeCrop(
  crop: NonNullable<ProcessingRecipe["geometry"]["crop"]>,
  handle: CropHandle,
  deltaX: number,
  deltaY: number,
  minimumWidth: number,
  minimumHeight: number,
): NonNullable<ProcessingRecipe["geometry"]["crop"]> {
  if (handle === "move") {
    return {
      ...crop,
      x: clamp(crop.x + deltaX, 0, 1 - crop.width),
      y: clamp(crop.y + deltaY, 0, 1 - crop.height),
    };
  }

  let left = crop.x;
  let top = crop.y;
  let right = crop.x + crop.width;
  let bottom = crop.y + crop.height;
  if (handle.includes("west")) left = clamp(left + deltaX, 0, right - minimumWidth);
  if (handle.includes("east")) right = clamp(right + deltaX, left + minimumWidth, 1);
  if (handle.includes("north")) top = clamp(top + deltaY, 0, bottom - minimumHeight);
  if (handle.includes("south")) bottom = clamp(bottom + deltaY, top + minimumHeight, 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function cropHandleLabel(handle: CropHandle): string {
  const labels: Record<CropHandle, string> = {
    move: "移动裁切区域",
    north: "调整裁切上边",
    south: "调整裁切下边",
    east: "调整裁切右边",
    west: "调整裁切左边",
    "north-east": "调整裁切右上角",
    "north-west": "调整裁切左上角",
    "south-east": "调整裁切右下角",
    "south-west": "调整裁切左下角",
  };
  return labels[handle];
}

function boundedRoi(value: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }) {
  const x = clamp(value.x, 0, 0.999);
  const y = clamp(value.y, 0, 0.999);
  return {
    x,
    y,
    width: Math.max(0.001, Math.min(1 - x, Number.isFinite(value.width) ? value.width : 1)),
    height: Math.max(0.001, Math.min(1 - y, Number.isFinite(value.height) ? value.height : 1)),
  };
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function cloneDefaultProcessing(): ProcessingRecipe {
  return cloneProcessing(defaultProcessingRecipe);
}

const maximumCachedGpuSources = 2;

interface GpuSourceCacheEntry {
  readonly sourceBayer?: Uint16Array;
  readonly sourceLinear?: Float32Array;
  readonly bayerPattern?: GpuPipelinePayload["bayerPattern"];
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

/** Remembers a full-resolution GPU source payload (when it carries pixel
 * arrays) under its sourceKey, evicting the least recently used entry. */
function storeGpuSourcePayload(cache: Map<string, GpuSourceCacheEntry>, payload: GpuPipelinePayload): void {
  if (payload.sourceBayer === undefined && payload.sourceLinear === undefined) return;
  const entry: GpuSourceCacheEntry = {
    sourceBayer: payload.sourceBayer,
    sourceLinear: payload.sourceLinear,
    bayerPattern: payload.bayerPattern,
    sourceWidth: payload.sourceWidth,
    sourceHeight: payload.sourceHeight,
  };
  cache.delete(payload.sourceKey);
  cache.set(payload.sourceKey, entry);
  while (cache.size > maximumCachedGpuSources) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

/** Fills the pixel arrays of a payload whose worker skipped them (reuse-key
 * hit) from the renderer-side cache. Returns the payload unchanged when it
 * already carries arrays or no cache entry exists. */
function spliceGpuSourcePayload(cache: Map<string, GpuSourceCacheEntry>, payload: GpuPipelinePayload): GpuPipelinePayload {
  if (payload.sourceBayer !== undefined || payload.sourceLinear !== undefined) return payload;
  const entry = cache.get(payload.sourceKey);
  if (entry === undefined) return payload;
  return {
    ...payload,
    sourceBayer: entry.sourceBayer,
    sourceLinear: entry.sourceLinear,
    bayerPattern: entry.bayerPattern,
  };
}

function cloneProcessing(value: ProcessingRecipe): ProcessingRecipe {
  return {
    baseRoi: { ...value.baseRoi },
    filmBase: value.filmBase === undefined
      ? undefined
      : value.filmBase.kind === "automatic"
        ? { kind: "automatic" }
        : {
            ...value.filmBase,
            rgb: [...value.filmBase.rgb] as [number, number, number],
          },
    geometry: {
      ...value.geometry,
      crop: value.geometry.crop === undefined ? undefined : { ...value.geometry.crop },
      perspective: value.geometry.perspective === undefined ? undefined : {
        topLeft: { ...value.geometry.perspective.topLeft }, topRight: { ...value.geometry.perspective.topRight },
        bottomRight: { ...value.geometry.perspective.bottomRight }, bottomLeft: { ...value.geometry.perspective.bottomLeft },
      },
    },
    restoration: { ...value.restoration },
    channelGains: value.channelGains === undefined
      ? undefined
      : [...value.channelGains] as [number, number, number],
    autoNeutralDmax: value.autoNeutralDmax,
    preSaturation: value.preSaturation,
  };
}

function cloneProjectRecipe(value: ProjectRecipe): ProjectRecipe {
  return {
    mode: value.mode,
    view: value.view,
    tone: { ...value.tone },
    calibrationProfileId: value.calibrationProfileId,
    processing: cloneProcessing(value.processing),
  };
}

function describeFrame(roll: FilmRoll, frameId: string): string {
  const index = roll.frameOrder.indexOf(frameId);
  const position = index < 0 ? "—" : String(index + 1).padStart(2, "0");
  if (frameId === demoFrameId) return position + " · 演示负片";
  const asset = roll.assets.find((item) => item.id === frameId);
  return position + " · " + (asset?.name ?? "未知帧");
}
