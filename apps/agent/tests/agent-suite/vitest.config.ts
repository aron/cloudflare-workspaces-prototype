import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import babel from "@rolldown/plugin-babel";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  plugins: [
    // TC39 decorator transform. The agent uses `@callable()` from the
    // `agents` SDK; vite/rolldown's default transformer (oxc) doesn't
    // implement stage-3 decorators yet (oxc#9170), so the SSR-transformed
    // module reaches workerd with the `@` syntax still in place and V8
    // rejects it with an opaque `SyntaxError: Invalid or unexpected token`.
    // The same plugin is shipped by `agents/vite` upstream; we inline it
    // here so the agent-suite isn't forced to take on the full `agents`
    // vite plugin (which also rewires `agents:skills` imports and stubs
    // `turndown` — neither of which we want).
    babel({
      presets: [
        {
          preset: () => ({
            plugins: [
              ["@babel/plugin-proposal-decorators", { version: "2023-11" }]
            ]
          }),
          // Only transform files that actually contain a `@` decorator
          // marker. Keeps the babel pass off the hot path for every other
          // module the test bundle pulls in.
          rolldown: { filter: { code: "@" } }
        }
      ]
    }) as unknown as import("vite").Plugin,
    cloudflareTest({
      wrangler: {
        configPath: path.join(testsDir, "wrangler.jsonc")
      }
    })
  ],
  test: {
    name: "agent",
    include: [path.join(testsDir, "**/*.test.ts")],
    setupFiles: [path.join(testsDir, "setup.ts")],
    testTimeout: 15_000,
    deps: {
      optimizer: {
        ssr: {
          include: ["ajv"]
        }
      }
    }
  }
});
