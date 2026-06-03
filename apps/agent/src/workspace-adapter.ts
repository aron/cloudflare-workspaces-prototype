/**
 * Adapters that bridge the new @cloudflare/workspace surface
 * (Workspace.fs.* / WorkspaceStub.fs.*) to the shapes vendored
 * @cloudflare/fs-tools and ad-hoc agent code expect.
 *
 * Two consumers:
 *
 *   - `adaptForFsTools(stub)` returns the `WorkspaceLike` shape
 *     `@cloudflare/fs-tools.WorkspaceFileStore` was written
 *     against (flat `stat / readFile / writeFile`, with `stat`
 *     returning the old `{ type: "file" | "dir", size, mtime, mode }`
 *     and `readFile` resolving to a `Uint8Array | null`).
 *
 *   - `drain(stream)` collects a `ReadableStream<Uint8Array>`
 *     into a single buffer. The new `fs.readFile(path)` returns
 *     a stream; the old API returned bytes outright.
 */
import type { WorkspaceStub } from "@cloudflare/workspace";

export interface OldWorkspaceFileShape {
  stat(
    path: string,
  ): Promise<{ type: "file" | "dir"; size: number; mtime: number; mode: number } | null>;
  readFile(path: string): Promise<Uint8Array | null>;
  writeFile(path: string, content: Uint8Array | string, mode?: number): Promise<void>;
}

/**
 * Wrap a `WorkspaceStub` (returned from `Sandbox.getWorkspace()`)
 * in the old flat shape `WorkspaceFileStore` expects. Methods are
 * lazy/async so a missing file surfaces as `null` rather than the
 * ENOENT the new API throws.
 */
export function adaptForFsTools(stub: WorkspaceStub): OldWorkspaceFileShape {
  return {
    async stat(path) {
      try {
        const s = await stub.fs.stat(path);
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
        const stream = await stub.fs.readFile(path);
        return await drain(stream);
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async writeFile(path, content, mode) {
      const bytes =
        typeof content === "string" ? new TextEncoder().encode(content) : content;
      await stub.fs.writeFile(path, bytes, mode !== undefined ? { mode } : {});
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
