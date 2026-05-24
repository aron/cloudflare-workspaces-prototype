import type { FileStat, FileStore } from "./types.js";

/**
 * Structural subset of `@cloudflare/workspace`'s `Workspace` class that
 * fs-tools depends on. Declared here so this package has no runtime or
 * type-time dependency on `@cloudflare/workspace`.
 */
export interface WorkspaceLike {
  stat(path: string): Promise<{ type: "file" | "dir"; size: number; mtime: number } | null>;
  readFile(path: string): Promise<Uint8Array | null>;
  writeFile(path: string, content: Uint8Array | string, mode?: number): Promise<void>;
  /**
   * Optional: streaming chunk reader. When present, this is preferred over
   * `readFile` so the underlying SQLite-backed VFS can serve byte ranges
   * without materializing the whole file.
   */
  vfs?: {
    readChunks(
      path: string,
      byteOffset?: number,
      byteLength?: number,
    ): Iterable<Uint8Array>;
  };
}

/**
 * `FileStore` adapter over a `Workspace`-shaped object. Uses `vfs.readChunks`
 * when available so multi-megabyte files only touch memory in chunk-sized
 * slices; otherwise falls back to a full read + JS-side slice.
 */
export class WorkspaceFileStore implements FileStore {
  constructor(private readonly ws: WorkspaceLike) {}

  async stat(path: string): Promise<FileStat | null> {
    const s = await this.ws.stat(path);
    if (!s || s.type !== "file") return null;
    return { size: s.size, mtime: s.mtime };
  }

  async readAll(path: string): Promise<Uint8Array | null> {
    return this.ws.readFile(path);
  }

  async write(path: string, content: Uint8Array): Promise<void> {
    await this.ws.writeFile(path, content);
  }

  async *readChunks(
    path: string,
    byteOffset = 0,
    byteLength?: number,
  ): AsyncIterable<Uint8Array> {
    if (this.ws.vfs?.readChunks) {
      for (const chunk of this.ws.vfs.readChunks(path, byteOffset, byteLength)) {
        yield chunk;
      }
      return;
    }
    // Fallback: read everything and slice in JS. Memory-hostile but correct.
    const buf = await this.ws.readFile(path);
    if (!buf) throw new Error(`File not found: ${path}`);
    const end = byteLength === undefined ? buf.length : Math.min(buf.length, byteOffset + byteLength);
    if (end > byteOffset) yield buf.subarray(byteOffset, end);
  }
}
