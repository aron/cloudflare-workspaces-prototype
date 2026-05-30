# 02. Sync Protocol

> [!IMPORTANT]
> This document describes the **intended design** of the sync protocol
> and has **diverged from the current implementation** in the
> repository. Naming, signatures, and behaviours described here are
> targets, not what `main` ships today. When in doubt, treat the code
> as authoritative for what runs and this doc as authoritative for
> what we're moving toward.

The workspace keeps two copies of the filesystem tree in sync:

- **DO side** — a SQLite-backed VFS in the Durable Object (the source of
  truth across restarts). See [03. Filesystem Schema](./03_filesystem_schema.md).
- **Container side** — an in-memory VFS exposed to the sandbox via a
  FUSE mount at the configured workspace root.[^memory]

[^memory]:
    > [!NOTE]
    > The container-side store is in-memory for the initial versions of
    > the package. A future release will move to filesystem-backed
    > storage so larger workspaces stop being bounded by container RAM.

Sync is incremental and bidirectional. Each side carries a monotonic
counter so neither has to send the whole tree to catch up.

## Lifecycle

Data flows in two directions, on its own clock:

- **DO → container (push).** Every DO-side mutation is stamped with a
  fresh revision. When the container needs them — before an `exec()`,
  or on an explicit `workspace.push()` — the DO sends every revision
  the container hasn't seen yet.
- **Container → DO (pull).** Every container-side write through FUSE is
  stamped with a fresh container revision. The DO collects those
  revisions — after an `exec()` returns, or on an explicit
  `workspace.pull()` — and applies them to its SQLite store.

A typical `exec()` round-trip:

1. **Push.** The DO streams every `ChangeEntry` with a higher
   revision than the container has seen, **coalesced to one entry
   per path** (the latest state wins — five rewrites of the same
   path between execs cost one entry on the wire, not five). Bytes
   are not inline; entries carry chunk hashes only. The container
   calls `hasObjects` on the referenced hashes, the DO follows up
   with `pushObjects` for the missing subset. The container
   suppresses its own dirty-tracking while applying so deletes don't
   bounce back.
2. **Hydrate.** Lazy-mount stubs the command might touch are fetched
   from their providers and included in the same push batch. See
   [06. Mount Interface](./06_mount_interface.md).
3. **Exec.** The command runs. FUSE writes are captured by the
   in-container VFS as they happen, each stamped with a fresh revision.
4. **Fetch.** The DO calls `fetchChanges(sinceRev = fetchRev)`. The
   container streams `ChangeEntry` records — one per touched path,
   per-file entries carrying `chunks: (hash, size)[]`. No bytes
   inline. The DO consumes entries as they arrive so peak memory
   stays bounded regardless of how much the exec touched.
5. **Diff.** The DO unions all chunk hashes from the entry stream,
   probes its own `cf_vfs_blobs` for which it already has, and calls
   `fetchObjects` for the missing subset.
6. **Apply.** Entries + new objects land in the DO's SQLite **in
   bounded transactions** (default cap: 64 MiB of new bytes or 1024
   paths, whichever first). `fetchRev` advances per committed batch
   so a crash mid-fetch resumes cleanly via `sinceRev = fetchRev` on
   the next call. After the final batch the DO advances `fetchRev`
   to the container's reported max revision.

`writeFile` / `mkdir` / `rm` outside of `exec()` follow the same shape:
step 1 is "this single change", steps 3–6 are skipped. `workspace.push()`
runs step 1 on demand; `workspace.pull()` runs steps 4–6.

### Chunking

Files are split at a fixed `CHUNK_SIZE` (512 KiB). Chunk boundaries are
deterministic — `chunkIdx = floor(byteOffset / CHUNK_SIZE)` — so an edit
that only touches one region of a large file pulls back only the
affected chunks instead of the whole file. Each chunk is content-
addressed by `sha256(bytes)`, so:

- Duplicate content (the same library vendored at two paths, an edit
  that only rewrites the last chunk) is transferred and stored once.
- The "what bytes do you actually need?" probe is just a set
  difference of 32-byte hashes — no metadata round-trips.

## Watermarks

Both sides carry monotonic revision counters and exchange them on every
push and pull. The wire vocabulary is `rev` throughout — one concept,
one name.

| Watermark | Owner | Meaning |
| --- | --- | --- |
| `pushRev` | DO | Last DO-side `rev` successfully pushed to the container. |
| `fetchRev` | DO | Last container-side `rev` the DO has fetched. |
| `currentRev` | DO | Latest `rev` stamped on a DO-side mutation. |
| `currentRev` | Container | Latest `rev` stamped on a container-side mutation. |
| `appliedPushRev` | Container | Largest DO `rev` the container has fully applied. Echoed on every push response and pull stream. |

The DO watermarks live in the `_cf_vfs_watermark` table so they survive DO
restarts. The container's revisions are in-memory only; if the container
restarts, the next push from the DO is treated as an authoritative
baseline.

### Cross-side invariant

Every `fetchChanges` and `push` response carries the container's
current `appliedPushRev`. The DO asserts `appliedPushRev >= pushRev` on
every response. The two sides never share a single clock, but echoing
the largest applied DO rev makes the "container is caught up with the
DO's pushes" invariant inspectable on the wire instead of load-bearing
in-process state. A regression in the suppress-dirty-tracking apply path
trips the assertion immediately rather than corrupting data silently.

## Wire shape

The wire is symmetric: push and fetch both move `ChangeEntry`
records, both probe with `hasObjects`, both transfer bytes by hash.
Naming follows git's vocabulary — the DO *pushes* entries and
objects to the container, and *fetches* entries and objects back.

| RPC | Direction | Returns | Notes |
| --- | --- | --- | --- |
| `push` | DO → container | `{ rev, appliedPushRev }` | Streams a coalesced batch of `ChangeEntry`. Container calls `hasObjects` on referenced hashes; DO follows up with `pushObjects` for the missing subset. |
| `fetchChanges(sinceRev?, ignore?)` | container → DO | `ReadableStream<ChangeEntry>` | Streams one entry per touched path. For files, `chunks: (hash, size)[]` (no bytes inline); for dirs, metadata; for deletes, a tombstone. Each entry carries the container's `appliedPushRev`. |
| `hasObjects(hashes[])` | either side probes the other | `Uint8Array[]` | Returns the subset of the input the receiver already holds. The git `have` line, batched. |
| `fetchObjects(hashes[])` | container → DO | `ReadableStream<{ hash, bytes }>` | Streams chunk bytes by hash. The git `want`/pack response on the fetch path. |
| `pushObjects(objects)` | DO → container | `void` | Streams chunk bytes by hash. The push-direction mirror of `fetchObjects`. |

Identical content at multiple paths (or unchanged chunks within an
edited file) shows up exactly once on the wire. See
[08. Capnweb Interface](./08_capnweb_interface.md) for the framing.

## Failure handling

- **Container restart mid-exec.** The DO's connection detects the
  closed WebSocket and self-destructs. The next call transparently
  rebuilds against the still-running workspace-server (or restarts it
  if needed). `pushRev` and `fetchRev` mean the catch-up is incremental.
- **Container crash mid-apply.** `push` is atomic from the DO's
  perspective. The container is permitted to lose all state on crash;
  the next push treats the container as empty (`appliedPushRev = 0`).
  Partial application must not survive a crash. Today the in-memory
  VFS satisfies this trivially — the process dies and restarts empty.
  A future on-disk container mirror will need a staging-dir-then-rename
  or WAL to preserve the same invariant.
- **DO restart mid-pull.** `fetchRev` advances per committed apply batch,
  so the new DO instance resumes from the last durably-committed batch
  via `fetchChanges(sinceRev = fetchRev)`.
- **DO restart.** Watermarks are persisted, so the new DO instance
  picks up where the old one left off. The container keeps the
  workspace-server process alive across the gap.
- **Concurrent mutators.** The DO serializes mutating entry points
  (`exec`, `writeFile`, `mkdir`, `rm`, `push`, `pull`) through a per-
  Workspace FIFO queue. Pure reads stay outside the queue.

## Ignore lists

The `ignore` option hides path segments from the pull. Excluded
paths are still written and read inside the container — the bytes just
never cross the wire back to the DO. This is essential for any large
directory of derived files: `node_modules`, `.next`, `target`,
`__pycache__`, `dist`. Without an ignore, a single `npm install` would
push tens of thousands of small files through the sync wire on the
next pull.

The default is `["node_modules"]`. Pass `[]` to disable, or your own
list to extend.

### Ignored entries

Ignored paths are **invisible to the `Workspace.fs` API**. They do not
appear in `readdir`, `stat` returns `ENOENT`, and `readFile` returns
`ENOENT`. The bytes still live inside the container, so anything that
*uses* the ignored files — `exec("node ...")`, build tools, anything
running container-side — keeps working. The exclusion only affects what
crosses the wire **and** what the DO-side API surfaces.

This is a deliberately narrow surface for the initial release. Whether
ignored entries should be representable to the DO at all (as stubs, as
a separate shell-only namespace, or not at all) is left to a future
iteration — see [Future considerations](#future-considerations).

## Future considerations

Items deferred from the initial design. File an issue if a real use
case depends on a particular resolution.

### Representing ignored entries to the DO

Today ignored paths are entirely invisible to `Workspace.fs`. That is
the simplest contract but it loses one piece of information: tools that
want to enumerate "everything the agent's exec can see" can't get it
from the DO. Two options worth weighing later:

- **Stub entries with an `ignored` flag** on `stat()`, surfaced via
  `readdir`. Easy to retrofit; surprising for tools that walk the tree
  and don't check the flag.
- **An explicit shell-only namespace** — e.g. `workspace.shell.readdir`
  returns container-only entries, `workspace.fs.readdir` stays clean.
  Cleaner separation, larger API surface.

Either way, the bytes never cross the wire; the question is purely how
much the DO admits exists.

### Bloom/cuckoo filter over `cf_vfs_blobs.hash`

Every pull does a `hasObjects` probe round-trip. With tens of thousands
of chunks per pull the bytes are small but the latency is real. A DO-
side probabilistic filter rebuilt lazily from `cf_vfs_blobs` would let the
DO skip the probe for chunks it can prove it doesn't have, falling
back to `hasObjects` only for likely-present hits. No protocol change
needed; pure DO-side optimisation.

### Push backpressure

A long-running exec can dirty container state faster than the DO can
pull. Today the in-memory container VFS caps this by OOMing, which is
a bad answer. Once a disk-backed container mirror lands the bound
shifts to path count, but the same problem persists. Likely shape: a
soft cap on the dirty set (say, 256 MiB pending bytes or 100k paths)
above which FUSE write replies are delayed (real backpressure into the
writer), or the container opportunistically initiates a push to the DO
out-of-band rather than waiting for the post-exec pull.

### Prior art and selective reuse

The chunk store + per-file manifest + haves/wants negotiation pattern
is not novel — git, casync, OSTree, restic and IPFS unixfs all solve
variants of the same problem. Reusing one of them outright would
trade implementation we control for a library mismatch we don't.
Reusing the *formats* and *patterns* without the libraries is the
better trade for our scale.

**Git pack protocol.** Maps directly onto our model: trees =
directories, blobs = files, content addressing by sha. The smart
protocol's haves/wants negotiation is exactly what `hasObjects` /
`fetchObjects` do today, and isomorphic-git is already in the dependency
tree for `GitHubRepo`. Where it stops fitting: git's chunking is
per-blob (whole file), so sub-file dedup costs a repack-driven delta
search rather than falling out of the addressing. Its mental model is
history — every push would be a synthetic commit and GC would need
repack cycles. Its metadata model is poor (executable bit only). The
binary pack format loses capnweb-text's debuggability. Verdict: *borrow
the haves/wants pattern and the naming, not the library or the wire
format.*

**casync.** The closest fit: built by Lennart Poettering for exactly
this problem. The `.caidx` chunk-index format is an ordered list of
`(sha256, offset, size)` per file — our `cf_vfs_manifests.encoded` is
a homebrew of the same shape. The `.castr` chunk store is our
`cf_vfs_blobs`. Buzhash content-defined chunking solves the
head-insertion problem in this appendix. Full POSIX metadata
(symlinks, hardlinks, xattrs, mode, mtime) is built in. The blocker
is implementation: casync is C, the only good port is Go (`desync`),
and a production-grade TypeScript implementation does not exist. A
WASM build is possible but the carrying cost is larger than our
current sync implementation.

**OSTree, restic, borg, IPFS unixfs.** All have the right data shape
but the wrong centre of gravity — OS images, backup snapshots, or a
full P2P network stack. None has a clean TypeScript runtime story for
a DO. Worth knowing about; not worth pulling in.

**Where to spend the reuse budget**

Three concrete borrows give us most of the upside with no runtime
dependency:

1. **Adopt casync's `.caidx` format as our manifest encoding.** Our
   current encoding is already structurally identical; switching to
   the published spec costs nothing and we gain free debuggability
   (`casync mtree`, `desync index` on the file from any container)
   and trivial export of a workspace as `.caidx` + `.castr` for
   backup or migration. Spec borrow, not code borrow.
2. **The `hasObjects` / `fetchObjects` RPCs already align with git's
   haves/wants
   vocabulary** — anyone who has read `git fetch` source recognises
   the pattern instantly. The semantics are already the same; this
   is purely a naming alignment.
3. **When content-defined chunking lands (see above), vendor a
   FastCDC / buzhash implementation rather than rolling our own.**
   The algorithms are subtle (boundary stability, min/max bounds,
   rolling-hash window selection) and good MIT-licensed TS ports
   exist. This is the one place where reinventing the wheel hurts.

**Where to *not* spend it**

- Don't take `isomorphic-git` as the sync engine. The history model
  fights the live-tree model on every push.
- Don't take `libcasync` (or a WASM build) as a runtime dep. The
  protocol surface we maintain is ~6 RPCs and a few hundred lines of
  logic; replacing it with a library mismatch is a net loss at our
  scale.
- Don't adopt IPFS CIDs / multihash. The indirection buys nothing
  inside a single DO + container pair.
