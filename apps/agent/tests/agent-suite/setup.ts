import { afterAll, beforeAll } from "vitest";
import { exports } from "cloudflare:workers";

// Warm up the worker module graph before tests run. The first fetch
// triggers Vite's module resolution for the full dependency tree (Think,
// ai-chat, agents); on a cold runner this can take well past the
// per-test timeout.
beforeAll(async () => {
  await (exports as any).default.fetch("http://warmup/");
}, 30_000);

afterAll(() => new Promise((resolve) => setTimeout(resolve, 100)));
