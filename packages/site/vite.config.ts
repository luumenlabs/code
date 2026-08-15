import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The showcases are the app's own components. Its files import through
      // `@`, which lands here, so anything borrowed needs a match in src/lib.
      "@app": fileURLToPath(new URL("../app/src/renderer", import.meta.url)),
      // The hero shot is the repo's own screenshot. One copy, at the root, so
      // the page and the README can never show different products.
      "@assets": fileURLToPath(new URL("../../assets", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5274,
    strictPort: true,
  },
});
