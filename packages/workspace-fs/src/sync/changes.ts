import type { Database } from "../storage.js";

// Record a tombstone for a deleted path so the next push to the
// container learns the path is gone. Called by fs/rm inside the same
// transaction that bumped rev and removed the inode rows; the caller
// passes the post-bump rev value.
export function recordDelete(db: Database, rev: number, path: string): void {
  db.run("INSERT INTO cf_vfs_changes (rev, path, op) VALUES (?, ?, 'delete')", rev, path);
}
