import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

function developmentLoopbackCsp(): Plugin {
  return {
    name: "filmlab-development-loopback-csp",
    transformIndexHtml: {
      order: "pre",
      handler(html, context) {
        if (context.server === undefined) return html;
        return html.replace(
          "connect-src 'none'",
          "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
        );
      },
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // Sandboxed Electron preload scripts are evaluated as CommonJS, not as
    // ESM. Without this explicit output the package's `type: module` makes
    // Vite emit index.mjs, which Electron rejects before contextBridge runs.
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    // Production has connect-src 'none'. Only Vite development receives the
    // explicit loopback exception required for HMR; no remote host is allowed.
    plugins: [developmentLoopbackCsp(), react()],
  },
});
