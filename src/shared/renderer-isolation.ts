/** Cross-origin isolation required by SharedArrayBuffer-backed preview paths. */
export const RENDERER_ISOLATION_HEADERS = Object.freeze({
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
});

export function applyRendererIsolationHeaders(headers: Headers): Headers {
  for (const [name, value] of Object.entries(RENDERER_ISOLATION_HEADERS)) headers.set(name, value);
  return headers;
}
