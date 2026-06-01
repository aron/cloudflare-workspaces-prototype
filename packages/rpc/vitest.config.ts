import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    benchmark: {
      include: ["src/**/*.bench.ts"],
      exclude: ["dist/**"],
    },
  },
});
