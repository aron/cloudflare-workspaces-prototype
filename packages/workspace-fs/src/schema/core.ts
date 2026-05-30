// Filesystem-side tables. These hold the inode graph and the
// content-addressed blob store. See docs/03_filesystem_schema.md.

export const SCHEMA_VERSION = 1;
export const ROOT_INODE = 1;

export const CORE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS vfs_meta (
    k TEXT PRIMARY KEY,
    v INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS vfs_nodes (
    inode         INTEGER PRIMARY KEY AUTOINCREMENT,
    type          TEXT    NOT NULL CHECK(type IN ('file','dir')),
    mode          INTEGER NOT NULL DEFAULT 493,
    mtime         INTEGER NOT NULL,
    rev           INTEGER NOT NULL DEFAULT 0,
    mount_root    TEXT,
    stub_size     INTEGER,
    manifest_hash BLOB
  )`,
  `CREATE TABLE IF NOT EXISTS vfs_dirents (
    parent_inode INTEGER NOT NULL,
    name         TEXT    NOT NULL,
    child_inode  INTEGER NOT NULL,
    PRIMARY KEY (parent_inode, name)
  )`,
  `CREATE INDEX IF NOT EXISTS vfs_dirents_by_child ON vfs_dirents(child_inode)`,
  `CREATE TABLE IF NOT EXISTS vfs_blobs (
    hash      BLOB    PRIMARY KEY,
    size      INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS vfs_blob_bytes (
    hash  BLOB PRIMARY KEY REFERENCES vfs_blobs(hash) ON DELETE CASCADE,
    bytes BLOB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS vfs_chunks (
    inode INTEGER NOT NULL,
    idx   INTEGER NOT NULL,
    hash  BLOB    NOT NULL,
    size  INTEGER NOT NULL,
    PRIMARY KEY (inode, idx)
  )`,
  `CREATE INDEX IF NOT EXISTS vfs_chunks_by_hash ON vfs_chunks(hash)`,
] as const;
