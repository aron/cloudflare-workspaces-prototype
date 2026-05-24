import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

/**
 * Frontend tests are pure-Node and cover the route parser, navigation
 * helpers, and formatting utilities. No DOM, no jsdom — the React
 * components themselves are exercised via the E2E suite in @app/agent.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
