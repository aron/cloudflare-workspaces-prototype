# Audit: docs/06_mount_interface.md

## Scope

`docs/06_mount_interface.md` specifies a **Mount** subsystem that
pre-fills subtrees of the workspace VFS from external sources (R2,
GitHub, artifact bundles, custom providers). The doc covers: a `Mount`
union of `LazyMount`/`EagerMount`, a `MountFactory` + `MountContext`
indirection, built-in factories `R2Bucket()` and `GitHubRepo()`,
read-only vs read-write modes with debounced write-back,
`workspace.prefetch()` / `workspace.flushMounts()` / `onMountConflict`
hooks, an `_vfs_mounts` persistence table, and per-mount options
(`mode`, `ignore`, `writeBack`, `writeBackMs`, `maxBytes`,
`maxEntries`). The doc carries the standard "diverged from main"
banner.

This audit asks: how much of that exists in code today?

## Methodology

Read the doc end to end. Then traced every named symbol and every
behavioural claim to source under `packages/`:

- `packages/workspace/src/workspace.ts`, `index.ts`, `backend.ts`,
  `shell.ts` — the host-side facade and its options.
- `packages/workspace-fs/src/schema/core.ts`,
  `packages/workspace-fs/src/schema/sync.ts` — the SQLite schema, the
  place where mount state would land if it landed anywhere.
- `packages/workspace-fs/src/sync/fetch.ts` and the rest of `sync/`
  (push, fetch, apply, ignore, coalesce, watermarks).
- `packages/workspace-fs/src/{fs,provider.ts,storage.ts,index.ts}`.
- `packages/workspace-rpc/src/{server.ts,interface.ts}`.
- Repo-wide greps for `Mount`, `mounts`, `mount_root`, `_vfs_mounts`,
  `R2Bucket`, `GitHubRepo`, `LazyMount`, `EagerMount`, `MountFactory`,
  `MountContext`, `MountWriteApi`, `MountEntry`, `prefetch`,
  `flushMounts`, `onMountConflict`, `writeBack`, `isomorphic-git`,
  `GITHUB_TOKEN`. Also checked `packages/*/package.json` for any
  mount-related dependency.

## Findings

The dominant finding: **the entire mount feature described by this
doc is absent from the implementation.** The schema reserves seats
for it; nothing else does.

### Schema — partial / forward-looking (✅ for what exists)

- `packages/workspace-fs/src/schema/sync.ts:23-27` defines
  `_vfs_mounts(root TEXT PK, kind TEXT NOT NULL, indexed INTEGER
  NOT NULL DEFAULT 0)`. This matches the doc's claim that "Index
  state is persisted to `_vfs_mounts` in SQLite so DO restarts don't
  trigger a re-list" — but only at the table level. No code writes to
  or reads from this table anywhere in the repo (verified by grep:
  the only hits for `_vfs_mounts` are the `CREATE TABLE` statement
  and a schema test that asserts the statement exists).
- `packages/workspace-fs/src/schema/core.ts:18-19` reserves
  `mount_root TEXT` and `stub_size INTEGER` columns on `vfs_nodes`,
  consistent with the lazy-stub mechanism the doc describes. Again,
  no producer or consumer: grep across `packages/` finds zero reads
  or writes of either column outside the schema definition itself.

So the schema is consistent with the doc's design intent and was
pre-allocated; the runtime hasn't caught up.

### `WorkspaceOptions.mounts` — missing (❌)

`packages/workspace/src/workspace.ts:25-39` defines `WorkspaceOptions`
as exactly three fields: `storage`, `backends`, optional `now`.
There is no `mounts`, no `ignore`/`pullIgnore`, no
`onMountConflict`. The constructor (`workspace.ts:50-59`) likewise
ignores any such option. Passing `mounts: { ... }` today would be
silently dropped by TypeScript structural typing or rejected
depending on strictness — there is no plumbing behind it.

### `Mount` / `LazyMount` / `EagerMount` types — missing (❌)

Repo-wide grep for `LazyMount`, `EagerMount`, `MountFactory`,
`MountContext`, `MountWriteApi`, `MountEntry` returns **zero
matches** anywhere under `packages/`. None of these interfaces
exist.

### Built-in providers — missing (❌)

- `R2Bucket(binding, options?)` — no implementation. Grep finds no
  `R2Bucket` function/factory anywhere in `packages/`. No R2 binding
  is referenced in the workspace package at all.
- `GitHubRepo(slug, options)` — no implementation. No
  `isomorphic-git` dependency in any `packages/*/package.json`, no
  `GitHubRepo` symbol, no `GITHUB_TOKEN` references.

### `prefetch` / `flushMounts` / `refreshMount` — missing (❌)

`Workspace` exposes (from `workspace.ts`) `db`, `fs`, `shell`,
`ready()`, plus a couple of backend lifecycle bits. There is no
`prefetch`, no `flushMounts`, no `refreshMount`. Grep across the
whole repo confirms zero matches for any of those names.

### Lazy stub semantics — missing (❌)

The doc describes a stub system: `list()` inserts entries with
`stub_size` and `mount_root` set; first read calls `fetch(relPath)`
and replaces the stub with real bytes; concurrent reads dedupe per
absolute path. None of this is implemented. The FS read path in
`packages/workspace-fs/src/fs/*` and `provider.ts` does not branch
on `mount_root`, has no concept of a stub, and never calls into any
provider. There is no in-flight `fetch()` dedupe table.

### Write-back / debounce / conflict policy — missing (❌)

No `writeBack`, `writeBackMs`, debounce timer, mount mirror queue,
or `onMountConflict` hook exists in code. The post-exec pull in
`packages/workspace/src/shell.ts` calls `sync.pull()` only; it does
not consult any mount-mirror layer because there isn't one. The
"container-side wins" semantic the doc describes is therefore
trivially true today (there is no other side).

### Per-mount options (`mode`, `ignore`, `maxBytes`, etc.) — missing (❌)

The sync layer has an `ignore` mechanism
(`packages/workspace-fs/src/sync/ignore.ts`, exercised by
`sync/fetch.ts` and `sync/apply.ts`), but it is a flat list passed
to `fetchChanges({ ignore })`. There is no "mount-level ignore
composed by union" because there are no mounts. `maxBytes`,
`maxEntries`, and `mode: "read-only" | "read-write"` likewise do
not exist.

### Mount-root nesting rejection — missing (❌)

The doc says "Mount roots must not nest — `/workspace/a` and
`/workspace/a/b` together is rejected at construction." There is no
construction-time validation because there is no mount registry to
validate.

## Drift summary

The entire `docs/06_mount_interface.md` describes a subsystem that
**does not exist in code**. The only concrete artefacts the
implementation contributes are forward-looking schema seats —
`_vfs_mounts` (in `schema/sync.ts`) and the `mount_root` /
`stub_size` columns on `vfs_nodes` (in `schema/core.ts`) — neither
of which is read or written anywhere in the runtime. So:

- ✅ Schema slots for mounts exist and shape matches the doc's
  intent (a `kind`-tagged row keyed by root, plus per-inode mount
  attribution and stub size).
- ❌ Every API surface in the doc (`WorkspaceOptions.mounts`,
  `Mount` / `LazyMount` / `EagerMount` interfaces, `MountFactory` /
  `MountContext`, `MountWriteApi`, `R2Bucket`, `GitHubRepo`,
  `prefetch`, `flushMounts`, `refreshMount`, `onMountConflict`,
  per-mount `mode` / `ignore` / `writeBack` / `writeBackMs` /
  `maxBytes` / `maxEntries`, stub fetch + dedupe, debounced
  write-back, mount-root nesting check) is absent.

This is not a small drift on the edges. It is a whole-feature gap.
The doc's banner is honest: the design is intentional and the
schema confirms the author intended to build it, but the build
hasn't happened.

## Recommendations

Default tag for this doc is **`code-fix`**, not `doc-fix`, with a
caveat. Justifications:

1. The schema already commits to the mount design at the storage
   layer. Removing `_vfs_mounts`, `mount_root`, and `stub_size`
   would be a regression against an intentional forward placement.
2. The mount feature is genuinely useful and well-thought-out (R2
   prefilling, GitHub clone-on-boot, lazy fetch with stubs,
   debounced write-back). It is the kind of capability that is much
   easier to design once and implement against than to retrofit
   later — and the schema author clearly knew that.
3. There is no competing implementation in the code that the doc is
   misrepresenting. The risk of a `code-fix` tag here is the
   ordinary risk of unbuilt features, not the risk of confusing
   readers about what runs.

Caveat: pure `code-fix` means "build the thing as specified".
That is a substantial chunk of work and a few corners of the doc
deserve a second pass before code commits to them. Specifically:

- **Factory ergonomics.** The doc keeps both bare `Mount` objects
  and `MountFactory` callbacks ("Bare `Mount` objects are also
  accepted for back-compat.") This is back-compat against nothing;
  the simpler option is to ship factories only. **`doc-fix`** on
  the back-compat line.
- **`writeBack: "manual"` + `flushMounts()` interaction with the
  conflict hook.** The doc says manual writes "accumulate in the
  VFS and only land on the provider when `flushMounts()` is
  called", but does not say whether `flushMounts()` invokes
  `onMountConflict` retroactively per path or whether manual mode
  inhibits the hook entirely. Worth pinning down before
  implementing. **`needs-decision`**.
- **Mount-inside-mount and lifecycle (`refresh()` /
  `refreshMount`).** The doc itself marks these as open questions
  (lines 247-266). Leave the open-questions section in place;
  resolving them is part of the build, not the docs. **`needs-decision`**.
- **`ignore` rename.** The doc references "the workspace-level
  `ignore` option (the renamed `pullIgnore`)". There is no
  `pullIgnore` in `WorkspaceOptions` either. When mounts are
  built, decide on the workspace-level `ignore` name in lockstep.
  **`needs-decision`** (small).

Concrete next actions if and when this lands:

- Add `mounts?: Record<string, Mount | MountFactory>` and
  `onMountConflict?` to `WorkspaceOptions`.
- Define `Mount`, `LazyMount`, `EagerMount`, `MountFactory`,
  `MountContext`, `MountWriteApi`, `MountEntry` in
  `packages/workspace/src/mounts/` (new directory).
- Drive indexing during `Workspace.ready()`; persist to
  `_vfs_mounts`.
- Teach `WorkspaceFilesystem` to recognise stubs (rows where
  `mount_root IS NOT NULL` and `stub_size IS NOT NULL`) and call
  back into a provider registry, with per-path in-flight dedupe.
- Wire the debounced write-back through the existing post-exec
  pull bracket in `shell.ts`.

## Drifts where doc target still looks valuable

Essentially all of them. The interesting filter is the inverse:
which doc claims are *not* worth keeping?

- Bare-`Mount`-object back-compat (line 101). No code to be
  back-compat with; drop in favour of factories only.
- The duplicated `put?` / `delete?` shape repeated on both
  `LazyMount` and `EagerMount` (lines 51-52, 70-71). Could be
  factored into a `WritableMount` mixin; small cosmetic call.

Everything else — the lazy/eager split, R2 + GitHub providers,
prefetch, debounced write-back, conflict hook, per-mount ignore,
the `_vfs_mounts` table the schema already reserves — is worth
building substantially as specified. The doc is one of the higher-
value targets in the audit set precisely because the schema author
already paid the design cost.
