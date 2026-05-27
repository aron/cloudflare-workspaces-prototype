/**
 * Test setup: stub the `cloudflare:workers` builtin so we can load
 * `@cloudflare/containers` and `@cloudflare/sandbox` under plain Node.
 *
 * Those packages are published as CJS, so we have to intercept both the
 * ESM loader (used for the workspace package's own .ts files) and the CJS
 * `require()` chain (used when @cloudflare/containers's dist/index.js
 * pulls in @cloudflare/containers/dist/lib/container.js which then
 * `require("cloudflare:workers")`).
 */

import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { createRequire, Module } from "node:module";

const here = pathToFileURL(import.meta.filename);

// 1. ESM hook \u2014 covers static/dynamic import() of "cloudflare:workers".
register("./loader.mjs", here);

// 2. CJS hook \u2014 covers nested require("cloudflare:workers") chains.
const stubPath = new URL("./workers-stub.cjs", here).pathname;
const origResolve = Module._resolveFilename.bind(Module);
Module._resolveFilename = (request: string, ...rest: unknown[]) => {
  if (request === "cloudflare:workers") return stubPath;
  return (origResolve as (req: string, ...r: unknown[]) => string)(request, ...rest);
};
