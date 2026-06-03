import { createWorkspaceError } from "../errors.js";
import type { Database } from "../storage.js";
import { CORE_STATEMENTS, ROOT_INODE, SCHEMA_VERSION } from "./core.js";
import { SYNC_STATEMENTS } from "./sync.js";

export { ROOT_INODE, SCHEMA_VERSION } from "./core.js";

interface MetaRow {
  v: number;
}

export function initializeSchema(db: Database, now: () => number): void {
  db.transactionSync(() => {
    for (const statement of CORE_STATEMENTS) {
      db.run(statement);
    }
    for (const statement of SYNC_STATEMENTS) {
      db.run(statement);
    }

    const schemaVersion = db.one<MetaRow>(
      "SELECT v FROM vfs_meta WHERE k = ?",
      "schema_version",
    )?.v;
    if (schemaVersion !== undefined && schemaVersion > SCHEMA_VERSION) {
      throw createWorkspaceError(
        "EIO",
        `Unsupported workspace filesystem schema version ${schemaVersion}`,
      );
    }

    db.run("INSERT OR IGNORE INTO vfs_meta (k, v) VALUES (?, ?)", "schema_version", SCHEMA_VERSION);
    db.run("UPDATE vfs_meta SET v = ? WHERE k = ?", SCHEMA_VERSION, "schema_version");
    db.run("INSERT OR IGNORE INTO vfs_meta (k, v) VALUES (?, ?)", "rev", 1);
    db.run("INSERT OR IGNORE INTO _vfs_watermark (k, v) VALUES (?, ?)", "pushRev", 0);
    db.run("INSERT OR IGNORE INTO _vfs_watermark (k, v) VALUES (?, ?)", "fetchRev", 0);

    db.run(
      `INSERT OR IGNORE INTO vfs_nodes
        (inode, type, mode, mtime, rev)
        VALUES (?, 'dir', ?, ?, 0)`,
      ROOT_INODE,
      0o755,
      now(),
    );
  });
}
