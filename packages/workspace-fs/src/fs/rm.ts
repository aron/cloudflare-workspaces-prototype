import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import { incrementRev } from "../rev.js";
import type { Database } from "../storage.js";
import { recordDelete } from "../sync/changes.js";
import { resolveInode } from "./resolve.js";

export interface RmOptions {
  recursive?: true;
  force?: true;
}

interface DirChild {
  name: string;
  child_inode: number;
  type: "file" | "dir";
}

// Walk a directory subtree post-order so we delete leaves before
// parents. Yields { path, inode, type } for each node to remove. The
// caller appends one tombstone per yielded path and clears
// vfs_chunks for file inodes.
function* walkPostOrder(
  db: Database,
  rootInode: number,
  rootPath: string,
): Generator<{ path: string; inode: number; type: "file" | "dir" }> {
  // Stack-based DFS to avoid recursion limits on deep trees.
  type Frame = { inode: number; path: string; type: "file" | "dir"; expanded: boolean };
  const stack: Frame[] = [{ inode: rootInode, path: rootPath, type: "dir", expanded: false }];

  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.type === "file" || top.expanded) {
      stack.pop();
      yield { path: top.path, inode: top.inode, type: top.type };
      continue;
    }
    top.expanded = true;
    const children = db.all<DirChild>(
      `SELECT d.name AS name, d.child_inode AS child_inode, n.type AS type
         FROM vfs_dirents d
         JOIN vfs_nodes n ON n.inode = d.child_inode
        WHERE d.parent_inode = ?
        ORDER BY d.name`,
      top.inode,
    );
    for (const child of children) {
      const childPath = top.path === "/" ? `/${child.name}` : `${top.path}/${child.name}`;
      stack.push({
        inode: child.child_inode,
        path: childPath,
        type: child.type,
        expanded: false,
      });
    }
  }
}

export function rm(db: Database, path: string, options: RmOptions): void {
  const { parts, path: canonical } = canonicalizePath(path);

  if (parts.length === 0) {
    // The workspace root is structural; refuse to delete it even with
    // recursive+force. Matches the doc's example.
    throw createWorkspaceError("EPERM", `cannot remove the root directory`, canonical);
  }

  const force = options.force === true;
  const recursive = options.recursive === true;

  db.transactionSync(() => {
    const node = resolveInode(db, canonical);
    if (node === null) {
      if (force) return;
      throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
    }

    if (node.type === "dir" && !recursive) {
      const childCount = db.scalar<number>(
        "SELECT COUNT(*) FROM vfs_dirents WHERE parent_inode = ?",
        node.inode,
      );
      if ((childCount ?? 0) > 0) {
        throw createWorkspaceError("ENOTEMPTY", `directory not empty: ${canonical}`, canonical);
      }
    }

    const rev = incrementRev(db);

    if (node.type === "file" || !recursive) {
      // Single inode removal — file, or empty directory.
      removeInode(db, node.inode, node.type);
      recordDelete(db, rev, canonical);
      return;
    }

    // Recursive directory removal. Walk leaves first so each delete
    // sees an empty parent by the time we get to it.
    for (const entry of walkPostOrder(db, node.inode, canonical)) {
      removeInode(db, entry.inode, entry.type);
      recordDelete(db, rev, entry.path);
    }
  });
}

function removeInode(db: Database, inode: number, type: "file" | "dir"): void {
  // Drop the dirent referencing this inode. There should be exactly one
  // (no hardlinks yet); if zero, we're deleting the root which we've
  // already refused.
  db.run("DELETE FROM vfs_dirents WHERE child_inode = ?", inode);
  if (type === "file") {
    db.run("DELETE FROM vfs_chunks WHERE inode = ?", inode);
  }
  db.run("DELETE FROM vfs_nodes WHERE inode = ?", inode);
}
