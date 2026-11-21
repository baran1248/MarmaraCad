import { defineConfig } from "vite";

export default defineConfig({
  base: "/MarmaraCad/",
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["opencascade.js"],
  },
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 100000,
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // The e2e suites download artefacts (PDF/STEP/project JSON); a file locked
      // there by Playwright crashed the watcher with EBUSY on Windows.
      ignored: ["**/tests/.tmp-*", "**/tests/*.step", "**/tests/*.pdf", "**/tests/*.mcad.json"],
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
