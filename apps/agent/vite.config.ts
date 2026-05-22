import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite's two directories:
//   - publicDir (default: ./public): static files copied verbatim into the build
//   - outDir    (where the build writes)
// Keep them separate to silence the "may not work correctly" warning.
//
// Result: `vite build` reads `public/index.html`, writes `public/index.html`
// AND the generated `chat.js` into `dist/`. wrangler.jsonc assets.directory
// points at dist/.
export default defineConfig({
  plugins: [react()],
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "src/client.tsx",
      output: { entryFileNames: "chat.js", chunkFileNames: "[name].js" },
    },
  },
});
