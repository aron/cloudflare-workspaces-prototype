import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Workerd-backed runner. Same .test.ts files as the node project, but
// withDB resolves to the Durable Object-backed implementation via the
// alias below.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  resolve: {
    // Match any relative import that lands on src/fs/with-db.js so
    // tests under src/fs/, src/, and src/sync/ all resolve to the
    // workerd-backed implementation regardless of their depth.
    alias: [
      {
        find: /^.*\/with-db\.js$/,
        replacement: new URL("./src/fs/with-db.workers.ts", import.meta.url).pathname,
      },
    ],
  },
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    // testing.test.ts and schema/index.test.ts cover the node-only test
    // fixtures (SqliteTestStorage, RecordingStorage). They have no
    // meaning under workerd — the workerd runner uses real DO storage
    // via withDB instead.
    exclude: [
      "src/testing.test.ts",
      "src/schema/index.test.ts",
      "src/provider.test.ts",
      "src/provider-fd.test.ts",
    ],
  },
});
