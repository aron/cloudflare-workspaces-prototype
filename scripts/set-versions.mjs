#!/usr/bin/env node
// Sync the version of every published package in lockstep.
// Usage:
//   node scripts/set-versions.mjs 0.1.0-alpha.2
//   node scripts/set-versions.mjs v0.1.0-alpha.2   # leading 'v' tolerated
//
// Both @cloudflare/workspace and @cloudflare/workspace-wsd-linux-x64
// land at the same release tag. The release workflow runs this with
// the pushed tag before publishing.

import { readFile, writeFile } from "node:fs/promises";
import { argv } from "node:process";

const PACKAGES = ["packages/workspace/package.json", "packages/wsd-linux-x64/package.json"];

const raw = argv[2];
if (raw === undefined) {
  console.error("usage: set-versions.mjs <version>");
  process.exit(2);
}

const version = raw.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`bad version: ${raw}`);
  process.exit(2);
}

for (const pkg of PACKAGES) {
  const json = JSON.parse(await readFile(pkg, "utf8"));
  json.version = version;
  await writeFile(pkg, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${pkg}: version → ${version}`);
}
