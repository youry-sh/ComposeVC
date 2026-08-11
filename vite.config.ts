import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 3004,
    strictPort: true,
    // Electron loads http://localhost:3004 — keep HMR on the same host/port.
    hmr: {
      protocol: "ws",
      host: "localhost",
      port: 3004,
      clientPort: 3004,
    },
  },
  preview: {
    port: 3004,
    strictPort: true,
  },
  build: {
    // Harder casual UI reverse: minify + no source maps in production dist
    sourcemap: false,
    minify: "esbuild",
    cssMinify: true,
    target: "chrome120",
    reportCompressedSize: false,
    chunkSizeWarningLimit: 2000,
  },
  esbuild: {
    // Drop console/debugger from renderer production builds
    drop: process.env.NODE_ENV === "production" ? ["console", "debugger"] : [],
    legalComments: "none",
  },
});
