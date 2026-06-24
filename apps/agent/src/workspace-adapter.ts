/**
 * Adapter that bridges the `@cloudflare/workspace` filesystem
 * surface (`Workspace.fs` / `WorkspaceStub.fs`) to the shape
 * vendored `@cloudflare/fs-tools.WorkspaceFileStore` expects.
 *
 * `fs-tools` was originally written against the pre-published
 * `@cloudflare/workspace` shape \u2014 a flat `stat / readFile /
 * writeFile` API where `stat` returned the old
 * `{ type: "file" | "dir", size, mtime, mode }` and `readFile`
 * resolved to a `Uint8Array | null`. The published package
 * exposes a stream-based `readFile` and a richer `stat`. We adapt
 * back to the flat shape here so the file tools keep working
 * unchanged.
 *
 * Both `Workspace.fs` (live in-isolate) and `WorkspaceStub.fs`
 * (RPC stub) implement the same surface, so the adapter is
 * structurally typed and accepts either.
 */
import type { Workspace, WorkspaceStub } from "@cloudflare/workspace";

export interface OldWorkspaceFileShape {
  stat(
    path: string,
  ): Promise<{ type: "file" | "dir"; size: number; mtime: number; mode: number } | null>;
  readFile(path: string): Promise<Uint8Array | null>;
  writeFile(path: string, content: Uint8Array | string, mode?: number): Promise<void>;
  deleteFile(path: string): Promise<void>;
}

/** Anything with the `fs` getter our adapter calls into. */
type FsHolder = Pick<Workspace, "fs"> | Pick<WorkspaceStub, "fs">;

/**
 * Wrap a `Workspace` or `WorkspaceStub` in the old flat shape
 * `WorkspaceFileStore` expects. Methods are lazy/async so a
 * missing file surfaces as `null` rather than the ENOENT the
 * new API throws.
 */
export function adaptForFsTools(host: FsHolder): OldWorkspaceFileShape {
  return {
    async stat(path) {
      try {
        const s = await host.fs.stat(path);
        return {
          type: s.isDirectory ? "dir" : "file",
          size: s.size ?? 0,
          mtime: s.mtime ?? 0,
          mode: s.mode ?? 0o644,
        };
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async readFile(path) {
      try {
        const stream = await host.fs.readFile(path);
        return await drain(stream as ReadableStream<Uint8Array>);
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async writeFile(path, content, mode) {
      const bytes =
        typeof content === "string" ? new TextEncoder().encode(content) : content;
      await host.fs.writeFile(path, bytes, mode !== undefined ? { mode } : {});
    },
    async deleteFile(path) {
      await host.fs.rm(path, { force: true });
    },
  };
}

export async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        parts.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function isEnoent(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string };
  if (e.code === "ENOENT") return true;
  return typeof e.message === "string" && /ENOENT|no such/i.test(e.message);
}
