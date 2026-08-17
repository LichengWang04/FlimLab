import type { AppInfo } from "../../shared/ipc.ts";

export function AboutDialog({ info, diagnostics, onClose, onCopy }: {
  info: AppInfo | null;
  diagnostics: string;
  onClose: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="summary-overlay" role="dialog" aria-modal="true" aria-labelledby="about-title">
      <div className="summary-card about-card">
        <h2 id="about-title">关于 FilmLab</h2>
        <p>版本 {info?.version ?? "—"} · Windows {info?.arch ?? "—"} · Electron {info?.electron ?? "—"}</p>
        <p>© 2026 Licheng Wang。FilmLab 为本地离线处理工具，不上传图像、文件路径或遥测数据。</p>
        <p>自动片基、去色罩和白平衡是无色卡、单帧全局估计；混合光、严重主体偏色、染料退化和特殊扫描曲线可能需要人工调整。</p>
        <p>许可证、第三方声明与隐私说明随安装包位于 resources/legal。最近会话仅保存到本机用户数据目录。</p>
        <p>问题反馈：GitHub LichengWang04/FlimLab Issues。提交样片完全自愿，请先移除隐私内容。</p>
        <pre className="diagnostics">{diagnostics}</pre>
        <div className="dialog-actions">
          <button className="btn" onClick={onCopy}>复制诊断信息</button>
          <button className="btn primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
