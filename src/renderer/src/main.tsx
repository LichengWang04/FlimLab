import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import "./styles.css";

/**
 * Catches rendering exceptions (e.g. a texture upload or canvas putImageData
 * failure inside a preview effect) so one bad frame cannot tear down the
 * whole React tree and leave the workbench blank.
 */
class AppErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly error: Error | undefined }> {
  public override state: { readonly error: Error | undefined } = { error: undefined };

  public static getDerivedStateFromError(error: Error): { readonly error: Error } {
    return { error };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("FilmLab renderer crashed:", error, info.componentStack);
  }

  public override render(): ReactNode {
    if (this.state.error !== undefined) {
      return (
        <div className="error-boundary">
          <h1>界面渲染失败</h1>
          <p>{this.state.error.message}</p>
          <button type="button" onClick={() => this.setState({ error: undefined })}>重试</button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
