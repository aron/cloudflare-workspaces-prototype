/**
 * worker_deploy implementation for the Cloudflare Worker persona.
 *
 *   1. Push the agent's /workspace to the container.
 *   2. Invoke `wrangler deploy --dry-run` against the model-supplied
 *      wrangler config; capture stdout+stderr as `buildLog`.
 *   3. Pull the build output back into the agent's VFS.
 *   4. Hash the bundle. If unchanged, reuse the warm Dynamic Worker.
 *   5. Otherwise load the new bundle via @cloudflare/workspace/worker-sandbox.
 */

import type { Workspace } from "@cloudflare/workspace";
import { loadWorker, type LoadedWorker } from "@cloudflare/workspace/worker-sandbox";

const BUILD_DIR_ROOT = "/workspace/.cf-build";

export interface DeployResult {
  ok:        boolean;
  hash?:     string;
  size?:     number;
  modules?:  string[];
  buildLog?: string;
  cached?:   boolean;
  error?:    string;
}

/** Module-level cache (one entry per agent DO, keyed by hash). */
interface DeployedSlot {
  hash:   string;
  worker: LoadedWorker;
}

export class WorkerDeployer {
  private slot: DeployedSlot | null = null;

  constructor(
    private readonly workspace: Workspace,
    private readonly loader:    WorkerLoader,
  ) {}

  get current(): LoadedWorker | null { return this.slot?.worker ?? null; }
  get currentHash(): string | null   { return this.slot?.hash ?? null; }

  async deploy(configPath: string): Promise<DeployResult> {
    const stat = await this.workspace.stat(configPath);
    if (!stat || stat.type !== "file") {
      return { ok: false, error: `wrangler config not found: ${configPath}` };
    }

    // 1+2+3. Run wrangler in the container and pull build artifacts back.
    //
    // `--dry-run` makes wrangler bundle and emit files without actually
    // deploying. `--outdir` controls where the bundle lands; we tuck it
    // under /workspace/.cf-build so it survives the workspace round-trip.
    const outDir = `${BUILD_DIR_ROOT}/latest`;
    const cmd =
      `mkdir -p ${outDir} && ` +
      `cd ${dirname(configPath)} && ` +
      `wrangler deploy --dry-run --outdir=${outDir} --config=${configPath} 2>&1`;
    const result = await this.workspace.exec(cmd);
    const buildLog = (result.stdout + result.stderr).trim();
    if (result.exitCode !== 0) {
      return { ok: false, error: "build failed", buildLog };
    }

    // 4. Locate the built main module. wrangler emits the entry as the
    //    basename of `main` with .js, e.g. src/index.ts → src/index.js.
    //    The simplest robust thing is to find the only .js (or first one).
    const builtFiles = (await this.workspace.listFilesUnder(outDir))
      .filter(p => p.startsWith(outDir + "/"))
      .map(p => p.slice(outDir.length + 1));
    const mainEntry = pickEntry(builtFiles);
    if (!mainEntry) {
      return { ok: false, error: "no main module emitted by wrangler", buildLog };
    }
    const mainBytes = await this.workspace.readFile(`${outDir}/${mainEntry}`);
    if (!mainBytes) {
      return { ok: false, error: `built file disappeared: ${outDir}/${mainEntry}`, buildLog };
    }
    const mainSource = new TextDecoder().decode(mainBytes);

    // Hash main + every additional module so identical bundles share an isolate.
    const extras: Record<string, { js?: string; text?: string; data?: ArrayBuffer; json?: unknown }> = {};
    for (const name of builtFiles) {
      if (name === mainEntry) continue;
      const bytes = await this.workspace.readFile(`${outDir}/${name}`);
      if (!bytes) continue;
      if (name.endsWith(".js") || name.endsWith(".mjs")) {
        extras[name] = { js: new TextDecoder().decode(bytes) };
      } else if (name.endsWith(".json")) {
        extras[name] = { json: JSON.parse(new TextDecoder().decode(bytes)) };
      } else if (name.endsWith(".wasm")) {
        extras[name] = { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
      } else {
        extras[name] = { text: new TextDecoder().decode(bytes) };
      }
    }

    const hash = await sha256(mainSource + JSON.stringify(Object.keys(extras).sort()));

    if (this.slot?.hash === hash) {
      return {
        ok:       true, cached: true, hash,
        size:     mainBytes.length,
        modules:  builtFiles,
        buildLog,
      };
    }

    // 5. Load the new bundle.
    const worker = loadWorker({
      loader:     this.loader,
      id:         `worker:${hash}`,
      mainModule: mainSource,
      modules:    extras,
    });
    this.slot = { hash, worker };

    return {
      ok:      true, hash,
      size:    mainBytes.length,
      modules: builtFiles,
      buildLog,
    };
  }
}

// ---- helpers ----

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function pickEntry(files: string[]): string | undefined {
  // Prefer index.js at the top level; fall back to any .js / .mjs.
  if (files.includes("index.js")) return "index.js";
  if (files.includes("index.mjs")) return "index.mjs";
  return files.find(f => f.endsWith(".js") || f.endsWith(".mjs"));
}

async function sha256(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
