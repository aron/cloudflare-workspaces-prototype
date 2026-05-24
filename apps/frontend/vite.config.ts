import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Vite reads `index.html` at the project root and writes both that and
// the bundled JS/CSS into `dist/`. The agent worker's `wrangler.jsonc`
// points its `assets.directory` at `../frontend/dist`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The previous build emitted one ~2.3MB entry chunk because streamdown,
    // shiki, radix, and the AI SDK were all reachable from the top-level
    // App import. Lazy-loading the room/thread components in App.tsx pushes
    // those dependencies behind a dynamic import, so the picker landing
    // page no longer pays for them. We split a few small, stable vendor
    // libraries into their own chunks so they cache across deploys, but we
    // intentionally leave streamdown and shiki to rolldown's natural
    // splitting — grouping them by hand forces shiki's lazily-loaded
    // language modules into one giant chunk.
    // Shiki's largest language grammars (cpp, emacs-lisp, wasm) sit just
    // under 1MB and are loaded lazily only when a code block uses them, so
    // we raise the warning above that floor to keep CI logs clean.
    chunkSizeWarningLimit: 1024,
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: "react", test: /node_modules\/(react|react-dom|scheduler)\// },
            { name: "radix", test: /node_modules\/@radix-ui\// },
            { name: "motion", test: /node_modules\/motion\// },
            { name: "icons", test: /node_modules\/lucide-react\// },
          ],
        },
      },
    },
  },
});
