import { createHash } from "node:crypto";
import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import { incrementRev } from "../rev.js";
import { ROOT_INODE } from "../schema/index.js";
import type { Database } from "../storage.js";

// Fixed chunk size per docs/03_filesystem_schema.md and
// docs/02_sync_protocol.md. Exported so tests can size inputs precisely
// without hard-coding the magic number twice.
export const CHUNK_SIZE = 512 * 1024;

export type WriteFileContent = string | Uint8Array | ReadableStream<Uint8Array>;

export interface WriteFileOptions {
  mode?: number;
}

// Resolve directory-only paths (the parent of the target file). The
// final segment is handled by the caller. Returns the parent inode or
// throws ENOENT/ENOTDIR.
function resolveParent(db: Database, parts: string[], canonical: string): number {
  let parentInode = ROOT_INODE;
  for (let i = 0; i < parts.length - 1; i++) {
    const name = parts[i];
    const child = db.one<{ child_inode: number }>(
      "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
      parentInode,
      name,
    );
    if (child === undefined) {
      throw createWorkspaceError("ENOENT", `parent directory missing: ${canonical}`, canonical);
    }
    const next = db.one<{ inode: number; type: "file" | "dir" }>(
      "SELECT inode, type FROM vfs_nodes WHERE inode = ?",
      child.child_inode,
    );
    if (next === undefined) {
      throw createWorkspaceError("ENOENT", `dangling dirent: ${canonical}`, canonical);
    }
    if (next.type !== "dir") {
      throw createWorkspaceError(
        "ENOTDIR",
        `parent path segment is not a directory: ${canonical}`,
        canonical,
      );
    }
    parentInode = next.inode;
  }
  return parentInode;
}

async function materialize(content: WriteFileContent): Promise<Uint8Array> {
  if (typeof content === "string") {
    return new TextEncoder().encode(content);
  }
  if (content instanceof Uint8Array) {
    return content;
  }
  // ReadableStream — drain into one buffer. Memory cost = full file
  // size, matching node:fs/promises.writeFile semantics. Once the
  // streaming write path lands we can revisit; for now this keeps
  // the chunking logic uniform.
  const reader = content.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      parts.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

// sha256 with a synchronous code path so writeFile can be called both
// from async drivers (the FS API) and from sync drivers (the
// VirtualProvider). node:crypto is available natively on Node and
// polyfilled by workerd.
function sha256(bytes: Uint8Array): Uint8Array {
  const hash = createHash("sha256");
  hash.update(bytes);
  return new Uint8Array(hash.digest());
}

interface PreparedChunk {
  hash: Uint8Array;
  bytes: Uint8Array;
  size: number;
}

export function chunksOf(bytes: Uint8Array): PreparedChunk[] {
  const chunks: PreparedChunk[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, bytes.byteLength);
    // subarray (not slice) avoids an extra copy; sha256() takes its own
    // copy when needed.
    const slice = bytes.subarray(offset, end);
    const hash = sha256(slice);
    chunks.push({ hash, bytes: slice, size: slice.byteLength });
  }
  return chunks;
}

export async function writeFile(
  db: Database,
  path: string,
  content: WriteFileContent,
  options: WriteFileOptions,
  now: () => number,
): Promise<void> {
  const bytes = await materialize(content);
  writeFileSync(db, path, bytes, options, now);
}

// Synchronous entry point used by the VirtualProvider. Identical SQL
// to the async path; differs only in that the bytes have already been
// materialized.
export function writeFileSync(
  db: Database,
  path: string,
  bytes: Uint8Array,
  options: WriteFileOptions,
  now: () => number,
): void {
  const { parts, path: canonical } = canonicalizePath(path);
  if (parts.length === 0) {
    throw createWorkspaceError("EISDIR", "cannot write to the root directory", canonical);
  }
  const mode = (options.mode ?? 0o644) & 0o7777;
  const chunks = chunksOf(bytes);
  const mtime = now();

  db.transactionSync(() => {
    const parentInode = resolveParent(db, parts, canonical);
    const leafName = parts[parts.length - 1];
    const existing = db.one<{ child_inode: number }>(
      "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
      parentInode,
      leafName,
    );

    let inode: number;
    if (existing !== undefined) {
      const node = db.one<{ type: "file" | "dir" }>(
        "SELECT type FROM vfs_nodes WHERE inode = ?",
        existing.child_inode,
      );
      if (node?.type === "dir") {
        throw createWorkspaceError("EISDIR", `path is a directory: ${canonical}`, canonical);
      }
      inode = existing.child_inode;
      // Replace the chunk list. Orphaned blobs (if any) are cleaned up
      // by a later gc() pass.
      db.run("DELETE FROM vfs_chunks WHERE inode = ?", inode);
    } else {
      db.run(
        "INSERT INTO vfs_nodes (type, mode, mtime, rev) VALUES ('file', ?, ?, 0)",
        mode,
        mtime,
      );
      const allocated = db.scalar<number>("SELECT last_insert_rowid()");
      if (allocated === undefined) {
        throw createWorkspaceError("EIO", "failed to allocate inode");
      }
      inode = allocated;
      db.run(
        "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
        parentInode,
        leafName,
        inode,
      );
    }

    // Upsert blobs and write the new chunk list.
    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[idx];
      db.run(
        "INSERT INTO vfs_blobs (hash, size, last_seen) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET last_seen = excluded.last_seen",
        chunk.hash,
        chunk.size,
        mtime,
      );
      db.run(
        "INSERT INTO vfs_blob_bytes (hash, bytes) VALUES (?, ?) ON CONFLICT(hash) DO NOTHING",
        chunk.hash,
        chunk.bytes,
      );
      db.run(
        "INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)",
        inode,
        idx,
        chunk.hash,
        chunk.size,
      );
    }

    const rev = incrementRev(db);
    db.run(
      "UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ? WHERE inode = ?",
      mode,
      mtime,
      rev,
      inode,
    );
  });
}
