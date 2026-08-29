import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
import { RENDERER_ISOLATION_HEADERS } from "./src/shared/renderer-isolation.ts";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "libraw-node-bootstrap": resolve("src/main/libraw-node-bootstrap.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
    server: {
      headers: RENDERER_ISOLATION_HEADERS,
    },
  },
});
