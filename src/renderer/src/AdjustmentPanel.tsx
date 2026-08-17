import type { Recipe } from "../../core/index.ts";
import { RadioGroup, Section, Slider } from "./ui.tsx";
import type { DrawMode } from "./renderer-types.ts";

export function AdjustmentPanel({
  recipe,
  mode,
  frameCount,
  baseLabel,
  baseDetail,
  update,
  setMode,
  applyRecipeToAll,
  showToast,
}: {
  recipe: Recipe;
  mode: DrawMode;
  frameCount: number;
  baseLabel: string;
  baseDetail: string;
  update: (patch: Partial<Recipe>) => void;
  setMode: (mode: DrawMode) => void;
  applyRecipeToAll: () => void;
  showToast: (message: string) => void;
}) {
  return (
    <aside className="panel">
      {frameCount > 1 && (
        <Section title="整卷">
          <button className="btn" onClick={applyRecipeToAll}>应用到整卷</button>
          <p className="field-note">把当前帧的完整配方复制给整卷(跳过的帧除外)。</p>
        </Section>
      )}

      <Section title="几何">
        <button className={`btn${mode === "straighten" ? " active" : ""}`} onClick={() => setMode("straighten")}>
          画水平参考线
        </button>
        <p className="field-note">当前旋转 {recipe.rotate >= 0 ? "+" : ""}{recipe.rotate.toFixed(2)}°</p>
        {recipe.rotate !== 0 && (
          <button
            className="btn ghost"
            onClick={() => {
              update({ rotate: 0, crop: undefined, baseRoi: undefined, neutralRoi: undefined, baseMode: "auto" });
              showToast("已重置水平；原裁剪、片基和中性选区已清除。");
            }}
          >
            重置水平
          </button>
        )}
        <button className="btn" onClick={() => setMode("crop")} disabled={recipe.crop !== undefined}>框选裁剪</button>
        {recipe.crop !== undefined && <button className="btn ghost" onClick={() => update({ crop: undefined })}>清除裁剪</button>}
      </Section>

      <Section title="片基">
        <RadioGroup
          value={recipe.baseMode}
          onChange={(baseMode) => {
            update({ baseMode });
            if (baseMode === "roi" && recipe.baseRoi === undefined) setMode("base-roi");
          }}
          options={[{ value: "auto", label: "默认" }, { value: "roi", label: "手动选取" }]}
        />
        <button className="btn" onClick={() => setMode("base-roi")}>框选片基区域</button>
        {recipe.baseMode === "roi" && recipe.baseRoi !== undefined && (
          <button className="btn ghost" onClick={() => update({ baseRoi: undefined, baseMode: "auto" })}>
            清除选区(回到默认)
          </button>
        )}
        <p className="field-note">片基:{baseLabel} · {baseDetail}</p>
      </Section>

      <Section title="反转">
        <RadioGroup
          value={recipe.dmaxMode}
          onChange={(dmaxMode) => update({ dmaxMode })}
          options={[{ value: "auto", label: "自动 Dmax" }, { value: "manual", label: "手动 Dmax" }]}
        />
        {recipe.dmaxMode === "manual" && (
          <Slider label="Dmax" value={recipe.manualDmax} min={0.2} max={3.5} step={0.01}
            onChange={(manualDmax) => update({ manualDmax })} format={(value) => value.toFixed(2)} />
        )}
        <label className="checkbox-row">
          <input type="checkbox" checked={recipe.autoNeutralize}
            onChange={(event) => update({ autoNeutralize: event.target.checked })} />
          自动中和橙罩(中性像素拟合)
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={recipe.autoWhiteBalance}
            onChange={(event) => update({ autoWhiteBalance: event.target.checked })} />
          自动白平衡(灰世界中位数)
        </label>
        <button className="btn" onClick={() => setMode("neutral-roi")}>框选中性高密度区域</button>
        {recipe.neutralRoi !== undefined && <button className="btn ghost" onClick={() => update({ neutralRoi: undefined })}>清除中性区</button>}
        <Slider label="手动色温" value={recipe.temperatureKelvin} min={2500} max={10_000} step={100}
          disabled={recipe.autoWhiteBalance} onChange={(temperatureKelvin) => update({ temperatureKelvin })}
          format={(value) => `${Math.round(value)} K`} />
        {recipe.autoWhiteBalance && <p className="field-note">关闭自动白平衡后可调色温。</p>}
        <Slider label="密度预饱和" value={recipe.preSaturation} min={0.5} max={2} step={0.01}
          onChange={(preSaturation) => update({ preSaturation })} />
      </Section>

      <Section title="调色">
        <Slider label="曝光" value={recipe.exposure} min={-3} max={3} step={0.05}
          onChange={(exposure) => update({ exposure })}
          format={(value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)} EV`} />
        <Slider label="对比度" value={recipe.contrast} min={0.5} max={1.5} step={0.01}
          onChange={(contrast) => update({ contrast })} />
        <Slider label="高光压缩" value={recipe.highlightCompression} min={0} max={1} step={0.01}
          onChange={(highlightCompression) => update({ highlightCompression })} />
        <Slider label="饱和度" value={recipe.saturation} min={0} max={2} step={0.01}
          onChange={(saturation) => update({ saturation })} />
      </Section>
    </aside>
  );
}
