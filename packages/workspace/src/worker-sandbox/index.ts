/**
 * @cloudflare/workspace/worker-sandbox
 *
 * Run agent-compiled WASM in an isolated Dynamic Worker isolate. Ships the
 * entire `/workspace` to the program (minus `.wasm` binaries) as a read/write
 * virtual filesystem; saves any files the program writes back into the VFS.
 *
 * The compiled `.wasm` ships as a `wasm`-typed module in the Dynamic Worker
 * bundle so workerd pre-compiles it at isolate load. V8's restriction on
 * dynamic `WebAssembly.instantiate(bytes)` doesn't apply because we never
 * call that overload from inside the isolate.
 *
 * Loader-cache key is `(path, mtime)` — repeated calls on the same binary
 * reuse a warm isolate with no re-bundle, no re-compile.
 */

import type { Workspace } from "../workspace.js";
import { RUNNER_BUNDLE_JS } from "./runner.bundle.js";

export interface RunWasmOptions {
  workspace: Workspace;
  loader:    WorkerLoader;
  /** Absolute path of the .wasm binary, e.g. "/workspace/main.wasm". */
  wasmPath:  string;
  /** argv passed to the program. By convention argv[0] is the binary name. */
  argv:      string[];
  /** Optional stdin (UTF-8 string). */
  stdin?:    string;
  /** Compatibility date for the spawned Dynamic Worker. */
  compatibilityDate?: string;
}

export interface RunWasmResult {
  stdout:   string;
  stderr:   string;
  exitCode: number;
  /** Files the program created or modified, mirrored back into workspace.vfs. */
  files:    Array<{ path: string; size: number; mime?: string }>;
  /** Image files among those, ready for inline display. */
  images:   Array<{ path: string; dataUrl: string }>;
}

export async function runWasm(opts: RunWasmOptions): Promise<RunWasmResult> {
  const { workspace, loader, wasmPath, argv } = opts;
  const stdin = opts.stdin ?? "";

  const stat = workspace.stat(wasmPath);
  if (!stat || stat.type !== "file") {
    throw new Error(`WASM not found: ${wasmPath}`);
  }

  // Ship every non-.wasm file under /workspace as the program's virtual FS.
  // The VFS is in-memory SQLite and the runner deserializes into a Map —
  // cheap for the workspace sizes typical of these demos (a few MB at most).
  const inputFiles: Record<string, string> = {};
  for (const path of workspace.listFilesUnder("/workspace")) {
    if (path.endsWith(".wasm")) continue;  // skip compiled binaries
    const data = workspace.readFile(path);
    if (data) inputFiles[path] = bytesToBase64(data);
  }

  // Cache the Dynamic Worker by (path, mtime) so warm runs skip the wasm load.
  const cacheId = `wasm:${wasmPath}@${stat.mtime}`;
  const worker = loader.get(cacheId, async () => {
    const wasmBytes = workspace.readFile(wasmPath);
    if (!wasmBytes) throw new Error(`${wasmPath} disappeared between stat and read`);
    return {
      compatibilityDate: opts.compatibilityDate ?? "2026-05-01",
      mainModule:        "runner.js",
      modules: {
        "runner.js":    { js: RUNNER_BUNDLE_JS },
        "program.wasm": { wasm: wasmBytes.buffer as ArrayBuffer },
      },
      globalOutbound: null,  // no network access from the program
    };
  });

  const res = await worker.getEntrypoint().fetch(new Request("https://dyn/run", {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ args: argv, stdin, files: inputFiles }),
  }));
  const raw = await res.json() as {
    stdout: string; stderr: string; exitCode: number;
    files:  Record<string, string>;
  };

  const stdoutBytes = base64ToBytes(raw.stdout);
  const stderrBytes = base64ToBytes(raw.stderr);
  const files:  Array<{ path: string; size: number; mime?: string }> = [];
  const images: Array<{ path: string; dataUrl: string }> = [];
  for (const [path, b64] of Object.entries(raw.files)) {
    const bytes = base64ToBytes(b64);
    workspace.writeFile(path, bytes);
    const mime = mimeFromPath(path);
    files.push({ path, size: bytes.length, mime });
    if (mime?.startsWith("image/")) {
      images.push({ path, dataUrl: `data:${mime};base64,${b64}` });
    }
  }

  return {
    stdout:   new TextDecoder().decode(stdoutBytes),
    stderr:   new TextDecoder().decode(stderrBytes),
    exitCode: raw.exitCode,
    files,
    images,
  };
}

// ---- helpers ----

function bytesToBase64(buf: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(s);
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function mimeFromPath(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "png":  return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif":  return "image/gif";
    case "webp": return "image/webp";
    case "svg":  return "image/svg+xml";
    case "bmp":  return "image/bmp";
    default:     return undefined;
  }
}

// ---- loadWorker: deploy a pre-built Worker bundle into a Dynamic Worker ----

export interface LoadWorkerOptions {
  loader: WorkerLoader;
  /** Unique cache key (typically a content hash). Repeated calls with the same id reuse the warm isolate. */
  id: string;
  /** The Worker's main module source (JavaScript). */
  mainModule: string;
  /** Additional modules referenced by the main module (e.g. helpers, text imports, JSON imports). */
  modules?: Record<string, { js?: string; text?: string; data?: ArrayBuffer; json?: unknown }>;
  /** Plain object passed through as `env` to the spawned Worker. */
  env?: Record<string, unknown>;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  /** Cap CPU per invocation. Defaults to 5000 ms. */
  cpuMs?: number;
}

export interface LoadedWorker {
  /** Fire a Request against the loaded Worker's default entrypoint. */
  fetch(request: Request): Promise<Response>;
}

/**
 * Load a pre-built Worker bundle into an isolated Dynamic Worker. `globalOutbound`
 * is forced to `null` so the loaded Worker cannot reach the network on its own.
 */
export function loadWorker(opts: LoadWorkerOptions): LoadedWorker {
  const stub = opts.loader.get(opts.id, async () => ({
    compatibilityDate:  opts.compatibilityDate  ?? "2026-05-01",
    compatibilityFlags: opts.compatibilityFlags ?? [],
    mainModule:         "index.js",
    modules: {
      "index.js": { js: opts.mainModule },
      ...(opts.modules ?? {}),
    },
    env:            opts.env ?? {},
    globalOutbound: null,
    limits:         { cpuMs: opts.cpuMs ?? 5000 },
  }));
  return {
    async fetch(request: Request): Promise<Response> {
      return stub.getEntrypoint().fetch(request);
    },
  };
}
