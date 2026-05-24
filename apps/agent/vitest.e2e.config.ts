import { defineConfig } from "vitest/config";

/**
 * E2E vitest config. Runs against a live `wrangler dev` process (started by
 * `tests-e2e/setup.ts`), not inside the pool-workers Miniflare runtime. Tests
 * issue real HTTP/WebSocket requests over the network.
 *
 * Slow (~30s boot for cold docker, then ~seconds per test). Kept separate
 * from the default vitest run so `npm test` stays fast.
 */
export default defineConfig({
  test: {
    include:     ["tests-e2e/**/*.test.ts"],
    globalSetup: "./tests-e2e/setup.ts",
    testTimeout: 60_000,
    hookTimeout: 240_000,
    pool:        "forks",
  },
});
