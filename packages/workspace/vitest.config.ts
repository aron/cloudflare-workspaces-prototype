import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    // The docker harness has its own config and globalSetup;
    // it runs via `npm run test:harness`. Excluded here so the
    // unit-test command doesn't try to boot a container.
    exclude: ["src/test-harness/**"],
  },
});
