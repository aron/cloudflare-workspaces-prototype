/**
 * Dynamic Worker entry point that runs an agent-compiled .wasm program via
 * the WASI shim. The .wasm bytes ship as a separate `{wasm: ArrayBuffer}`
 * module in the same bundle, so workerd pre-compiles them at isolate load.
 *
 * Protocol (POSTed by the parent agent):
 *   request  { args: string[]; stdin?: string; files?: Record<string, string b64> }
 *   response { stdout: string b64; stderr: string b64; exitCode: number;
 *              files: Record<string, string b64> }
 */
import wasmModule from "./program.wasm";
import { runWasi } from "./wasi.js";

function b64(buf: Uint8Array): string {
  // V8 in workerd supports btoa via String.fromCharCode chunking
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      args?:  string[];
      stdin?: string;
      files?: Record<string, string>;
    };
    const args  = body.args  ?? [];
    const stdin = body.stdin ? new TextEncoder().encode(body.stdin) : undefined;
    const files: Record<string, Uint8Array> = {};
    for (const [path, data] of Object.entries(body.files ?? {})) files[path] = unb64(data);

    try {
      const result = await runWasi(
        wasmModule as unknown as WebAssembly.Module,
        { args, stdin, files },
      );
      const outFiles: Record<string, string> = {};
      for (const [p, b] of Object.entries(result.files)) outFiles[p] = b64(b);
      return Response.json({
        stdout:   b64(result.stdout),
        stderr:   b64(result.stderr),
        exitCode: result.exitCode,
        files:    outFiles,
      });
    } catch (e) {
      return Response.json({
        stdout:   "",
        stderr:   b64(new TextEncoder().encode(
          `runner error: ${(e as Error).message}\n${(e as Error).stack ?? ""}`,
        )),
        exitCode: 1,
        files:    {},
      });
    }
  },
};
