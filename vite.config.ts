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
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
