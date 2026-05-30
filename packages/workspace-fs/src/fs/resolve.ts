import { canonicalizePath } from "../path.js";
import { ROOT_INODE } from "../schema/index.js";
import type { Database } from "../storage.js";

export interface ResolvedInode {
  inode: number;
  type: "file" | "dir";
  mode: number;
  mtime: number;
}

interface NodeRow {
  inode: number;
  type: "file" | "dir";
  mode: number;
  mtime: number;
}

interface ChildRow {
  child_inode: number;
}

// Walk vfs_dirents from ROOT_INODE down to `path`. Returns null when
// any segment is missing, or when an intermediate segment is a file
// (which a real filesystem would surface as ENOTDIR — callers map the
// `null` to the appropriate POSIX code based on context).
//
// `path` is canonicalized internally so callers can pass user input
// directly. Pre-canonicalized paths are also accepted and incur the
// same trivial re-canonicalization cost.
export function resolveInode(db: Database, path: string): ResolvedInode | null {
  const { parts } = canonicalizePath(path);

  const root = db.one<NodeRow>(
    "SELECT inode, type, mode, mtime FROM vfs_nodes WHERE inode = ?",
    ROOT_INODE,
  );
  if (root === undefined) {
    // initializeSchema was not run, or someone deleted the root row.
    // Either way the FS is unusable; surface as not-found rather than
    // throwing here.
    return null;
  }

  let current: NodeRow = root;
  for (const name of parts) {
    if (current.type !== "dir") {
      return null;
    }
    const child = db.one<ChildRow>(
      "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
      current.inode,
      name,
    );
    if (child === undefined) {
      return null;
    }
    const next = db.one<NodeRow>(
      "SELECT inode, type, mode, mtime FROM vfs_nodes WHERE inode = ?",
      child.child_inode,
    );
    if (next === undefined) {
      // Dangling dirent. The schema invariant in docs/03 says this
      // should never happen; treat as not-found rather than crash.
      return null;
    }
    current = next;
  }

  return {
    inode: current.inode,
    type: current.type,
    mode: current.mode,
    mtime: current.mtime,
  };
}
