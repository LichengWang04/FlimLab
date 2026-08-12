import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

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
    plugins: [react()],
  },
});
