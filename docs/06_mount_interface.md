# Mount Interface

A mount populates a subtree of the workspace from an external source —
R2, a GitHub repository, an artifact bundle, or anything custom. Mounts
are configured once at construction and live for the lifetime of the
`Workspace`.

## Configuring mounts

```ts
new Workspace({
  // ...
  mounts: {
    "/workspace/.agents/skills": R2Bucket(env.SHARED_FILES, { prefix: ".agents/skills" }),
    "/workspace/project":        GitHubRepo("cloudflare/agents", { env }),
    "/workspace/scratch":        R2Bucket(env.SCRATCH, { mode: "read-write" }),
  },
});
```

Each key is an absolute *mount root* inside the VFS. Mount roots must
not nest — `/workspace/a` and `/workspace/a/b` together is rejected at
construction.

## Strategies

A mount is either **lazy** or **eager**.

### Lazy

`list()` enumerates the tree; `fetch(relPath)` returns one file's bytes.
The workspace calls `list()` once on first use to insert stubs into
`cf_nodes`, then calls `fetch()` on demand the first time something
reads a stub.

```ts
interface LazyMount {
  readonly kind: string;
  readonly strategy?: "lazy";
  readonly writable: boolean;
  list():  Promise<MountEntry[]>;
  fetch(relPath: string): Promise<Uint8Array>;
  put?(relPath: string, bytes: Uint8Array): Promise<void>;   // writable only
  delete?(relPath: string): Promise<void>;                   // writable only
}
```

Best when individual files are random-access and individually addressable
(R2, S3, HTTP).

### Eager

`materialize(api)` populates everything in one shot through a small write
API into the VFS. Called once per indexed mount per DO lifetime.

```ts
interface EagerMount {
  readonly kind: string;
  readonly strategy: "eager";
  readonly writable: boolean;
  materialize(api: MountWriteApi): Promise<void>;
  put?(relPath: string, bytes: Uint8Array): Promise<void>;
  delete?(relPath: string): Promise<void>;
}

interface MountWriteApi {
  writeFile(absPath: string, bytes: Uint8Array, mode?: number): void;
  mkdir(absPath: string, mode?: number): void;
}
```

Best when the backing store only produces content as a single transaction
(a git clone yields the whole working tree at once).

## Factories

Mount values in `WorkspaceOptions.mounts` are *factories*:

```ts
type MountFactory = (ctx: MountContext) => Mount;

interface MountContext {
  sessionId: string;        // agent's DO name
  root:      string;        // absolute mount root, no trailing slash
  vfs:       VFS;           // direct VFS handle for fs-shaped consumers
}
```

The factory is called once on first index. This lets per-session mounts
(scoped R2 prefix, per-session git fork) derive their identity from the
session without the caller threading `sessionId` through.

Bare `Mount` objects are also accepted for back-compat.

## Read-only vs read-write

Mounts default to `mode: "read-only"`. Writes anywhere under the mount
root throw `EROFS`, and writes that occur container-side during `exec()`
are dropped on the post-exec pull (after the bytes are received, before
they hit `cf_nodes`).

Pass `mode: "read-write"` to opt in to write-through:

| Operation | Order |
| --- | --- |
| `fs.writeFile` | mount `put()` first, then VFS row. Failed `put` leaves the VFS untouched. |
| `fs.rm` (file) | mount `delete()` first, then VFS row. |
| `fs.mkdir` | VFS only (R2-style stores have no directory concept). |
| `exec` writes | pulled into VFS, then mirrored to the mount with bounded concurrency. |

## Built-in providers

### `R2Bucket(binding, options?)`

Lazy mount over an R2 bucket binding.

```ts
R2Bucket(env.SHARED_FILES, {
  prefix: ".agents/skills",   // strip from R2 keys when computing relPaths
  mode:   "read-only",        // or "read-write"
});
```

- `list()` issues one R2 `list()` per index.
- `fetch(relPath)` issues one R2 `get()` per stub on first read.
- `put` and `delete` proxy to R2 when `mode: "read-write"`.

### `GitHubRepo(slug, options)`

Eager mount that clones a GitHub repository via `isomorphic-git` and
materializes the working tree into the VFS.

```ts
GitHubRepo("cloudflare/agents", {
  env,                          // for the GITHUB_TOKEN secret
  ref:    "main",               // optional, default "main"
  prefix: "/src/content/docs/", // optional; only this subtree is materialized
});
```

- `materialize()` runs the clone once.
- Currently read-only (no `put`/`delete`).

## Custom mounts

Implement `LazyMount` or `EagerMount`, optionally inside a factory:

```ts
const ArtifactBundle = (id: string): MountFactory => ({ sessionId, root, vfs }: { sessionId: string; root: string; vfs: VFS }) => ({
  kind:      "artifact",
  strategy:  "eager",
  writable:  false,
  async materialize(api) {
    const bundle = await fetchArtifact(id);
    for (const file of bundle.files) {
      api.writeFile(`${root}/${file.path}`, file.bytes, file.mode);
    }
  },
});
```

## Indexing and persistence

On first call to any `fs`, `shell`, or `prefetch` method, every mount is
indexed in parallel. Index state is persisted to `_cf_mounts` in SQLite
so DO restarts don't trigger a re-list.

`workspace.prefetch(root?)` eagerly hydrates lazy stubs under the given
mount root (or every mount if none supplied). Useful from `onStart` /
`waitUntil` to avoid a cold-start fetch fan-out on the first `grep`.

Concurrent reads of the same stub share one in-flight `fetch()` —
deduped per absolute path.

## Open questions

These behaviours aren't fully specified yet. File an issue if your use
case depends on a particular resolution.

- **Single-file mounts.** Today a mount always covers a subtree —
  `list()` returns a set of entries and the root is treated as a
  directory. Mounting an individual file (e.g. "this one R2 object
  shows up at `/workspace/config.json`") isn't expressible without
  wrapping it in a one-entry lazy mount. Options on the table:
  detect when a `MountEntry[]` has exactly one file at the root and
  collapse the directory shim, or add a dedicated `MountFile` factory
  that bypasses `list()` entirely.
- **Write-back gating.** Read-write mounts mirror every `fs.writeFile`
  / `fs.rm` straight through to the provider, and every container-side
  write under the mount root is mirrored after the post-exec pull. For
  workloads that produce many transient writes (a build that rewrites
  a manifest a dozen times, an editor that saves on every keystroke)
  this is too eager. The intended design is a gate — either
  time-based (debounce a path for N ms after the last write), explicit
  (`mount.flush()` / `workspace.flushMounts()`), or commit-style (a
  scoped `workspace.withMountWrites(async () => { ... })` that batches
  the writes and mirrors on success). Until that lands, treat
  `read-write` mounts as best for low-churn data and avoid them for
  hot build artifacts.
