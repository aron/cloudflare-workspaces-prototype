import type { FileStat, FileStore } from "./types.js";

/**
 * In-memory `FileStore` used by tests and by callers that just need a
 * scratch filesystem (e.g. demos, fixtures). Stores each file as a single
 * `Uint8Array`; `readChunks` slices it on demand so tests can exercise the
 * streaming code paths with a configurable chunk size.
 */
export class InMemoryFileStore implements FileStore {
  private readonly files = new Map<string, { data: Uint8Array; mtime: number; mode: number }>();
  private readonly chunkSize: number;

  constructor(opts: { chunkSize?: number } = {}) {
    this.chunkSize = opts.chunkSize ?? 64 * 1024;
  }

  async stat(path: string): Promise<FileStat | null> {
    const f = this.files.get(path);
    if (!f) return null;
    return { size: f.data.length, mtime: f.mtime, mode: f.mode };
  }

  async readAll(path: string): Promise<Uint8Array | null> {
    const f = this.files.get(path);
    return f ? f.data : null;
  }

  async *readChunks(
    path: string,
    byteOffset = 0,
    byteLength?: number,
  ): AsyncIterable<Uint8Array> {
    const f = this.files.get(path);
    if (!f) throw new Error(`File not found: ${path}`);
    const end =
      byteLength === undefined
        ? f.data.length
        : Math.min(f.data.length, byteOffset + byteLength);
    for (let i = byteOffset; i < end; i += this.chunkSize) {
      yield f.data.subarray(i, Math.min(end, i + this.chunkSize));
    }
  }

  async write(path: string, content: Uint8Array, opts?: { mode?: number }): Promise<void> {
    const previous = this.files.get(path);
    // Copy so subsequent mutations to the caller's buffer don't leak in.
    this.files.set(path, {
      data:  new Uint8Array(content),
      mtime: Date.now(),
      mode:  opts?.mode ?? previous?.mode ?? 0o100644,
    });
  }
}
