# Audit: `docs/03_filesystem_schema.md`

Scope: every claim in the doc about the SQLite schema, traced to source
in `packages/workspace-fs/src/`. Code is authoritative. The doc carries
an explicit "intended design / has diverged" banner, so every finding
below is read as "is this gap intentional design-forward, or is it
unintentional drift?". Default tag is `doc-fix`; flagged otherwise where
the code is clearly wrong.

## Files inspected

- `packages/workspace-fs/src/schema/core.ts`
- `packages/workspace-fs/src/schema/sync.ts`
- `packages/workspace-fs/src/schema/index.ts`
- `packages/workspace-fs/src/rev.ts`
- `packages/workspace-fs/src/sync/blobs.ts`
- `packages/workspace-fs/src/sync/manifests.ts`
- `packages/workspace-fs/src/sync/changes.ts`
- `packages/workspace-fs/src/sync/watermarks.ts`
- `packages/workspace-fs/src/fs/gc.ts`
- `packages/workspace-fs/src/fs/writeFile.ts`
- `packages/workspace-fs/src/provider.ts`, `index.ts`

## Review

### Correct (doc matches code)

- **`vfs_meta` DDL** (doc §`vfs_meta`, lines 25–28) matches
  `schema/core.ts` lines 8–11 exactly: `k TEXT PRIMARY KEY, v INTEGER
  NOT NULL`.
- **`vfs_meta` semantics** — `schema_version` and `rev` are both seeded
  in `schema/index.ts` (lines 32–34) and `rev` is bumped atomically in
  `rev.ts:incrementRev`. The doc's "Open() refuses to run if the binary
  is older than the on-disk `schema_version`" claim is implemented in
  `schema/index.ts` lines 21–30 (throws `EIO` if on-disk schema is
  newer than `SCHEMA_VERSION = 1`).
- **`vfs_nodes` DDL** (doc lines 46–56) matches `schema/core.ts` lines
  12–22 exactly: column names, types, the `0o755` default (`493`), the
  `type IN ('file','dir','symlink')` check, all nullable columns
  agreed.
- **`vfs_dirents` DDL and index** (doc lines 72–78) match
  `schema/core.ts` lines 23–29 exactly, including
  `vfs_dirents_by_child`.
- **`vfs_blobs` DDL** (doc lines 89–93) matches `schema/core.ts` lines
  31–35 exactly.
- **`vfs_blob_bytes` DDL** (doc lines 99–102) matches `schema/core.ts`
  lines 36–39 exactly, including the `ON DELETE CASCADE` foreign key.
- **`vfs_chunks` DDL and `vfs_chunks_by_hash` index** (doc lines
  116–123) match `schema/core.ts` lines 40–47 exactly.
- **`vfs_changes` DDL and index** (doc lines 148–154) match
  `schema/sync.ts` lines 12–18 exactly, including the
  `op IN ('delete')` check.
- **`_vfs_watermark` DDL** (doc lines 170–173) matches `schema/sync.ts`
  lines 19–22 exactly. Both `pushRev` and `fetchRev` are seeded at 0
  (`schema/index.ts` lines 35–36) as the doc implies.
- **`_vfs_mounts` DDL** (doc lines 183–187) matches `schema/sync.ts`
  lines 23–27 exactly.
- **Root inode invariant** — `ROOT_INODE = 1`, type `dir`, no dirent —
  is established in `schema/index.ts` lines 38–45.
- **`CHUNK_SIZE = 512 KiB`** — doc line 126 matches
  `fs/writeFile.ts:12`: `512 * 1024`.
- **GC return shape** — `{ manifestsFreed, blobsFreed }` (doc line 219)
  matches `fs/gc.ts:GcResult`.

### Drift — doc-fix (code wins, doc still valuable)

- **`vfs_manifests` schema: undocumented `last_seen` column.** Doc
  (lines 133–137) shows `(hash, size, encoded)`. Code (`schema/sync.ts`
  lines 6–11) defines `(hash, size, encoded, last_seen INTEGER NOT
  NULL DEFAULT 0)`. The column exists because `gc()` sweeps manifests
  by `last_seen < cutoff` (`fs/gc.ts` lines 41–48) and `buildManifest`
  refreshes it on every reference (`sync/manifests.ts` lines 64–70).
  This is the manifest-side mirror of `vfs_blobs.last_seen` and the
  doc's own GC section depends on it being there. Add the column to
  the DDL block. **Tag: `doc-fix`.**

- **`vfs_manifests.encoded` format.** Doc (line 136) describes
  `0x01 || repeated (32-byte hash || varint offset || varint size)`
  (a casync-style binary layout). Code stores a UTF-8 JSON blob:
  `{ "version": 1, "chunks": [{ "hash": "<hex>", "size": <n> }, …] }`
  (`sync/manifests.ts` lines 21–24, 43–50, 56–70). There is no offset
  field. The implementation comment (`sync/manifests.ts` lines 10–12)
  explicitly calls this a target-state divergence: "Encoding is JSON
  for now — readable, debuggable, and structurally identical to
  casync's `.caidx`. Phase 4 swaps the encoding to the `.caidx` byte
  layout without a schema change." The doc banner covers this, but
  the description is asymmetric with the rest of the document, which
  generally describes what the SQL actually contains today. **Tag:
  `doc-fix` — add a one-line note that the on-disk encoding is JSON in
  the current implementation and will switch to the byte layout
  shown.** Flag for `needs-decision` only if the planned byte layout
  is supposed to omit `offset` (since offsets are recoverable from a
  prefix-sum of `size`, the doc's inclusion of `varint offset` may be
  the bug, not the JSON form).

- **`vfs_nodes_by_rev` index undocumented.** `schema/core.ts:30`
  creates `CREATE INDEX IF NOT EXISTS vfs_nodes_by_rev ON
  vfs_nodes(rev)`. The doc lists indexes for every other table that
  has one (`vfs_dirents_by_child`, `vfs_chunks_by_hash`,
  `vfs_changes_by_rev`) but does not mention this one. It exists to
  support `coalesceChanges`'s `WHERE rev > sinceRev` scan over live
  inodes. Add to the `vfs_nodes` section. **Tag: `doc-fix`.**

- **GC API surface.** Doc (lines 215, 219) says
  `Workspace.gc(safetyWindowMs?)`. Code exports a free function
  `gc(db, options)` from `fs/gc.ts` with shape
  `{ now?: () => number; safetyWindowMs?: number }` — no `Workspace`
  class exists in the package; the host class is
  `SQLiteWorkspaceProvider` (`provider.ts:91`) and it does not expose
  `gc`. The function shape is a deliberate testability choice
  (injectable `now`). Either (a) document the actual signature, or
  (b) leave as-is under the design-target banner and add a one-line
  pointer to the current API. **Tag: `doc-fix`.**

- **`vfs_changes` pruning claim.** Doc (lines 162–165) states "Rows
  with `rev <= pushRev` are deleted in the same transaction that
  advances `pushRev`". No such `DELETE FROM vfs_changes` exists
  anywhere in `packages/workspace-fs/src/` (grep returns zero hits).
  `writeWatermark` (`sync/watermarks.ts` lines 18–24) only updates
  `_vfs_watermark`; it does not prune. This is target behaviour from
  `02_sync_protocol.md` that isn't built yet. Acceptable under the
  banner, but worth a one-line "(planned; not yet implemented)" so a
  reader auditing the code doesn't conclude the doc is lying.
  **Tag: `doc-fix`.**

- **`_vfs_mounts` is unused so far.** Doc (lines 190–193) describes
  it as load-bearing for mount-index persistence. Code only creates
  the table (`schema/sync.ts:23`) — no `INSERT` / `SELECT` in the
  package (grep confirms). Same situation as `vfs_changes` pruning:
  forward-looking, covered by the banner, worth a "(not yet
  populated)" hint. **Tag: `doc-fix`.**

### Drift — code-fix candidates

None observed. Every doc-vs-code mismatch above is either (a) the doc
describing a not-yet-built target the code is moving toward, or (b) the
code carrying a column / index the doc forgot to mention. Nothing in
the code looks wrong-on-its-own-terms.

### Notes / follow-ups

- The doc's "Invariants" section (lines 197–211) is fully consistent
  with the schema as written, including the `stub_size` xor
  `manifest_hash` rule for files. There is no enforcement in SQL
  (no CHECK constraint or trigger); it's an application-layer
  invariant. Worth noting in `02_sync_protocol.md` audit whether the
  apply / write paths actually maintain it — out of scope here.
- The doc's symlink section (lines 292–306) describes adding
  `'symlink'` to the type check and a `link_target TEXT` column as
  *future work*, but the schema already has both today
  (`schema/core.ts:14`, `:21`). No symlink read/write paths use them
  yet (the `type` enum is still effectively `'file' | 'dir'` from the
  FS module's perspective). The Future-considerations framing should
  be softened to "schema is in place; FS-layer support pending" once
  this audit is acted on. **Tag: `doc-fix`** (low priority).
- The doc claims `SCHEMA_VERSION` is "bumped by every migration"
  (line 31). Today there is exactly one version (`SCHEMA_VERSION = 1`,
  `schema/core.ts:4`) and `initializeSchema` is idempotent via
  `CREATE TABLE IF NOT EXISTS` — there is no migration framework. The
  forward-going-promise is fine; no action needed unless a real
  migration lands.

## Summary

The schema doc is in good shape on the table-by-table DDL: every column
name, type, default, and check constraint matches what `schema/core.ts`
and `schema/sync.ts` actually run. The drift is concentrated in three
areas, all `doc-fix`:

1. The doc forgot `vfs_manifests.last_seen` and the
   `vfs_nodes_by_rev` index.
2. The doc describes the manifest binary encoding and the GC method
   surface as if they were live, when both are forward-looking.
3. Pruning of `vfs_changes` and use of `_vfs_mounts` are described as
   live behaviour but not yet wired up — both deserve "(planned)"
   markers given how careful the rest of the doc is about
   intent-vs-current.

No code-fix or needs-decision items rise to blocker level. The single
question worth surfacing is whether the planned manifest binary layout
really needs both `offset` and `size` (since offsets are derivable);
flagging here so it's resolved before Phase 4 lands the encoding swap.
