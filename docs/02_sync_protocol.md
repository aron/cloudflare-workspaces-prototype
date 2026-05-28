# 02. Sync Protocol

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

1. **Push.** The DO sends every change with a higher revision than the
   container has seen. The container suppresses its own dirty-tracking
   while applying so deletes don't bounce back.
2. **Hydrate.** Lazy-mount stubs the command might touch are fetched
   from their providers and included in the same push batch. See
   [06. Mount Interface](./06_mount_interface.md).
3. **Exec.** The command runs. FUSE writes are captured by the
   in-container VFS as they happen, each stamped with a fresh revision.
4. **Pull.** The DO asks the container for every change since its
   pull watermark. The container returns a *manifest*: one record per
   touched path with a `chunks: (hash, size)[]` array. No bytes inline.
5. **Diff.** The DO unions all chunk hashes from the manifest, probes
   which it already has, and fetches only the missing bytes.
6. **Apply.** Manifests + new blobs land in the DO's SQLite. The DO
   advances its pull watermark to the container's reported max revision.

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
| `pullRev` | DO | Last container-side `rev` the DO has consumed. |
| `currentRev` | DO | Latest `rev` stamped on a DO-side mutation. |
| `currentRev` | Container | Latest `rev` stamped on a container-side mutation. |

The DO watermarks live in the `_cf_watermark` table so they survive DO
restarts. The container's revision is in-memory only; if the container
restarts, the next push from the DO is treated as an authoritative
baseline.

## Wire shape

The container exposes a single pull RPC, `pullDirty`, that returns a
manifest:

| RPC | Returns | Notes |
| --- | --- | --- |
| `applyChanges` | `{ rev }` | DO → container. Applies a batch of changes. |
| `pullDirty(sinceRev?, ignore?)` | `ManifestBulk` | Container → DO. One record per touched path with `chunks: (hash, size)[]`. No bytes inline. |
| `hasBlobs(hashes[])` | `Uint8Array[]` | Probes which chunk hashes the container has stored. |
| `getBlobs(hashes[])` | `Uint8Array[]` | Streams chunk bytes back in request order. |

Identical content at multiple paths (or unchanged chunks within an
edited file) shows up exactly once on the wire. See
[08. Capnweb Interface](./08_capnweb_interface.md) for the framing.

## Failure handling

- **Container restart mid-exec.** The DO's connection detects the
  closed WebSocket and self-destructs. The next call transparently
  rebuilds against the still-running workspace-server (or restarts it
  if needed). `pushRev` and `pullRev` mean the catch-up is incremental.
- **DO restart.** Watermarks are persisted, so the new DO instance
  picks up where the old one left off. The container keeps the
  workspace-server process alive across the gap.
- **Concurrent mutators.** The DO serializes mutating entry points
  (`exec`, `writeFile`, `mkdir`, `rm`, `push`, `pull`) through a per-
  Workspace FIFO queue. Pure reads stay outside the queue.

## Ignore lists

The `pullIgnore` option hides path segments from the pull. Excluded
paths are still written and read inside the container — the bytes just
never cross the wire back to the DO. This is essential for any large
directory of derived files: `node_modules`, `.next`, `target`,
`__pycache__`, `dist`. Without an ignore, a single `npm install` would
push tens of thousands of small files through the sync wire on the
next pull.

The default is `["node_modules"]`. Pass `[]` to disable, or your own
list to extend.

### Ignored entries in the DO

Ignored paths are not invisible to the DO — they appear in `readdir`
and `stat` as stub entries with no content, so tools that walk the tree
still see something at those paths. Their size and mtime reflect what
the container reported.

Reading the bytes of an ignored stub throws `EIGNORED` (a workspace-
specific error code). Stubs also carry an `ignored: true` flag on
their `stat()` result, so callers can detect and skip them up-front
without relying on the error path:

```ts
const s = await fs.stat("/workspace/node_modules/react/index.js");
if (s.ignored) {
  // Exists in the container, not pulled back to the DO.
  // Use exec to read it container-side, or skip.
  return;
}
const text = await fs.readFile("/workspace/node_modules/react/index.js", "utf8");
```

The bytes are still live inside the container, so anything that *uses*
the ignored files (`exec("node ...")`, build tools, etc.) keeps working
— the exclusion only affects what crosses the wire.
