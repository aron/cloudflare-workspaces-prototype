#!/usr/bin/env node
// Copies the freshly-built wsd-linux-x64 binary into ./build so the
// Dockerfile's COPY can find it inside the image build context.
//
// Runs as a `predev` / `predeploy` hook. Cheap to re-run; idempotent.

import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const src = resolve(repoRoot, "artifacts/wsd/wsd-linux-x64");
const destDir = resolve(here, "..", "build");
const dest = resolve(destDir, "wsd-linux-x64");

try {
  statSync(src);
} catch {
  console.error(
    `stage-wsd: ${src} not found. Run \`npm run build:bin --workspace @cloudflare/workspace-wsd\` first.`,
  );
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`stage-wsd: copied ${src} -> ${dest}`);
