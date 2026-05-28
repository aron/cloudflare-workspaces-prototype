# 03. Filesystem Schema

The VFS lives in the Durable Object's SQLite. Every read and write
ultimately hits one of these tables. All tables are prefixed with `cf_`
(or `_cf_` for internal bookkeeping) so they don't collide with
application-owned tables in the same DO storage.

## Tables

### `cf_rev` — monotonic write counter

```sql
CREATE TABLE cf_rev (
  id  INTEGER PRIMARY KEY CHECK(id = 1),
  val INTEGER NOT NULL DEFAULT 0
);
```

Single row. Bumped atomically on every mutation; the new value is stamped
into `cf_nodes.rev` (or `cf_changes.rev`) to drive incremental sync. See
[02. Sync Protocol](./02_sync_protocol.md).

### `cf_nodes` — path metadata

```sql
CREATE TABLE cf_nodes (
  path          TEXT    PRIMARY KEY,
  type          TEXT    NOT NULL CHECK(type IN ('file','dir')),
  mode          INTEGER NOT NULL DEFAULT 493,        -- 0o755
  mtime         INTEGER NOT NULL,                    -- ms since epoch
  rev           INTEGER NOT NULL DEFAULT 0,          -- last write's cf_rev
  mount_root    TEXT,                                -- nullable; tags mount provenance
  stub_size     INTEGER,                             -- non-null while a lazy stub
  ignored       INTEGER NOT NULL DEFAULT 0,          -- 1 if matched by pullIgnore
  manifest_hash BLOB                                 -- references cf_manifests.hash
);
```

One row per live path. `mount_root` records the mount this row originated
from, used for write-rejection and writable-mount mirroring. `stub_size`
is non-null while the file is a lazy-mount stub whose bytes haven't been
fetched yet — `stat()` reports it as the file size and the first read
fetches the bytes. `ignored = 1` marks an entry that exists for `stat`
and `readdir` but has no content on the DO side (see
[02. Sync Protocol](./02_sync_protocol.md#ignore-lists)).

### `cf_blobs` — content-addressed chunk store

```sql
CREATE TABLE cf_blobs (
  hash      BLOB    PRIMARY KEY,   -- 32 bytes, sha256(bytes)
  size      INTEGER NOT NULL,       -- length(bytes)
  bytes     BLOB    NOT NULL,
  last_seen INTEGER NOT NULL        -- ms since epoch; touched on every ref (GC clock)
);
```

Every file chunk and every manifest is stored here, keyed by sha256.
Identical bytes anywhere in the tree share one row.

### `cf_chunks` — file content mapping

```sql
CREATE TABLE cf_chunks (
  path TEXT    NOT NULL,
  idx  INTEGER NOT NULL,            -- chunk index inside the file (0-based)
  hash BLOB    NOT NULL,            -- references cf_blobs.hash
  size INTEGER NOT NULL,            -- denormalized for fast stat()/SUM()
  PRIMARY KEY (path, idx)
);
CREATE INDEX cf_chunks_by_hash ON cf_chunks(hash);
```

Files are split into chunks of at most `CHUNK_SIZE` (512 KiB). Each chunk
is one row pointing at the underlying blob. The by-hash index lets the
manifest pull resolve "which paths share this blob" quickly.

### `cf_manifests` — chunk-list lookup

```sql
CREATE TABLE cf_manifests (
  hash    BLOB    PRIMARY KEY,    -- sha256(encoded)
  size    INTEGER NOT NULL,        -- total file size in bytes
  encoded BLOB    NOT NULL         -- 0x01 || repeated (32-byte hash || varint offset || varint size)
);
```

A manifest is the ordered `(chunk hash, size)` list for one file. Files
with identical content share a manifest hash (and thus avoid being
re-uploaded over the sync wire). The `manifest_hash` column on
`cf_nodes` points here.

### `cf_changes` — tombstones

```sql
CREATE TABLE cf_changes (
  rev  INTEGER PRIMARY KEY,
  path TEXT    NOT NULL,
  op   TEXT    NOT NULL CHECK(op IN ('delete'))
);
```

Deletes leave no row in `cf_nodes`, so they're recorded here so the
incremental push can tell the container "this path is gone". `rev`
matches the bumped `cf_rev` value at delete time.

### `_cf_watermark` — sync state

```sql
CREATE TABLE _cf_watermark (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
```

Stores `pushRev` and `pullRev` (see
[02. Sync Protocol](./02_sync_protocol.md#watermarks)). Survives DO
restarts so reconnects resume cleanly.

### `_cf_mounts` — mount index state

```sql
CREATE TABLE _cf_mounts (
  root    TEXT PRIMARY KEY,
  kind    TEXT NOT NULL,
  indexed INTEGER NOT NULL DEFAULT 0
);
```

Tracks which mounts have been indexed. Once a mount is indexed (its
directory tree has been listed and stub rows inserted into `cf_nodes`),
that fact is persisted so a DO reload doesn't re-list.

## Invariants

- A `cf_nodes` row with `type = 'file'` has either:
  - `stub_size NOT NULL` and no `cf_chunks` rows (lazy stub), **or**
  - `ignored = 1` and no `cf_chunks` rows (ignored entry), **or**
  - `manifest_hash NOT NULL`, a matching `cf_manifests` row, and one
    `cf_chunks` row per chunk.
- Every `cf_chunks.hash` references an existing `cf_blobs.hash`.
- Every `cf_manifests.hash` referenced by `cf_nodes.manifest_hash` exists.
- `cf_rev.val` is strictly greater than every `cf_nodes.rev` and every
  `cf_changes.rev` between transactions.

## Garbage collection

`Workspace.gc(safetyWindowMs?)` sweeps `cf_blobs` and `cf_manifests` for
rows with no live references and a `last_seen` older than the safety
window (default conservative). It returns
`{ manifestsFreed, blobsFreed }`.
