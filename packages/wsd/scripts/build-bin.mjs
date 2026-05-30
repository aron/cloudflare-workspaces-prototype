#!/usr/bin/env node

import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const outputDir = resolve(repoRoot, "artifacts/wsd");
const pkgBin = process.platform === "win32" ? "pkg.cmd" : "pkg";

const targets = [
  ["node22-linux-x64", "wsd-linux-x64"],
  ["node22-macos-x64", "wsd-macos-x64"],
];

await run("npm", ["run", "build"], packageRoot);
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const [target, outputName] of targets) {
  await run(
    pkgBin,
    [
      resolve(packageRoot, "dist/cli/wsd.cjs"),
      "--config",
      resolve(repoRoot, "package.json"),
      "--target",
      target,
      "--output",
      resolve(outputDir, outputName),
    ],
    packageRoot,
  );
}

console.log(`wrote standalone binaries to ${outputDir}`);

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}`));
    });
  });
}
