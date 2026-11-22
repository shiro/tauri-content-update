import { solidStart } from "@solidjs/start/config";
import styleThisVitePlugin from "@style-this/vite";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  // the tauri android dev server is reached from the device (TAURI_DEV_HOST is set by `tauri android dev`)
  server: {
    port: 3000,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
  },
  // keep the console clean when tauri prints its own output
  clearScreen: false,
  build: { sourcemap: true },
  resolve: {
    alias: { "~": path.join(import.meta.dirname, "src") },
    // tauri-plugin-content-update is linked (pnpm link): its imports would otherwise resolve
    // @tauri-apps/api from its own checkout and bundle a second copy
    dedupe: ["@tauri-apps/api"],
  },
  css: { transformer: "lightningcss" },
  plugins: [
    styleThisVitePlugin({ filter: /.*\.tsx/ }),
    tailwindcss(),
    solidStart({
      ssr: false,
      devOverlay: false,
      // CORS for the production app's server function calls (see src/backend.ts)
      middleware: "src/middleware.ts",
      solid: {
        babel: {
          plugins: [
            [
              "solid-labels/babel",
              { dev: process.env.NODE_ENV == "development" },
            ],
          ],
        },
      },
    }),
    // prerender the SPA shell so .output/public (tauri's frontendDist) has an index.html
    nitro({ prerender: { routes: ["/"] } }),
  ],
});
