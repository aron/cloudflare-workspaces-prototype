// Sync-protocol tables. Populated by the sync module; the FS module
// only writes to cf_vfs_changes (via sync/changes.ts) on rm. The rest
// of these tables stay empty until the sync task is implemented.

export const SYNC_STATEMENTS = [
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
