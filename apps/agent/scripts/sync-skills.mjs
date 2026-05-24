#!/usr/bin/env node
/**
 * Upload every file under apps/agent/skills/ to the SKILLS R2 bucket.
 *
 *   node scripts/sync-skills.mjs           # → production bucket (hackspace-skills)
 *   node scripts/sync-skills.mjs --local   # → local bucket via miniflare
 *
 * Skills are organized as <name>/SKILL.md (+ optional sibling files).
 * The key in R2 mirrors the relative path under apps/agent/skills/.
 * Run from apps/agent or set CWD with `npm run skills:sync`.
 *
 * We shell out to wrangler so credentials and bucket selection follow
 * whatever environment the developer already has configured.
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT      = resolve(new URL(".", import.meta.url).pathname, "..");
const SKILLS    = join(ROOT, "skills");
const BUCKET    = process.env.SKILLS_BUCKET ?? "hackspace-skills";
const args      = new Set(process.argv.slice(2));
const useLocal  = args.has("--local");

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function put(key, file) {
  const flags = useLocal ? "--local" : "--remote";
  const cmd = [
    "npx",
    "wrangler",
    "r2",
    "object",
    "put",
    `${BUCKET}/${key}`,
    `--file=${file}`,
    flags,
  ];
  console.log(`  ${key}  (${statSync(file).size}B)`);
  execSync(cmd.join(" "), { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
}

console.log(`Syncing skills/* → ${BUCKET} (${useLocal ? "local" : "remote"})`);
for (const file of walk(SKILLS)) {
  const key = relative(SKILLS, file).split(/[\\/]/).join("/");
  put(key, file);
}
console.log("Done.");
