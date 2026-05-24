import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Vitest runs inside workerd via `@cloudflare/vitest-pool-workers` so DO tests
 * exercise the same runtime as production: real `DurableObjectState`, real
 * SQLite storage, real bindings.
 *
 * We point at a dedicated `wrangler.test.jsonc` so the test environment
 * doesn't pull in production-only bindings (containers, AI, worker loader,
 * cron). The test config only declares what the tests under `tests/` need.
 *
 * Note: wrangler loads `.dev.vars` from the directory containing the config
 * file — keep secrets out of `apps/agent/` (use a subdir or untracked path)
 * or they'll leak into the test env and override `vars` in this jsonc.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
    }),
  ],
  test: {
    // E2E tests live under tests-e2e/ and run via `npm run test:e2e`.
    // They drive a real `wrangler dev --local` process and don't belong in
    // the in-process pool-workers run.
    //
    // The agent-suite/ tests run via a dedicated vitest config
    // (tests/agent-suite/vitest.config.ts) that binds the real Agent /
    // SubAgent classes. The root config here uses a FakeAgent stand-in,
    // so we'd see RPC errors if these tests ran here.
    exclude: ["node_modules", "dist", "tests-e2e/**", "tests/agent-suite/**"],
  },
});
