import { NEGADOCTOR_56_BW_PRESET, NEGADOCTOR_56_COLOR_PRESET } from "../../core/index.ts";
import type { NegadoctorRecipe, Recipe, RecipePatch, Rgb } from "../../core/index.ts";
import { RadioGroup, Section, Slider } from "./ui.tsx";
import type { DrawMode } from "./renderer-types.ts";

export function AdjustmentPanel({ recipe, mode, frameCount, baseLabel, baseDetail, update, switchEngine, autoTune, setMode, applyRecipeToAll, showToast }: {
  recipe: Recipe;
  mode: DrawMode;
  frameCount: number;
  baseLabel: string;
  baseDetail: string;
  update: (patch: RecipePatch) => void;
  switchEngine: (engine: Recipe["engine"]) => void;
  autoTune: () => void;
  setMode: (mode: DrawMode) => void;
  applyRecipeToAll: () => void;
  showToast: (message: string) => void;
}) {
  return <aside className="panel" aria-label="调整参数">
    <header className="panel-header">
      <div>
        <h1>调整</h1>
        <p>{recipe.engine === "classic" ? "FilmLab 经典处理" : "相纸反相 5.6"}</p>
      </div>
      <span className="panel-count">{frameCount > 1 ? `${frameCount} 帧` : "单帧"}</span>
    </header>
    {frameCount > 1 && <Section title="整卷">
      <button className="btn" onClick={applyRecipeToAll}>应用到整卷</button>
      <p className="field-note">把当前帧的完整配方复制给整卷(跳过的帧除外)。</p>
    </Section>}
    <Section title="处理引擎">
      <RadioGroup value={recipe.engine} onChange={switchEngine} options={[
        { value: "classic", label: "FilmLab 经典" },
        { value: "negadoctor-5.6", label: "相纸反相 5.6" },
      ]} />
      <p className="field-note">{recipe.engine === "classic" ? "保持原有项目和输出。" : "参数语义冻结到 darktable negadoctor 5.6.0。"}</p>
    </Section>
    <Section title="几何">
      <button className={`btn${mode === "straighten" ? " active" : ""}`} onClick={() => setMode("straighten")}>画水平参考线</button>
      <p className="field-note">当前旋转 {recipe.rotate >= 0 ? "+" : ""}{recipe.rotate.toFixed(2)}°</p>
      {recipe.rotate !== 0 && <button className="btn ghost" onClick={() => {
        update({ rotate: 0, crop: undefined, baseRoi: undefined, baseMode: recipe.engine === "classic" ? "auto" : "manual" });
        showToast("已重置水平；原裁剪和取样选区已清除。");
      }}>重置水平</button>}
      <button className="btn" onClick={() => setMode("crop")} disabled={recipe.crop !== undefined}>框选裁剪</button>
      {recipe.crop !== undefined && <button className="btn ghost" onClick={() => update({ crop: undefined })}>清除裁剪</button>}
    </Section>
    {recipe.engine === "classic"
      ? <ClassicControls recipe={recipe} update={update} setMode={setMode} baseLabel={baseLabel} baseDetail={baseDetail} />
      : <NegadoctorControls recipe={recipe} update={update} setMode={setMode} autoTune={autoTune} baseLabel={baseLabel} baseDetail={baseDetail} />}
  </aside>;
}

function ClassicControls({ recipe, update, setMode, baseLabel, baseDetail }: {
  recipe: Extract<Recipe, { engine: "classic" }>;
  update: (patch: RecipePatch) => void;
  setMode: (mode: DrawMode) => void;
  baseLabel: string;
  baseDetail: string;
}) {
  return <>
    <Section title="片基">
      <RadioGroup value={recipe.baseMode} onChange={(baseMode) => {
        update({ baseMode });
        if (baseMode === "roi" && recipe.baseRoi === undefined) setMode("base-roi");
      }} options={[{ value: "auto", label: "默认" }, { value: "roi", label: "手动选取" }]} />
      <button className="btn" onClick={() => setMode("base-roi")}>框选片基区域</button>
      {recipe.baseMode === "roi" && recipe.baseRoi !== undefined && <button className="btn ghost" onClick={() => update({ baseRoi: undefined, baseMode: "auto" })}>清除选区(回到默认)</button>}
      <p className="field-note">片基:{baseLabel} · {baseDetail}</p>
    </Section>
    <Section title="反转">
      <RadioGroup value={recipe.dmaxMode} onChange={(dmaxMode) => update({ dmaxMode })} options={[{ value: "auto", label: "自动 Dmax" }, { value: "manual", label: "手动 Dmax" }]} />
      {recipe.dmaxMode === "manual" && <Slider label="Dmax" value={recipe.manualDmax} min={0.2} max={3.5} step={0.01} onChange={(manualDmax) => update({ manualDmax })} />}
      <label className="checkbox-row"><input type="checkbox" checked={recipe.autoNeutralize} onChange={(event) => update({ autoNeutralize: event.target.checked })} />自动中和橙罩(中性像素拟合)</label>
      <label className="checkbox-row"><input type="checkbox" checked={recipe.autoWhiteBalance} onChange={(event) => update({ autoWhiteBalance: event.target.checked })} />自动白平衡(灰世界中位数)</label>
      <button className="btn" onClick={() => setMode("neutral-roi")}>框选中性高密度区域</button>
      {recipe.neutralRoi !== undefined && <button className="btn ghost" onClick={() => update({ neutralRoi: undefined })}>清除中性区</button>}
      <Slider label="手动色温" value={recipe.temperatureKelvin} min={2500} max={10_000} step={100} disabled={recipe.autoWhiteBalance} onChange={(temperatureKelvin) => update({ temperatureKelvin })} format={(value) => `${Math.round(value)} K`} />
      <Slider label="密度预饱和" value={recipe.preSaturation} min={0.5} max={2} step={0.01} onChange={(preSaturation) => update({ preSaturation })} />
    </Section>
    <Section title="调色">
      <Slider label="曝光" value={recipe.exposure} min={-3} max={3} step={0.05} onChange={(exposure) => update({ exposure })} format={(value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)} EV`} />
      <Slider label="对比度" value={recipe.contrast} min={0.5} max={1.5} step={0.01} onChange={(contrast) => update({ contrast })} />
      <Slider label="高光压缩" value={recipe.highlightCompression} min={0} max={1} step={0.01} onChange={(highlightCompression) => update({ highlightCompression })} />
      <Slider label="饱和度" value={recipe.saturation} min={0} max={2} step={0.01} onChange={(saturation) => update({ saturation })} />
    </Section>
  </>;
}

function NegadoctorControls({ recipe, update, setMode, autoTune, baseLabel, baseDetail }: {
  recipe: NegadoctorRecipe;
  update: (patch: RecipePatch) => void;
  setMode: (mode: DrawMode) => void;
  autoTune: () => void;
  baseLabel: string;
  baseDetail: string;
}) {
  const updateRgb = (key: "dminRgb" | "shadowCastRgb" | "highlightBalanceRgb", channel: 0 | 1 | 2, value: number) => {
    const rgb = [...recipe[key]] as Rgb;
    rgb[channel] = value;
    update({ [key]: rgb });
  };
  return <>
    <Section title="负片属性">
      <RadioGroup value={recipe.filmStock} onChange={(filmStock) => update({ filmStock })} options={[{ value: "color", label: "彩色负片" }, { value: "black-and-white", label: "黑白负片" }]} />
      <button className="btn" onClick={() => update(presetPatch(NEGADOCTOR_56_COLOR_PRESET))}>官方彩负预设</button>
      <button className="btn" onClick={() => update(presetPatch(NEGADOCTOR_56_BW_PRESET))}>官方黑白预设</button>
      <button className="btn primary" onClick={autoTune}>稳健自动设置</button>
      <button className="btn" onClick={() => setMode("base-roi")}>框选片基 Dmin</button>
      <button className="btn" onClick={() => setMode("content-roi")}>框选曝光内容</button>
      <p className="field-note">片基:{baseLabel} · {baseDetail}</p>
      <Slider label="Dmax (dB)" value={recipe.dmax} min={0.1} max={6} step={0.01} onChange={(dmax) => update({ dmax })} />
    </Section>
    <Section title="相纸属性">
      <Slider label="打印曝光" value={recipe.printExposure} min={0.5} max={2} step={0.005} onChange={(printExposure) => update({ printExposure })} format={(value) => `${Math.log2(value) >= 0 ? "+" : ""}${Math.log2(value).toFixed(2)} EV`} />
      <Slider label="相纸等级 (gamma)" value={recipe.paperGrade} min={1} max={8} step={0.05} onChange={(paperGrade) => update({ paperGrade })} />
      <Slider label="相纸光泽 (高光)" value={recipe.paperGloss} min={0.0001} max={1} step={0.005} onChange={(paperGloss) => update({ paperGloss })} />
    </Section>
    <details className="advanced-controls"><summary>高级参数</summary>
      <Section title="色彩空间">
        <RadioGroup value={recipe.inputPrimaries} onChange={(inputPrimaries) => update({ inputPrimaries })} options={[{ value: "srgb", label: "线性 sRGB 输入" }, { value: "rec2020", label: "线性 Rec.2020 输入" }]} />
        <RadioGroup value={recipe.workingSpace} onChange={(workingSpace) => update({ workingSpace })} options={[{ value: "linear-rec2020", label: "线性 Rec.2020 工作" }, { value: "linear-srgb", label: "线性 sRGB 工作" }]} />
      </Section>
      <Section title="胶片校正">
        <RgbSliders label="Dmin" rgb={recipe.dminRgb} min={0.00001} max={1.5} step={0.001} onChange={(channel, value) => { updateRgb("dminRgb", channel, value); update({ baseMode: "manual" }); }} />
        <Slider label="扫描曝光偏置" value={recipe.scanExposureBias} min={-1} max={1} step={0.005} onChange={(scanExposureBias) => update({ scanExposureBias })} />
        <button className="btn" onClick={() => setMode("shadow-roi")}>框选中性阴影</button>
        <RgbSliders label="阴影色偏" rgb={recipe.shadowCastRgb} min={0.25} max={2} step={0.01} onChange={(channel, value) => updateRgb("shadowCastRgb", channel, value)} />
        <button className="btn" onClick={() => setMode("highlight-roi")}>框选中性高光</button>
        <RgbSliders label="高光白平衡" rgb={recipe.highlightBalanceRgb} min={0.25} max={2} step={0.01} onChange={(channel, value) => updateRgb("highlightBalanceRgb", channel, value)} />
        <Slider label="相纸黑位" value={recipe.paperBlack} min={-0.5} max={0.5} step={0.0025} onChange={(paperBlack) => update({ paperBlack })} />
      </Section>
    </details>
  </>;
}

function presetPatch(preset: NegadoctorRecipe): RecipePatch {
  return {
    filmStock: preset.filmStock,
    dminRgb: [...preset.dminRgb],
    dmax: preset.dmax,
    scanExposureBias: preset.scanExposureBias,
    shadowCastRgb: [...preset.shadowCastRgb],
    highlightBalanceRgb: [...preset.highlightBalanceRgb],
    paperBlack: preset.paperBlack,
    paperGrade: preset.paperGrade,
    paperGloss: preset.paperGloss,
    printExposure: preset.printExposure,
    baseMode: "manual",
  };
}

function RgbSliders({ label, rgb, min, max, step, onChange }: { label: string; rgb: Rgb; min: number; max: number; step: number; onChange: (channel: 0 | 1 | 2, value: number) => void }) {
  return <>{(["R", "G", "B"] as const).map((channelLabel, index) => <Slider key={channelLabel} label={`${label} ${channelLabel}`} value={rgb[index]!} min={min} max={max} step={step} onChange={(value) => onChange(index as 0 | 1 | 2, value)} />)}</>;
}
