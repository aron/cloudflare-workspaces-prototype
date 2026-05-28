# 03. Filesystem Schema

The VFS lives in the Durable Object's SQLite. Every read and write
ultimately hits one of these tables. All tables are prefixed with
`cf_vfs_` (or `_cf_vfs_` for internal bookkeeping) so they don't
collide with application-owned tables in the same DO storage.

Paths are resolved through an inode-style indirection (`cf_vfs_dirents`
→ `cf_vfs_nodes`), so renames are O(1) regardless of subtree size and
hardlinks fall out for free.

## Tables

### `cf_vfs_meta` — schema version and singletons

```sql
CREATE TABLE cf_vfs_meta (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
```

Holds `schema_version` (bumped by every migration) and the singleton
revision counter row `rev`. Open() refuses to run if the binary is
older than the on-disk `schema_version`.

`rev` is bumped atomically on every mutation; the new value is stamped
into `cf_vfs_nodes.rev` (or `cf_vfs_changes.rev`) to drive incremental
sync. Mutations are serialized upstream by the Workspace FIFO (see
[02. Sync Protocol](./02_sync_protocol.md#failure-handling)), so this
single-row counter is never contended in practice — but it is
deliberately single-writer, and adding concurrent mutators would
require revisiting it.

### `cf_vfs_nodes` — inode metadata

```sql
CREATE TABLE cf_vfs_nodes (
  inode         INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT    NOT NULL CHECK(type IN ('file','dir')),
  mode          INTEGER NOT NULL DEFAULT 493,        -- 0o755
  mtime         INTEGER NOT NULL,                    -- ms since epoch
  rev           INTEGER NOT NULL DEFAULT 0,          -- last write's rev
  mount_root    TEXT,                                -- nullable; tags mount provenance
  stub_size     INTEGER,                             -- non-null while a lazy stub
  manifest_hash BLOB                                 -- references cf_vfs_manifests.hash
);
```

One row per live inode. `mount_root` records the mount this row
originated from, used for write-rejection and writable-mount mirroring.
`stub_size` is non-null while the file is a lazy-mount stub whose
bytes haven't been fetched yet — `stat()` reports it as the file size
and the first read fetches the bytes.

There is no `ignored` column: ignored paths are entirely invisible to
the DO-side filesystem API (see
[02. Sync Protocol → Ignored entries](./02_sync_protocol.md#ignored-entries)).

### `cf_vfs_dirents` — name → inode mapping

```sql
CREATE TABLE cf_vfs_dirents (
  parent_inode INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  child_inode  INTEGER NOT NULL,
  PRIMARY KEY (parent_inode, name)
);
CREATE INDEX cf_vfs_dirents_by_child ON cf_vfs_dirents(child_inode);
```

Path resolution walks `cf_vfs_dirents` from the root inode (`inode = 1`,
created on init). For typical agent trees (<10 deep) this is
sub-millisecond. Rename is one `UPDATE`; hardlinks are two dirents
pointing at the same inode.

### `cf_vfs_blobs` — content-addressed chunk metadata

```sql
CREATE TABLE cf_vfs_blobs (
  hash      BLOB    PRIMARY KEY,   -- 32 bytes, sha256(bytes)
  size      INTEGER NOT NULL,       -- length(bytes)
  last_seen INTEGER NOT NULL        -- ms since epoch; touched on every ref (GC clock)
);
```

### `cf_vfs_blob_bytes` — chunk bytes

```sql
CREATE TABLE cf_vfs_blob_bytes (
  hash  BLOB PRIMARY KEY REFERENCES cf_vfs_blobs(hash) ON DELETE CASCADE,
  bytes BLOB NOT NULL
);
```

Metadata and bytes live in separate tables so GC-clock updates to
`last_seen` don't rewrite the SQLite pages holding the (potentially
large) `bytes` BLOB. Hot blobs get their small fixed-size row touched
on every reference; the byte pages stay cold.

Every file chunk and every manifest is stored here, keyed by sha256.
Identical bytes anywhere in the tree share one row.

### `cf_vfs_chunks` — file content mapping

```sql
CREATE TABLE cf_vfs_chunks (
  inode INTEGER NOT NULL,
  idx   INTEGER NOT NULL,           -- chunk index inside the file (0-based)
  hash  BLOB    NOT NULL,           -- references cf_vfs_blobs.hash
  size  INTEGER NOT NULL,           -- denormalized for fast stat()/SUM()
  PRIMARY KEY (inode, idx)
);
CREATE INDEX cf_vfs_chunks_by_hash ON cf_vfs_chunks(hash);
```

Files are split into chunks of at most `CHUNK_SIZE` (512 KiB). Each
chunk is one row pointing at the underlying blob. The by-hash index
lets the manifest pull resolve "which inodes share this blob" quickly.

### `cf_vfs_manifests` — chunk-list lookup

```sql
CREATE TABLE cf_vfs_manifests (
  hash    BLOB    PRIMARY KEY,    -- sha256(encoded)
  size    INTEGER NOT NULL,        -- total file size in bytes
  encoded BLOB    NOT NULL         -- 0x01 || repeated (32-byte hash || varint offset || varint size)
);
```

A manifest is the ordered `(chunk hash, size)` list for one file. Files
with identical content share a manifest hash (and thus avoid being
re-uploaded over the sync wire). The `manifest_hash` column on
`cf_vfs_nodes` points here.

### `cf_vfs_changes` — tombstones

```sql
CREATE TABLE cf_vfs_changes (
  rev  INTEGER PRIMARY KEY,
  path TEXT    NOT NULL,
  op   TEXT    NOT NULL CHECK(op IN ('delete'))
);
```

Deletes leave no row in `cf_vfs_nodes`, so they're recorded here for
the incremental push to tell the container "this path is gone". `rev`
matches the bumped `rev` value at delete time.

**Pruning.** Rows with `rev <= pushRev` are deleted in the same
transaction that advances `pushRev` (see
[02. Sync Protocol](./02_sync_protocol.md#watermarks)). The container
has acknowledged them; no future pull needs to replay them.

### `_cf_vfs_watermark` — sync state

```sql
CREATE TABLE _cf_vfs_watermark (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
```

Stores `pushRev` and `pullRev` (see
[02. Sync Protocol](./02_sync_protocol.md#watermarks)). Survives DO
restarts so reconnects resume cleanly.

### `_cf_vfs_mounts` — mount index state

```sql
CREATE TABLE _cf_vfs_mounts (
  root    TEXT PRIMARY KEY,
  kind    TEXT NOT NULL,
  indexed INTEGER NOT NULL DEFAULT 0
);
```

Tracks which mounts have been indexed. Once a mount is indexed (its
directory tree has been listed and stub rows inserted into
`cf_vfs_nodes`), that fact is persisted so a DO reload doesn't
re-list.

## Invariants

- The root directory is always `inode = 1`, type `dir`, with no
  parent dirent.
- A `cf_vfs_nodes` row with `type = 'file'` has either:
  - `stub_size NOT NULL` and no `cf_vfs_chunks` rows (lazy stub), **or**
  - `manifest_hash NOT NULL`, a matching `cf_vfs_manifests` row, and
    one `cf_vfs_chunks` row per chunk.
- Every `cf_vfs_chunks.hash` references an existing `cf_vfs_blobs.hash`.
- Every `cf_vfs_blobs.hash` has a matching `cf_vfs_blob_bytes` row.
- Every `cf_vfs_manifests.hash` referenced by
  `cf_vfs_nodes.manifest_hash` exists.
- Every `cf_vfs_dirents.child_inode` references an existing
  `cf_vfs_nodes.inode`.
- The singleton `rev` in `cf_vfs_meta` is strictly greater than every
  `cf_vfs_nodes.rev` and every `cf_vfs_changes.rev` between
  transactions.

## Garbage collection

`Workspace.gc(safetyWindowMs?)` sweeps `cf_vfs_blobs` and
`cf_vfs_manifests` for rows with no live references and a `last_seen`
older than the safety window (default conservative). Cascaded
`cf_vfs_blob_bytes` rows are deleted with their parent. It returns
`{ manifestsFreed, blobsFreed }`.

## Future considerations

Items deferred from the initial design. File an issue if a real use
case depends on a particular resolution.

### Tier large blobs to R2

All bytes currently live in DO SQLite. The advertised cap is ~10 GB
shared with the host DO, which is sufficient for agent-scale
workspaces. If a single workspace needs to hold large datasets
(parquet, sqlite databases, model weights, video), an optional R2
binding could write blobs over a configurable threshold (default
4 MiB) to R2 keyed by `hex(hash)`. Small/hot content stays in
`cf_vfs_blob_bytes`.

Sketch:

```sql
ALTER TABLE cf_vfs_blobs ADD COLUMN location TEXT NOT NULL DEFAULT 'sqlite';
-- 'sqlite' | 'r2'
```

Reads check `location` and dispatch. Adds a network hop on cold reads
of large blobs; agent workloads rarely re-read large blobs.

### Content-defined chunking

Today files are split at fixed 512 KiB boundaries. That works well for
append-mostly or tail-edit patterns: rewriting the last chunk of a
large file pulls back only the affected chunk, and dedup catches
identical content at identical offsets.

It loses dedup when bytes are **inserted near the head** of a large
file. Because the boundaries are at fixed multiples of 512 KiB, an
inserted byte at offset 0 shifts every subsequent boundary by one — so
every later chunk has new bytes at its boundaries and a different
sha256, even though 99% of the file is unchanged. The DO has to
re-fetch every chunk.

**Worked example.** A 50 MB file gets one new line prepended:

| Scheme | What changes on the wire |
| --- | --- |
| Fixed 512 KiB | All 100 chunks have new hashes; full re-fetch. |
| Content-defined (e.g. FastCDC) | One or two chunks near the head change; the rest still match because their boundaries are picked by content. |

**How CDC picks boundaries.** Rather than `every 512 KiB`, a rolling
hash (FastCDC, Rabin) slides byte-by-byte over the file and declares a
boundary whenever the hash matches a target pattern. Because the
pattern depends on the surrounding bytes — not the absolute offset —
inserting a byte at the head only disturbs the first chunk that
contained the insertion point. Every later boundary still lands at the
same byte-pattern it did before, so those chunks keep their hashes and
dedup catches them.

The cost is CPU per write (the rolling hash) and slight variability in
chunk size. Defaults stay fixed-size for simplicity; CDC would be
opt-in per mount or above a file-size threshold:

```ts
new Workspace({
  chunking: { strategy: "fastcdc", minSize: 256 << 10, maxSize: 1 << 20 },
});
```

Switching strategies is safe at the data layer: `(hash, size)` pairs
still uniquely identify a chunk; the manifest format does not change.
Files written under different strategies just don't share chunks with
each other, which is the same behaviour as files written with
different fixed chunk sizes today.

### Symlinks and xattrs

The current `cf_vfs_nodes` `type` is restricted to `'file' | 'dir'`,
and there is no place to hang per-inode metadata beyond `mode` and
`mtime`. Real tooling leans on both:

- **Symlinks.** `pnpm`'s `node_modules` layout, `node_modules/.bin`,
  many build outputs.
- **Extended attributes.** `setcap`, macOS quarantine flags, some
  language toolchains.

A future iteration would add `'symlink'` to the `type` check and a
`link_target TEXT` column on `cf_vfs_nodes`, plus a separate
`cf_vfs_xattrs(inode, key, value)` table. Both are additive; neither
is required for the initial agent workloads.

### Prior art and selective reuse

Several projects already represent a POSIX-like filesystem in SQLite.
Two are worth comparing against directly:

- **`narumatt/sqlitefs`** — a Rust FUSE driver backing a SQLite
  database. Schema is `metadata` + `data` + `dentry` + `xattr`, with
  inode-keyed metadata and `(file_id, block_num)` chunk rows. POSIX-
  complete (hardlinks, symlinks, xattrs, ACLs). Implementation is
  Rust-only, not a published spec; the schema is internal to the
  project.
- **Turso `tursodatabase/agentfs`** — a *published specification*
  (`SPEC.md`, currently v0.4) for an agent-oriented SQLite
  filesystem, with SDKs in TypeScript, Python, and Rust. The
  filesystem half of the spec uses `fs_inode` + `fs_dentry` +
  `fs_data` + `fs_symlink` + `fs_config`, plus optional
  `fs_whiteout` / `fs_origin` for overlay/copy-on-write semantics.
  Nanosecond-precision timestamps, full POSIX mode bits including
  special-file types, hardlinks via `nlink` and multiple dentries.

**Shape comparison.** AgentFS is the closer analogue and the more
interesting one because it ships a real spec we could implement
against. Mapping our tables onto AgentFS:

| AgentFS | Ours | Notes |
| --- | --- | --- |
| `fs_inode` | `cf_vfs_nodes` | Same role. AgentFS carries `nlink`, `uid`/`gid`, `rdev`, separate `atime`/`mtime`/`ctime` with `_nsec` columns. We carry `mtime` only plus content-sync columns (`rev`, `mount_root`, `stub_size`, `manifest_hash`). |
| `fs_dentry` | `cf_vfs_dirents` | Same role. AgentFS adds a surrogate `id INTEGER PRIMARY KEY AUTOINCREMENT`; we use the composite `(parent_inode, name)` directly. |
| `fs_data` | `cf_vfs_chunks` + `cf_vfs_blobs` + `cf_vfs_blob_bytes` | **Fundamental divergence.** AgentFS stores chunks as `(ino, chunk_index)` rows with the bytes inline — no content addressing, no dedup. Our split into hash-keyed blob metadata, blob bytes, and an `inode`-keyed chunk map is what makes the sync protocol's incremental transfer work. |
| `fs_symlink` | (not yet implemented) | AgentFS has a clean answer; our Future-considerations item should adopt the same `(ino, target)` shape. |
| `fs_config` | `cf_vfs_meta` | Same role. |
| `fs_whiteout`, `fs_origin` | (no equivalent) | Overlay/COW semantics. Not needed today; potentially interesting if read-only mount overlays grow up. |
| (no equivalent) | `cf_vfs_manifests` | Content-addressed per-file chunk list; required by our sync protocol. |
| (no equivalent) | `cf_vfs_changes` | Tombstones for incremental push; required by our sync protocol. |
| (no equivalent) | `_cf_vfs_watermark`, `_cf_vfs_mounts` | Sync and mount bookkeeping. |

**Why not adopt AgentFS as the schema.** The blocker is the data
table. AgentFS keys chunks by `(ino, chunk_index)` with raw bytes
inline; we key chunks by `sha256(bytes)` and dereference through a
manifest. The two are not slot-in compatible — our sync protocol
(`02_sync_protocol.md`) is *built* on hash-addressed chunk dedup and
manifest sharing across paths, both of which AgentFS explicitly does
not provide. AgentFS could in principle add content addressing as an
extension, but at that point we are extending the spec, not
consuming it.

Their non-filesystem tables (`tool_calls`, `kv_store`) and the
overlay-COW tables (`fs_whiteout`, `fs_origin`) solve different
problems than ours and don't fit our domain.

**Where to spend the reuse budget**

Two concrete borrows, no runtime dependency:

1. **Adopt AgentFS metadata fields where they cleanly map.** When
   symlinks land (Future considerations → Symlinks and xattrs), use
   AgentFS's `fs_symlink` shape — `(ino INTEGER PRIMARY KEY, target
   TEXT NOT NULL)`. When xattrs land, use their pattern. When
   nanosecond timestamps matter, mirror `*_nsec` columns rather than
   inventing our own encoding. POSIX `mode` bit semantics, `nlink`,
   `uid`/`gid`/`rdev`: align with their definitions even if we don't
   surface every field today.
2. **Document the divergence and the integration path.** A
   `cf_vfs_*` workspace lives happily alongside an AgentFS database
   in the same DO storage (different prefixes), so an agent could
   use AgentFS for tool-call audit + KV state and our workspace for
   the synced FUSE-mounted file tree. Worth saying explicitly so
   nobody assumes the two compete.

**Where to *not* spend it**

- Don't replace our chunk store with `fs_data`. We lose every dedup
  win and break the sync protocol.
- Don't pull in `agentfs-sdk` as a runtime dep. The DO already talks
  to SQLite directly; a host-side SDK adds an indirection without
  giving us anything we don't have.
- Don't adopt `sqlitefs`'s schema. It's an implementation, not a
  spec, and the FUSE-on-host model is the opposite of our DO-side-
  truth model.

**If AgentFS ever publishes a content-addressed extension** to the
data table, revisit this decision. The metadata-side alignment we've
described above would make adopting it a small change.
