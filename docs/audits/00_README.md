# Audit: docs/README.md

## Scope

`docs/README.md` is the entrypoint for the `@cloudflare/workspace` design
docs. It pitches the package, lists its capabilities/limitations,
sketches installation, shows an `Agent` example that constructs a
`Workspace` with `storage`/`sandbox`/`sessionId`/`mounts`, walks through
the `fs` and `shell` surfaces with examples, prescribes a multi-stage
Dockerfile that copies `ws.js` out of a `cloudflare/workspace` image,
and gives a high-level `Workspace` interface (`fs`, `shell`, `push`,
`pull`, `warmup`, `prefetch`, `gc`). The doc itself warns that it has
diverged from `main`.

## Methodology

Inspected (read-only) against tip of tree:

- `packages/workspace/package.json`, `src/index.ts`, `src/workspace.ts`,
  `src/shell.ts`, `src/backend.ts`, `src/backends/`.
- `packages/workspace-fs/package.json`, `src/index.ts`,
  `src/fs/filesystem.ts`.
- `packages/workspace-rpc/package.json`, `src/index.ts`.
- `packages/wsd/package.json`, `src/cli/wsd.ts`.

Mapped every normative claim in the README to its corresponding symbol
(or absence of one) and recorded the result below.

## Findings

| # | Claim (doc line) | Status | Evidence | Notes | Tag |
| - | --- | --- | --- | --- | --- |
| 1 | Package name `@cloudflare/workspace` (L1, L35, L74) | ✅ | `packages/workspace/package.json:2` | Name matches. | – |
| 2 | "Virtual filesystem for use in any Durable Object … persistent and backed by SQLite" (L11) | ✅ | `packages/workspace-fs/src/storage.ts`, `schema/*`; `Workspace` opens a `Database` over `DurableObjectStorageLike` (`workspace.ts:55`) | High-level claim holds. | – |
| 3 | "Mounts for pre-filling data from R2 or Artifacts" (L18) | ❌ | No mount surface exported. `grep -rn mounts packages/workspace*/src` returns only the `_vfs_mounts` SQL table in `workspace-fs/src/schema/sync.ts:23`. No `R2Bucket`/`GitHubRepo` factories; no `mounts` option in `WorkspaceOptions` (`workspace.ts:25-39`). | Aspirational; not implemented. | doc-fix (drift worth keeping as target — see below) |
| 4 | "Container/Sandbox support via FUSE mount, mirroring the same filesystem in a container" (L20) | ⚠️ | FUSE mount exists in `packages/wsd/src/fuse/` and `wsd.ts:325`, but it's exposed through `wsd` (a separate package) not the `@cloudflare/workspace` runtime API. | Capability exists, packaging description is off. | doc-fix |
| 5 | "Out-of-the-box tools for `@cloudflare/agents`" (L21) | ❌ | No tool surface in any package; doc 09 also missing-implementation per plan. | Aspirational. | doc-fix |
| 6 | "First read of a lazy mount fetches over the network. Use `workspace.prefetch()` from `onStart` …" (L28) | ❌ | No `prefetch` method on `Workspace` (`workspace.ts:41-160`); no mounts implementation behind it. | – | doc-fix |
| 7 | `npm install @cloudflare/workspace` (L35) | ⚠️ | Package is `private: true` (`packages/workspace/package.json:4`); not published. | Will be true eventually; cosmetic. | doc-fix |
| 8 | "The package ships two entrypoints: `@cloudflare/workspace` and `@cloudflare/workspace/shared`" (L38-43) | ❌ | Only `.` is in `exports` (`packages/workspace/package.json:7-12`). No `./shared` subpath. Wire/shared types instead live in `@cloudflare/workspace-rpc` (separate package with `./server`, `./client`, `./driver` subpaths). | Drift. | doc-fix |
| 9 | Dockerfile uses `FROM cloudflare/workspace:latest` and `COPY --from=workspace /app/ws.js ./ws.js` (L49-66) | ❌ | The container daemon is `wsd` (binary `wsd`, package `@cloudflare/workspace-wsd`, see `packages/wsd/package.json:2,9`). No published `cloudflare/workspace` image or `ws.js` artifact in the tree — `packages/wsd/scripts/build-bin.mjs` produces `dist/cli/wsd.cjs`. | – | doc-fix |
| 10 | `EXPOSE 4567` (L65) | ❌ | `DEFAULT_PORT = 45678` in `packages/wsd/src/cli/wsd.ts:23`. | One-digit drift; presumably the spec wanted 4567 but code chose 45678. | doc-fix |
| 11 | "The `Workspace` class boots `ws.js` for you on the first `exec()` or `warmup()` call" (L68) | ❌ | `Workspace` does not boot anything. Connection is via injected `WorkspaceBackend[]` whose `connect()` is called from `ready()` (`workspace.ts:87-91, 139-159`). The doc 07 boot sequence isn't wired here. | – | doc-fix |
| 12 | `new Workspace({ storage, sandbox, sessionId, mounts })` (L81-90) | ❌ | Actual shape: `WorkspaceOptions = { storage, backends: WorkspaceBackend[], now? }` (`workspace.ts:25-39`). `sandbox`/`sessionId`/`mounts` do not exist; the sandbox binding + session id are passed via `CloudflareContainerBackend` options instead (`backends/cloudflare-container.ts`). | Major API drift. | doc-fix |
| 13 | `R2Bucket(env.SHARED_FILES, { prefix })` / `GitHubRepo("cloudflare/agents", { env })` mount factories (L86-88) | ❌ | No such exports in `packages/workspace/src/index.ts` (lines 1-35). | – | doc-fix (target worth keeping — see below) |
| 14 | `this.workspace.fs.mkdir("/workspace")` inside constructor (L91) | ⚠️ | `WorkspaceFilesystem.mkdir` exists (`workspace-fs/src/fs/filesystem.ts:90-92`) but it's now `async` and returns `Promise<void>`; calling without `await` in a constructor will swallow rejections. Also the example uses it sync-style. | – | doc-fix |
| 15 | `this.workspace.warmup()` (L96) | ❌ | No `warmup` method on `Workspace` (`workspace.ts:41-160`). Closest is `ready()`. | – | doc-fix |
| 16 | "everything is async, paths are absolute, and operations are durable across DO restarts" (L101) | ✅ | All `WorkspaceFilesystem` methods are async (`filesystem.ts:44-95`); `Database` is backed by DO storage. | – | – |
| 17 | `fs.writeFile(path, string \| Uint8Array \| ReadableStream)` (L107-113) | ✅ | `writeFile` overloads accept `WriteFileContent` (`workspace-fs/src/fs/writeFile.ts` via `filesystem.ts:25, 82-88`). | Stream support real. | – |
| 18 | `fs.readFile(path, "utf8")` returns string, `fs.readFile(path)` returns `ReadableStream` (L120-124) | ✅ | Overloads at `filesystem.ts:44-58`. | – | – |
| 19 | `fs.mkdir(path, { recursive })` (L130) | ✅ | `MkdirOptions` accepted (`filesystem.ts:90-92`). | – | – |
| 20 | `fs.readdir(path)` yields `{ name, isDirectory }` (L132-134) | ⚠️ | Returns `WorkspaceDirentResult[]` (`filesystem.ts:64-66`); the exact field set should be verified against `fs/readdir.ts`. README's `entry.isDirectory` shape may differ from actual `WorkspaceDirentResult` (often `type` or `kind`). | Re-check before publishing the example. | doc-fix |
| 21 | `fs.rm(path, { recursive })` (L140-141) | ✅ | `RmOptions` accepted (`filesystem.ts:94-96`). | – | – |
| 22 | `fs.grep(pattern, path, { ignoreCase })` returns `{ path, line, text }` hits (L147-150) | ⚠️ | `grep(pattern, path, GrepOptions)` exists (`filesystem.ts:76-78`); confirm field names match `WorkspaceGrepMatch` in `fs/grep.ts` before fixing the example. | Field-shape verify. | doc-fix |
| 23 | `workspace.shell.exec("ls -la …", { encoding: "utf8" })` returns handle; `await run.result()` yields `{ stdout, exit }` (L156-158) | ⚠️ | `exec(...)` returns `Promise<ExecHandle<E>>` (`shell.ts:120-141`). `ExecResult` shape is `{ exitCode, stdout, stderr, pushed, pulled }` (`shell.ts:43-54`) — field is `exitCode`, not `exit`. | API correct, field name wrong in example. | doc-fix |
| 24 | "`exec` returns a `ReadableStream` of events as well as the buffered `result()`" (L161) | ✅ | `ExecHandle extends ReadableStream<WorkspaceExecEvent>` (`shell.ts:73-77`). | – | – |
| 25 | SSE event shape `{ id, name: "stdout"\|"stderr", value: string } \| { id, name: "exit", value: number }` (L170-171) | ⚠️ | Actual event also has `seq` (`shell.ts:41-43`). Otherwise the discriminator matches. | Minor. | doc-fix |
| 26 | High-level `Workspace` interface table (L221-235): `fs`, `shell`, `push(): Promise<void>`, `pull(): Promise<void>`, `warmup()`, `prefetch()`, `gc()` | ❌ partial | `fs`, `shell`, `push`, `pull` exist (`workspace.ts:70-125`). `push`/`pull` return `Promise<number>`, not `Promise<void>`. `warmup`, `prefetch`, `gc` do not exist. | Multiple drifts. | doc-fix |
| 27 | Docs index table (L207-216) names docs 01–10 | ✅ | All 10 files present in `docs/`. | – | – |

## Drift summary

Material drifts (everything not ✅):

- **Constructor surface** (finding 12): `WorkspaceOptions` is `{ storage,
  backends, now? }`. Doc shows `{ storage, sandbox, sessionId, mounts }`.
- **Mounts feature** (3, 6, 13): no `mounts` option, no
  `R2Bucket`/`GitHubRepo` factories, no `prefetch`, no lazy
  mount machinery.
- **Boot story** (4, 11, 9, 10): Container side is `wsd` (package
  `@cloudflare/workspace-wsd`, binary `wsd`, default port `45678`), not
  `ws.js` boot-on-exec. The `cloudflare/workspace` Docker image and
  `EXPOSE 4567` are not real.
- **Connection lifecycle** (15, 11): no `warmup()`. The actual API is
  `ready()` (idempotent, lazy-connect over `backends[]`).
- **High-level interface table** (26): `push`/`pull` return numbers, not
  void; `warmup`, `prefetch`, `gc` don't exist.
- **Entrypoints** (8): no `@cloudflare/workspace/shared` subpath; shared
  wire types live in `@cloudflare/workspace-rpc` (with `./server`,
  `./client`, `./driver`).
- **Tools for `@cloudflare/agents`** (5): not implemented.
- **Example smaller bugs** (14, 23, 25, 20, 22): unawaited `mkdir` in
  constructor; `result().exit` should be `exitCode`; event shape missing
  `seq`; dirent / grep match field shapes need verification.
- **Publication state** (7): package is private; install command
  doesn't work today.

## Recommendations

Default tag is `doc-fix`. The README is the doorway document, so once
the design lands in code, sync the doorway last.

- doc-fix: rewrite the `new Workspace({...})` example to use
  `{ storage, backends: [new CloudflareContainerBackend({...})] }`, and
  add a note that `await workspace.ready()` (not `warmup()`) is what
  primes the connection.
- doc-fix: replace the Dockerfile recipe with one that runs `wsd` (or
  drop it until there's a published image). Update port to `45678` or
  decide we want `4567` and `code-fix` the constant — see drifts below.
- doc-fix: shrink the high-level interface table to today's surface
  (`fs`, `shell`, `push: Promise<number>`, `pull: Promise<number>`,
  `ready`, `stub`, `close`), and either drop or clearly mark
  `warmup`/`prefetch`/`gc`/`mounts` as "target, not implemented".
- doc-fix: drop the `@cloudflare/workspace/shared` entrypoint claim or
  point readers at `@cloudflare/workspace-rpc` for the wire types.
- doc-fix: small example fixes — `exitCode` not `exit`; verify dirent
  and grep field names; await the constructor `mkdir`; add `seq` to the
  SSE event union (or omit it deliberately and explain why).
- needs-decision: is the `@cloudflare/workspace/shared` subpath
  something we still want, or has `workspace-rpc` taken its role
  permanently?

## Drifts where the doc target still looks valuable

These are the drifts where I'd recommend keeping the doc target on the
roadmap rather than purely demoting it to "doc-fix":

- **`mounts` option with `R2Bucket(...)` / `GitHubRepo(...)` factories**
  (findings 3, 13). The DX in the example is genuinely good — it makes
  pre-filling a workspace from R2/GitHub a one-liner at construction
  time and matches the way Workers bindings already feel. The schema
  side already has `_vfs_mounts` reserved
  (`workspace-fs/src/schema/sync.ts:23`), so part of the foundation is
  in place. Worth treating as a real feature target. Tag: `doc-fix` for
  the README, but track as a feature item.
- **`prefetch(root?)`** (finding 6). Hydrating lazy mounts from
  `onStart` is a useful, well-scoped API once mounts land. Keep on the
  roadmap.
- **`warmup()`** (finding 15). The `ready()` we have today already does
  most of this; renaming/aliasing it `warmup()` (or adding `warmup()`
  as a no-arg "start the container connection eagerly" sugar) reads
  better in an `onStart` block than `ready()`. Could be a small
  `code-fix` later if we like the name.
- **`gc(safetyWindowMs?)`** (finding 26). Blob/manifest GC is a real
  operational need given the SQLite storage model; the sync module
  already has the building blocks (`buildManifest`, watermarks, etc.).
  Worth tracking even though no method exists today.
- **`@cloudflare/workspace/shared` entrypoint** (finding 8). A
  curated re-export of wire types from the main package would save
  consumers from learning about `@cloudflare/workspace-rpc` as a
  separate dependency. Possible `code-fix` later: add a `./shared`
  subpath that re-exports the relevant types.

Everything else is straightforwardly "doc has drifted ahead of code;
update the doc to match what shipped."
