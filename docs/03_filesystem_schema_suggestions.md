# 03. Filesystem Schema — Suggestions

> **Status (post-review).** Items marked ~~struck~~ have been folded
> into `03_filesystem_schema.md`. Items tagged “appendix” landed in
> the doc's “Future considerations” section. All tables in the
> integrated design use the `cf_vfs_*` / `_cf_vfs_*` prefix; references
> in this file to `cf_*` predate the rename. Remaining items stay as
> live proposals.

Proposals against `03_filesystem_schema.md`. Ordered by leverage.

## ~~1. Inode-style indirection~~ — integrated

**Problem.** `cf_nodes.path` and `cf_chunks.path` are the primary keys. A
rename of `/workspace/foo` to `/workspace/bar` has to rewrite every
descendant row in both tables. For a directory with N files and C total
chunks that is O(N + C) writes inside a single transaction. Same cost
for `mv node_modules node_modules.bak` or any tool that renames a build
output directory.

It also blocks symlinks (no stable identity to point at) and hardlinks
(same).

**Proposal.** Split path lookup from node identity.

```sql
CREATE TABLE cf_nodes (
  inode         INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT    NOT NULL CHECK(type IN ('file','dir','symlink')),
  mode          INTEGER NOT NULL DEFAULT 493,
  mtime         INTEGER NOT NULL,
  rev           INTEGER NOT NULL DEFAULT 0,
  mount_root    TEXT,
  stub_size     INTEGER,
  ignored       INTEGER NOT NULL DEFAULT 0,
  manifest_hash BLOB,
  link_target   TEXT                                  -- symlinks only
);

CREATE TABLE cf_dirents (
  parent_inode INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  child_inode  INTEGER NOT NULL,
  PRIMARY KEY (parent_inode, name)
);
CREATE INDEX cf_dirents_by_child ON cf_dirents(child_inode);

CREATE TABLE cf_chunks (
  inode INTEGER NOT NULL,
  idx   INTEGER NOT NULL,
  hash  BLOB    NOT NULL,
  size  INTEGER NOT NULL,
  PRIMARY KEY (inode, idx)
);
```

Path resolution becomes a walk down `cf_dirents` from the root inode.
With a covering index on `(parent_inode, name)` this is O(depth) and
SQLite executes it as a tight loop. Rename is one `UPDATE cf_dirents`.
Hardlinks fall out for free (two dirents pointing at the same inode).
Symlinks get a clean home in `link_target`.

**Cost.** Every path lookup gains a tree walk. For typical agent trees
(<10 deep) this is sub-millisecond. The win on rename and the unblock
on symlinks more than pays for it.

~~**Migration.** Schema-version bump in `_cf_watermark`, one-shot
migration on first open of an old store.~~

**Correction from review.** This is net new — no on-disk data exists
to migrate. The schema ships in the inode form from the start.

Folded into `03_filesystem_schema.md` (`cf_vfs_nodes`, `cf_vfs_dirents`,
`cf_vfs_chunks` keyed by `inode`).

## ~~2. Split blob metadata from blob bytes~~ — integrated

**Problem.** `cf_blobs` holds `(hash, size, bytes, last_seen)`. The GC
clock updates `last_seen` on every reference touch, which rewrites the
SQLite page holding `bytes` (possibly several pages for large blobs).
Hot blobs (the manifest blob, common-vendored files) get their MB-sized
row rewritten on every access.

**Proposal.**

```sql
CREATE TABLE cf_blobs (
  hash      BLOB PRIMARY KEY,
  size      INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE cf_blob_bytes (
  hash  BLOB PRIMARY KEY REFERENCES cf_blobs(hash) ON DELETE CASCADE,
  bytes BLOB NOT NULL
);
```

`last_seen` updates touch a small fixed-size row. Bytes pages stay
cold. Drop-in change, no API impact.

Folded into `03_filesystem_schema.md` as `cf_vfs_blobs` +
`cf_vfs_blob_bytes` with `ON DELETE CASCADE`.

## ~~3. Tier large blobs to R2~~ — moved to appendix

**Problem.** All bytes live in DO SQLite. The advertised cap is ~10 GB
shared with the host DO. A single large dataset (parquet, sqlite, model
weights, video) eats the entire budget.

**Proposal.** Add an optional `r2` binding to `WorkspaceOptions`.
Blobs over a configurable threshold (default 4 MiB) write through to
R2 keyed by `hex(hash)`; `cf_blob_bytes` keeps small/hot content
in-DO.

```sql
ALTER TABLE cf_blobs ADD COLUMN location TEXT NOT NULL DEFAULT 'sqlite';
-- 'sqlite' | 'r2'
```

Reads check `location` and dispatch. Adds a network hop on cold reads
of large blobs; agent workloads rarely re-read large blobs.

Promoted to “Future considerations → Tier large blobs to R2” in
`03_filesystem_schema.md`. 10 GB is sufficient for the initial
agent-scale workloads; revisit when a real use case needs more.

## 4. Content-defined chunking — moved to appendix, with clarification

**Status from review.** Item kept as a future option, but the original
phrasing was too compressed to be useful. Expanded explanation now
lives in `03_filesystem_schema.md` “Future considerations →
Content-defined chunking,” including a worked example of why fixed
boundaries lose dedup on head-insertions and how a rolling-hash
boundary picker fixes it.

Short version, for context here:

- Fixed chunking splits at multiples of 512 KiB. A byte inserted near
  the start of a large file shifts every later boundary by one, so
  every later chunk has a different sha256 and the whole file has to
  be re-fetched on the next pull.
- Content-defined chunking (FastCDC, Rabin) picks boundaries by
  looking for byte patterns in a sliding window. Because the pattern
  is local to the bytes around it — not the absolute offset — a
  head-insertion only disturbs the chunk containing the inserted
  bytes. Later chunks keep their hashes and dedup catches them.
- Cost: rolling-hash CPU per write, plus slight chunk-size
  variability. Worth it only when files are large and edited in the
  middle; for text and append patterns the fixed scheme is fine.

Defaults stay fixed-size; CDC is a future opt-in (per mount or
above a file-size threshold). Manifest format does not change —
switching strategies is safe at the data layer.

## ~~5. Prune `cf_changes` tombstones~~ — integrated

**Problem.** `cf_changes` grows forever. The doc has no retention
rule.

**Proposal.** After every successful push to the container, delete
rows with `rev <= pushRev`. The container has acknowledged them; no
future pull needs to replay them. Single `DELETE` in the same
transaction that advances `pushRev`.

Folded into `03_filesystem_schema.md` `cf_vfs_changes` (“Pruning”
paragraph).

## ~~6. Schema version~~ — integrated

**Problem.** No on-disk schema version. The next migration will be
guesswork.

**Proposal.**

```sql
INSERT INTO _cf_watermark (k, v) VALUES ('schema_version', 1);
```

Bumped by every migration. Open() refuses to run if the binary is
older than the on-disk version.

Folded into `03_filesystem_schema.md` `cf_vfs_meta` (holds
`schema_version` alongside the singleton `rev`).

## ~~7. Document hot-row contention on `cf_rev`~~ — integrated

`cf_rev` is a single-row counter. This is correct given the
per-Workspace FIFO in `02_sync_protocol.md`, but the schema doc should
say so out loud. One sentence: "Mutations are serialized upstream by
the Workspace FIFO; `cf_rev` is a single-writer counter."

Folded into `03_filesystem_schema.md` `cf_vfs_meta` (paragraph on
single-writer semantics and the Workspace FIFO).

## ~~8. Symlinks and (eventually) xattrs~~ — moved to appendix

Already implied by proposal 1. Worth stating as an explicit
non-goal-for-now or roadmap item, since real tooling (`pnpm`,
`node_modules/.bin`, build outputs) leans on symlinks.

Promoted to “Future considerations → Symlinks and xattrs” in
`03_filesystem_schema.md`. Both are additive (extending the `type`
check + a `link_target` column for symlinks, a separate
`cf_vfs_xattrs(inode, key, value)` table for xattrs).

## Suggested ordering (remaining items)

All eight proposals have landed. Items 1, 2, 5, 6, 7 are in the main
schema; items 3, 4, 8 are in the “Future considerations” appendix.
Nothing remains as a live proposal here — future schema work should
open a fresh suggestions file rather than reviving this one.
