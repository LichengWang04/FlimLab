import { StrictMode, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { runWebGpuPreviewSmoke } from "./webgpu/smoke.ts";
import "./styles.css";

/**
 * Any uncaught renderer error is painted into the page instead of leaving
 * a black window, so failures stay diagnosable without DevTools.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error !== null) {
      return (
        <div className="fatal-overlay">
          <h1>界面渲染出错</h1>
          <pre>{String(this.state.error?.stack ?? this.state.error)}</pre>
          <button className="btn" onClick={() => window.location.reload()}>重新加载</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function showFatal(message: string, detail = ""): void {
  const existing = document.getElementById("fatal-overlay");
  if (existing !== null) return;
  const overlay = document.createElement("div");
  overlay.id = "fatal-overlay";
  overlay.className = "fatal-overlay";
  const title = document.createElement("h1");
  title.textContent = message;
  const pre = document.createElement("pre");
  pre.textContent = detail;
  const reload = document.createElement("button");
  reload.className = "btn";
  reload.textContent = "重新加载";
  reload.addEventListener("click", () => window.location.reload());
  overlay.append(title, pre, reload);
  document.body.append(overlay);
}

window.addEventListener("error", (event) => {
  showFatal("未捕获错误", String(event.error ?? event.message));
});
window.addEventListener("unhandledrejection", (event) => {
  showFatal("未处理的 Promise 拒绝", String(event.reason));
});

const container = document.getElementById("root");
if (container === null) throw new Error("Root element missing.");
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

const gpuSmokeTransport = new URLSearchParams(window.location.search).get("gpuSmoke");
if (gpuSmokeTransport === "shared" || gpuSmokeTransport === "array-buffer") {
  void runWebGpuPreviewSmoke(gpuSmokeTransport).then((message) => {
    console.log(`[gpu-smoke] ${message}`);
  }).catch((error: unknown) => {
    console.error(`[gpu-smoke] failed ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  });
}
