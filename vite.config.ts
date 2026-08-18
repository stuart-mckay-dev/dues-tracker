import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// The SPA lives in ./web and builds to ./dist, which wrangler.toml serves
// as static assets. In dev, /api is proxied to `wrangler dev` on 8787.
export default defineConfig({
  root: "web",
  plugins: [preact()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
