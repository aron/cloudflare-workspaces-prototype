import { createWorkspaceError } from "./errors.js";
import { Database } from "./storage.js";

export const SCHEMA_VERSION = 1;
export const ROOT_INODE = 1;

interface MetaRow {
  v: number;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cf_vfs_meta (
    k TEXT PRIMARY KEY,
    v INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cf_vfs_nodes (
    inode         INTEGER PRIMARY KEY AUTOINCREMENT,
    type          TEXT    NOT NULL CHECK(type IN ('file','dir')),
    mode          INTEGER NOT NULL DEFAULT 493,
    mtime         INTEGER NOT NULL,
    rev           INTEGER NOT NULL DEFAULT 0,
    mount_root    TEXT,
    stub_size     INTEGER,
    manifest_hash BLOB
  )`,
  `CREATE TABLE IF NOT EXISTS cf_vfs_dirents (
    parent_inode INTEGER NOT NULL,
    name         TEXT    NOT NULL,
    child_inode  INTEGER NOT NULL,
    PRIMARY KEY (parent_inode, name)
  )`,
  `CREATE INDEX IF NOT EXISTS cf_vfs_dirents_by_child ON cf_vfs_dirents(child_inode)`,
  `CREATE TABLE IF NOT EXISTS cf_vfs_blobs (
    hash      BLOB    PRIMARY KEY,
    size      INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cf_vfs_blob_bytes (
    hash  BLOB PRIMARY KEY REFERENCES cf_vfs_blobs(hash) ON DELETE CASCADE,
    bytes BLOB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cf_vfs_chunks (
    inode INTEGER NOT NULL,
    idx   INTEGER NOT NULL,
    hash  BLOB    NOT NULL,
    size  INTEGER NOT NULL,
    PRIMARY KEY (inode, idx)
  )`,
  `CREATE INDEX IF NOT EXISTS cf_vfs_chunks_by_hash ON cf_vfs_chunks(hash)`,
  `CREATE TABLE IF NOT EXISTS cf_vfs_manifests (
    hash    BLOB    PRIMARY KEY,
    size    INTEGER NOT NULL,
    encoded BLOB    NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cf_vfs_changes (
    rev  INTEGER PRIMARY KEY,
    path TEXT    NOT NULL,
    op   TEXT    NOT NULL CHECK(op IN ('delete'))
  )`,
  `CREATE TABLE IF NOT EXISTS _cf_vfs_watermark (
    k TEXT PRIMARY KEY,
    v INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS _cf_vfs_mounts (
    root    TEXT PRIMARY KEY,
    kind    TEXT NOT NULL,
    indexed INTEGER NOT NULL DEFAULT 0
  )`,
] as const;

export function initializeSchema(db: Database, now: () => number): void {
  db.transactionSync(() => {
    for (const statement of SCHEMA_STATEMENTS) {
      db.run(statement);
    }

    const schemaVersion = db.one<MetaRow>("SELECT v FROM cf_vfs_meta WHERE k = ?", "schema_version")?.v;
    if (schemaVersion !== undefined && schemaVersion > SCHEMA_VERSION) {
      throw createWorkspaceError(
        "EIO",
        `Unsupported workspace filesystem schema version ${schemaVersion}`,
      );
    }

    db.run(
      "INSERT OR IGNORE INTO cf_vfs_meta (k, v) VALUES (?, ?)",
      "schema_version",
      SCHEMA_VERSION,
    );
    db.run("UPDATE cf_vfs_meta SET v = ? WHERE k = ?", SCHEMA_VERSION, "schema_version");
    db.run("INSERT OR IGNORE INTO cf_vfs_meta (k, v) VALUES (?, ?)", "rev", 1);
    db.run("INSERT OR IGNORE INTO _cf_vfs_watermark (k, v) VALUES (?, ?)", "pushRev", 0);
    db.run("INSERT OR IGNORE INTO _cf_vfs_watermark (k, v) VALUES (?, ?)", "fetchRev", 0);

    db.run(
      `INSERT OR IGNORE INTO cf_vfs_nodes
        (inode, type, mode, mtime, rev)
        VALUES (?, 'dir', ?, ?, 0)`,
      ROOT_INODE,
      0o755,
      now(),
    );
  });
}
