import { createWorkspaceError } from "../errors.js";
import type { Database } from "../storage.js";
import { resolveInode } from "./resolve.js";

interface ChunkRow {
  hash: Uint8Array;
  size: number;
}

// Returns the file content as a stream. A higher layer (the Workspace
// wrapper that exposes the package-level API) is responsible for the
// `"utf8"` overload that collapses the stream into a string; keeping
// this layer single-shape makes the chunk/blob plumbing easier to
// reason about.
export async function readFile(
  db: Database,
  path: string,
  now: () => number = Date.now,
): Promise<ReadableStream<Uint8Array>> {
  // Resolve up front so we surface ENOENT/EISDIR before any streaming
  // work happens.
  const node = resolveInode(db, path);
  if (node === null) {
    throw createWorkspaceError("ENOENT", `no such file: ${path}`, path);
  }
  if (node.type !== "file") {
    throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
  }

  const chunks = db.all<ChunkRow>(
    "SELECT hash, size FROM cf_vfs_chunks WHERE inode = ? ORDER BY idx",
    node.inode,
  );

  // Stream form. One Uint8Array per chunk, pulled lazily. last_seen
  // is touched per chunk on read; that's the GC clock signal
  // documented in 03_filesystem_schema.md.
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[i++];
      const row = db.one<{ bytes: Uint8Array }>(
        "SELECT bytes FROM cf_vfs_blob_bytes WHERE hash = ?",
        chunk.hash,
      );
      if (row === undefined) {
        controller.error(createWorkspaceError("EIO", `missing blob bytes for ${path}`, path));
        return;
      }
      db.run("UPDATE cf_vfs_blobs SET last_seen = ? WHERE hash = ?", now(), chunk.hash);
      controller.enqueue(row.bytes);
    },
  });
}
