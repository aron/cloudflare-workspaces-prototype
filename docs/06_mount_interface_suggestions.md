# 06. Mount Interface — Suggestions

> **Status (post-review).** Items marked ~~struck~~ have been folded
> into `06_mount_interface.md`. Items tagged “deferred” landed in the
> doc's “Open questions” section. Remaining items stay as live
> proposals.

Proposals against `06_mount_interface.md`.

## ~~1. Resolve the write-back gating open question~~ — integrated (debounce default)

**Problem.** The doc already calls this out: read-write mounts
mirror every write, which is too eager for build outputs or editors
that save on every keystroke.

**Status from review.** No back-compat required. Debounce is now
the default; manual flush is the explicit opt-out. `withMountWrites`
transactional batching was dropped in favour of the simpler pair.

~~**Proposal.** Adopt a small, layered API rather than picking one
strategy:~~

Shipped shape (see `06_mount_interface.md` “Write-back gating” and
“Per-mount options”):

```ts
interface MountOptions {
  mode?:        "read-only" | "read-write";
  writeBack?:   "debounce" | "manual";   // default: "debounce"
  writeBackMs?: number;                  // default: 500
}

workspace.flushMounts(root?: string): Promise<void>;
```

Debounce window collapses burst writes (build manifests, editor saves)
to one `put` per path. `manual` disables it entirely — writes
accumulate in the VFS and only land on the provider on
`flushMounts()`.

## ~~2. Single-file mounts~~ — dropped; real problem reframed

**Status from review.** A `MountFile` factory by itself is the easy
half of the problem and isn't worth shipping on its own. The harder
and more relevant question is what happens when a file (or any mount
root) lands *inside* a path another mount also claims. Construction-
time nesting is rejected today, but a writable mount whose `put`
lands at a path another mount also wants to own has no defined
resolution.

Promoted to an open question in `06_mount_interface.md` (“Single-file
mounts → file-inside-a-mounted-directory”). Likely resolution:
longest-prefix mount wins, but the contract needs to be written down
before this ships.

## ~~3. Mount lifecycle hooks~~ — deferred

**Problem.** Mounts have `materialize` (eager) or `list`/`fetch`
(lazy) but no notion of "the workspace is shutting down" or "the
provider was reconfigured." A GitHub mount that wants to pull
`main` periodically has no hook.

**Proposal.**

```ts
interface Mount {
  onMount?(ctx: MountContext): Promise<void>;       // after index
  onUnmount?(): Promise<void>;                      // before close
  refresh?(): Promise<void>;                        // user-driven re-index
}

workspace.refreshMount(root: string): Promise<void>;
```

`refresh()` on a `GitHubRepo` does a `git fetch` and re-materializes
new objects; on an `R2Bucket` it re-runs `list()`. The default is a
no-op so existing mounts keep working.

Promoted to “Open questions → Mount lifecycle” in
`06_mount_interface.md`. Optional `refresh()` plus
`workspace.refreshMount(root)`; default is a no-op so existing mounts
keep working. Not in the initial release.

## ~~4. Mount-level ignore patterns~~ — integrated (top level also renamed)

~~**Problem.** `pullIgnore` is global.~~

**Status from review.** Adopted. The top-level option is renamed
from `pullIgnore` to `ignore` for symmetry with the mount-level
option. Mount-level `ignore: string[]` composes with the top-level
`ignore` by union.

Folded into `06_mount_interface.md` “Per-mount options” and the
updated `R2Bucket` example. The rename also propagates to
`02_sync_protocol.md` “Ignore lists” — worth a follow-up edit there
to switch the section to the new name.

## ~~5. Mount-scoped quotas~~ — integrated

**Problem.** A pathological mount (`R2Bucket` over a 1 TB bucket with
no prefix) silently consumes all blob budget on first `prefetch`.

**Proposal.** Optional `maxBytes?: number` and `maxEntries?: number`
per mount. Exceeding throws at index time before any data lands.

Folded into `06_mount_interface.md` “Per-mount options” as
`maxBytes` and `maxEntries`. Both checked at index time — exceeding
throws before any rows land in `cf_vfs_nodes`.

## ~~6. Explicit conflict policy~~ — integrated

~~**Problem.** What happens if a write-through `put()` to a read-write
mount succeeds, but the post-exec pull then reports the same path was
changed inside the container *and* in the mount?~~

Folded into `06_mount_interface.md` “Mount conflicts.” Container-side
state wins by default; `onMountConflict` hook can return `"accept"`
or `"keep-do"` to override per path. Read-only mounts report but
never mirror, so the policy is moot there.

## 7. Backpressure for mirror writes — still live

**Problem.** Post-exec mirroring runs "with bounded concurrency" but
the bound is not specified. Mirroring 10k files to R2 after a
generated-files build can saturate the binding.

**Proposal.** Document the default (e.g. 8 concurrent `put`s) and
make it configurable per mount. Surface progress through the
existing event stream so long mirrors are visible.

## 8. Built-in providers worth shipping — still live

In addition to `R2Bucket` and `GitHubRepo`:

- **`HttpTarball(url, options)`** — eager mount that fetches a
  tar.gz, materializes the entries. Handy for "preload a snapshot."
- **`Inline(entries)`** — eager mount from a literal `{ path: bytes }`
  map. Mostly useful for tests and tiny configs.
- **`Workspace(otherWorkspace, { prefix })`** — read-only window onto
  another workspace's tree. Enables share-by-reference for review
  agents.

## Suggested ordering (remaining items)

1. (7) Backpressure for mirror writes — document the default
   concurrency and expose it per mount before users hit the R2
   binding cap.
2. (8) Extra providers (`HttpTarball`, `Inline`, cross-`Workspace`)
   — opportunistic.

Items 1, 4, 5, 6 are folded into `06_mount_interface.md`. Items 2
and 3 are open questions in that doc.
