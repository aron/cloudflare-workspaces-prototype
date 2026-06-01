# Spec-vs-implementation audit roll-up

This roll-up summarises the eleven per-doc audits in `docs/audits/`
(`00_README.md` … `10_project_layout.md`). Each audit compared one
spec doc in `docs/` against the implementation under `packages/`,
treating code as authoritative. Per-doc findings live in those files;
this file is for the cross-cutting picture.

## 0. Maintainer review notes (post-audit)

After this roll-up was first generated, the maintainer reviewed it and
made a number of decisions. They're collected here so the per-doc
audits don't need to be re-read to know what's actually planned.
Concrete action items have been moved into the repo-root `PLAN.md`.

### Decisions locked in

- **Port**: `45678` stays as the default; the value becomes
  customisable via a build variable. The CF backend's `8080` override
  is fine as a backend-level pin. Examples should use the default.
- **`@cloudflare/workspace/shared` subpath**: dropped. Consumers go to
  `@cloudflare/workspace-rpc` for wire types.
- **`packages/internal`**: not reintroduced. Current split
  (`workspace-fs` + `workspace-rpc`) stays.
- **`gc()` on `Workspace`**: stays internal for now. The free function
  in `fs/gc.ts` is enough; no public surface yet.
- **`watch` placement**: stays a low-level primitive. No `fs.watch(...)`
  on `WorkspaceFilesystem`.
- **Symlinks**: kept for `node:vfs` adapter support, but **not**
  exposed on `WorkspaceFilesystem`. Document them as an internal
  primitive used by the adapter, not as a public fs surface.
- **`kill()`**: change to resolve after the child is reaped.
- **Detached / long-running execs**: bounded to a default ~320 s
  timeout, extensible per call. Replaces today's unbounded behaviour.
- **Biome linter**: deferred (would surface too much noise in one
  pass). Tracked in `PLAN.md` for a later sweep.
- **`warmup()` vs `ready()`**: maintainer wants this revisited; no
  rename yet. Tracked in `PLAN.md`.

### Upcoming package renames (not yet done)

Both packages will eventually shorten:

| Current name | Future name |
| --- | --- |
| `@cloudflare/workspace-fs` | `@cloudflare/vfs` |
| `@cloudflare/workspace-rpc` | `@cloudflare/rpc` |

All references in the per-doc audits use the current names. Doc
rewrites should land in current-name form first, and pick up the new
names when the rename lands.

### Investigation notes on the two flagged sync/wire drifts

Both items in §4 that the maintainer flagged as worrying turn out to
be **deliberate, well-motivated** drifts — not accidental rot. Found
by reading `git log` on the relevant files.

**1. Sync wire shape (audit 02 / 08).** The shape evolved during load
characterisation against `wsd`. The key commits:

- `dc692c0` *sync: guard loopback suppression against unpushed local
  writes* — F1 from the load characterisation. The old
  `applyChanges(source: 'upstream')` unconditionally advanced
  `pushRev = currentRev` after applying, on the theory that the
  apply's own rev bumps shouldn't bounce back. Under steady churn this
  stranded unpushed local writes (`pushRev` jumped past them; next
  `pushOnce` drained nothing). Symptom: `A.currentRev ≈ A.fetchRev / 2`
  in soak. Fix snapshots `rev` before the apply loop and only
  suppresses loopback when there were no pending local writes.
- `c95c74d` *rpc: external push semantics — senderRev=0 means local
  write* — F2 from the same load characterisation. The server used to
  hardcode `source: 'upstream'`, which silenced the outbound sync loop
  for external orchestrators. `senderRev` became the discriminator on
  the wire: `> 0` means a sync peer (loopback suppression on,
  `pushRev → currentRev`, `fetchRev → senderRev`); `=== 0` means an
  external writer (apply as `local`, leave watermarks alone so the
  outbound loop ships it).
- `69be34f` *rpc: add watermarks() RPC + convergence-time benchmarks*
  — observability surface for soak / dashboards. Three SQL scalars,
  read-only.
- `aea0f5e` *rpc: add readEntry(path) to SyncRPC* — single-path
  materialisation for interactive readers.
- `dec176b` *rpc: assert appliedPushRev on every push response* — the
  cross-side invariant check landed on push only.

So `push({senderRev, changes})`, the disappearance of `snapshot()` in
favour of rev-0 `fetchChanges`, and the extra `currentRev` /
`watermarks` / `readEntry` methods are all evidence-driven additions.
**Action: doc 02 and 08 catch up to the wire**, not the other way
around.

**2. Wire format / backpressure (audit 05 / 08).** Same story. The
key commit is `89b4717` *wsd: add exec Runner with DB-backed replay
log*, whose body spells the design out: "Backpressure on the live
stream rides on the WHATWG ReadableStream contract: when the consumer
stops pulling (typically capnweb's flow controller closing its
window), the runner pauses the child's stdout/stderr Readables, the
kernel pipe fills, the child blocks on write. End-to-end pull
backpressure with no in-process buffer larger than the kernel pipe."

The doc's ring-buffer / 1 MiB-spill story predates that decision. The
current pull-based approach is genuinely better: no in-process
buffering, kernel pipe is the natural backpressure surface,
SQLite-backed `EventLog` handles replay / reattach independently of
the live stream. The 16 MiB cap and 5 min TTL the doc describes are
real, but they're per-exec retention bounds on the log, not
backpressure thresholds.

**Action: doc 05 and 08 catch up to the implementation.**


## 1. Overall drift posture

The docs have drifted materially from code, and the drift is not even.
The lowest-level pieces — path semantics, SQLite schema DDL, the
fs-method surface, the sync primitives (chunking, content-addressed
blobs, watermarks, RPC method list) — are largely faithful: docs 03
and 04 in particular line up column-for-column and method-for-method
with `packages/workspace-fs/src/{schema,fs}/*`. The drift is
concentrated in three bands:

1. **The top of the stack** — `docs/README.md` (audit 00),
   `docs/01_directory_structure.md` (01), and `docs/07_injected_service.md`
   (07) describe a prior design (`ws.js` artifact, `cloudflare/workspace`
   Docker image, `ContainerRPC` over `/rpc` on port 4567, `Workspace({
   storage, sandbox, sessionId, mounts })` constructor, host-issued
   WebSocket upgrade into the container) that no longer matches code.
   The actual shape is `wsd` (a separate `@cloudflare/workspace-wsd`
   package shipping a Node SEA binary), `WorkspaceRPC` over `/ws` on
   `45678` (overridden to `8080` by the Cloudflare backend), and a
   reverse WebSocket dial from `wsd` back to the DO.
2. **Whole-feature gaps** — mounts (audit 06) and AI-SDK tools (audit
   09) are entirely unimplemented. The mount schema slots exist
   (`_vfs_mounts`, `vfs_nodes.mount_root`, `vfs_nodes.stub_size`) but
   nothing reads or writes them; the `@cloudflare/fs-tools` and
   `@cloudflare/git-tools` packages do not exist at all.
3. **Smaller per-surface drift** — sync wire shape (audit 02/08:
   `push({senderRev, changes})`, `appliedPushRev` only on push
   response, no `snapshot()`, extra `currentRev`/`watermarks`/
   `readEntry`), shell event shape (audit 05/08: `seq` field missing
   in doc, numeric `resume`, `disposeExec` vs `ackExec`), and project
   layout (audit 10: half the listed packages don't exist, half the
   real packages aren't listed).

Where the docs are accurate: path canonicalization (POSIX absolute,
no trailing slash, EINVAL on relative), the filesystem API surface
shape, the SQLite DDL (modulo two omissions: `vfs_manifests.last_seen`
and the `vfs_nodes_by_rev` index), chunk size and content addressing,
push/pull bracketing around `exec`, retention defaults (16 MiB cap,
5 minute TTL), and the `ExecHandle`/`ExecResult` field set (minus the
`exit` vs `exitCode` example bug in 00).

## 2. Per-doc verdict

| Doc | Primary package(s) | Match | One-line gist |
| --- | --- | --- | --- |
| 00 `README.md` | `workspace` (façade) | low | Doorway doc reads like the old design (`ws.js`, `cloudflare/workspace` image, port 4567, `{storage,sandbox,sessionId,mounts}` ctor, `warmup`/`prefetch`/`gc`); only the fs/shell method blocks survive. |
| 01 `directory_structure.md` | `workspace`, `workspace-fs`, `wsd` | medium | Path semantics correct; constructor signature wrong, configurable `root` doesn't exist, mount sections all rest on missing feature, FUSE-as-default contradicted by Cloudflare backend setting `DISABLE_FUSE=1`. |
| 02 `sync_protocol.md` | `workspace-fs/sync`, `workspace-rpc` | medium-high | Chunking / CAS / RPC list / watermarks accurate; drift on `appliedPushRev` (only on push response, not fetch stream), pullOnce buffers entries (not streaming), `fetchRev` advances once not per batch, `applyChanges` "bounded transactions" are counters only, ignore "extends" actually replaces. |
| 03 `filesystem_schema.md` | `workspace-fs/schema` | high | DDL matches column-for-column. Doc misses `vfs_manifests.last_seen`, `vfs_nodes_by_rev` index; describes JSON-encoded manifest as casync byte layout; `vfs_changes` pruning and `_vfs_mounts` use are aspirational. |
| 04 `filesystem_interface.md` | `workspace-fs/fs` | high | All major methods and overloads match. Drifts on `grep` being substring not regex, `ls` segment-aware not pure prefix, symlink support exists despite "no symlinks" claim, `ELOOP` missing from error table, `EACCES`/`EROFS` listed but never thrown, `watch` exists but isn't on the class. |
| 05 `shell_interface.md` | `workspace`, `wsd/exec` | medium-high | `exec`/`result`/`kill` shape correct; doc missing `seq` on events, `resume` accepts numbers, pull only fires on `result()` (not stream-only consumers), `kill()` does not wait for reap, `cwd` validation unimplemented, no line-buffered wire format. |
| 06 `mount_interface.md` | (none — feature absent) | none | Entire mount subsystem missing. Schema reserves `_vfs_mounts` + `mount_root`/`stub_size`; nothing else exists (`WorkspaceOptions.mounts`, `R2Bucket`, `GitHubRepo`, `LazyMount`, `EagerMount`, `prefetch`, `flushMounts`, debounced write-back, conflict hook — all absent). |
| 07 `injected_service.md` | `wsd`, `workspace/backends` | low | Sketches a prior `ws.js`-via-`@cloudflare/sandbox` design. Real shape is a `wsd` SEA binary, `/health` not `/healthz`, `/ws` not `/rpc`, port 45678 (and 8080 from CF backend), reverse WS dial via `POST /connect`, `WorkspaceRPC` not `ContainerRPC`, no `LOG_FILE`, no uncaught handlers, FUSE failure is fatal not degraded. |
| 08 `capnweb_interface.md` | `workspace-rpc`, `wsd` | medium | RPC method set largely correct; drifts on interface name (`ContainerRPC` → `WorkspaceRPC`), `snapshot()` (doesn't exist), `push` arg shape (`{senderRev, changes}` not positional stream), missing `currentRev`/`watermarks`/`readEntry`, `ackExec` → `disposeExec`, ring-buffer / spill story is fiction, `/rpc` → `/ws`, port 4567 → 45678. |
| 09 `tool_interface.md` | (none — package absent) | none | `@cloudflare/fs-tools` package does not exist. None of `createReadTool`, `createWriteTool`, `createEditTool`, `createGrepTool`, `createExecTool`, `FileStore`, `WorkspaceFileStore` exist. Substrate (`workspace.fs.*`, `workspace.shell.exec`) is in good shape. |
| 10 `project_layout.md` | repo root | low | Lists `workspace`, `fs-tools`, `git-tools`, `internal`; real packages are `workspace`, `workspace-fs`, `workspace-rpc`, `wsd`. Internal tree of `packages/workspace/src` largely fictional (`vfs.ts`, `serialize.ts`, `container-startup.ts`, `mounts/` — none exist). Build outputs (`ws.js`, `shared.js`) wrong. Biome linter actually disabled. |

## 3. Cross-cutting themes

### `wsd` vs `ws.js`, `WorkspaceRPC` vs `ContainerRPC`
The container daemon was renamed and repackaged. Doc 00, 07, 08, and 10
all still use the old names. The shipped artifact is a Node SEA binary
called `wsd` (`@cloudflare/workspace-wsd`, bin `wsd`,
`packages/wsd/scripts/build-bin.mjs`). The RPC interface is
`WorkspaceRPC = { sync: SyncRPC; shell: ShellRPC }` in
`packages/workspace-rpc/src/interface.ts`, not `ContainerRPC` in
`src/shared/`. Touched by: 00, 07, 08, 10. There is also a stale
`/rpc` comment in `packages/workspace-rpc/src/client.ts:18` worth
sweeping.

### Port-number drift (4567 / 45678 / 8080)
Three values for one knob:
- Docs use `4567` (00 finding 10; 07 findings 11/19; 08 finding 13).
- `wsd` `DEFAULT_PORT` is `45678` (`packages/wsd/src/cli/wsd.ts:23`).
- `CloudflareContainerBackend` forces `PORT=8080` and the example
  `Dockerfile` `EXPOSE`s 8080 (07 finding 11).
Pick one canonical default and note the backend override. Touched by:
00, 07, 08.

### Endpoint paths (`/rpc`, `/healthz` vs `/ws`, `/health`)
Doc 07 and doc 08 both promise `/rpc` (WebSocket) and `/healthz`
(probe). Code serves `/ws` for capnweb WebSocket and `/health` for the
probe (`packages/wsd/src/cli/wsd.ts:134, 170`). Touched by: 07, 08.

### WebSocket direction (host → container vs container → host)
Doc 07 describes the host issuing a WebSocket upgrade *into* the
container. Code inverts this: `wsd` dials *out* via its `POST /connect`
endpoint, the egress is wired with `container.interceptOutboundHttp`,
and the DO accepts the upgrade in `handleFetch()` on
`CloudflareContainerBackend`. This is the largest single behavioural
drift in 07. Touched by: 07 (08 indirectly).

### Constructor shape (`{storage, sandbox, sessionId, mounts}` vs `{storage, backends, now?}`)
The advertised `Workspace` constructor doesn't match the real
`WorkspaceOptions`. The sandbox binding and session id are now
carried by a `WorkspaceBackend` (`CloudflareContainerBackend`) rather
than top-level fields. Touched by: 00, 01, 06 (mounts), 07 (boot
example).

### Missing mount feature
The schema reserves seats (`_vfs_mounts` table,
`vfs_nodes.mount_root`, `vfs_nodes.stub_size`) but no runtime code
reads them. Every mount-related claim (lazy stubs, `R2Bucket` /
`GitHubRepo` factories, `prefetch`, `flushMounts`,
`onMountConflict`, `EROFS` on read-only mounts, mount-root nesting
rejection, write-back debounce) is unimplemented. Touched by: 00
(findings 3/6/13), 01 (mount sections + reserved paths), 02 (lazy-
stub hydration), 03 (`_vfs_mounts` populated), 04 (`EROFS` never
raised), 06 (entire doc).

### Missing tools packages
Neither `@cloudflare/fs-tools` nor `@cloudflare/git-tools` exists.
No AI SDK or `@cloudflare/agents` dependency anywhere in the
workspace. The substrate (`workspace.fs.*`, `workspace.shell.exec`)
is solid; only the wrappers are missing. Touched by: 00 (finding 5),
09 (entire doc), 10 (listed but absent).

### Push/pull / sync wire-shape drift
Several related items, all in audit 02/08:
- `push()` takes `{ senderRev, changes }`, not a positional stream;
  `senderRev` distinguishes peer from external orchestrator.
- `fetchChanges` takes a single object param `{ sinceRev?, ignore? }`,
  not positional args.
- `snapshot()` doesn't exist — baseline is `fetchChanges({ sinceRev: 0 })`.
- `appliedPushRev` only rides on push responses; `ChangeEntry`/fetch
  stream don't carry it; the cross-side invariant assert only fires
  post-push.
- The sync surface also ships `currentRev`, `watermarks`, `readEntry`
  not listed in doc 08.
- Ignore list **replaces** default, doesn't **extend** it.

### Doc constructor-example bug recurrences
- `result().exit` should be `exitCode` (00 finding 23, 05).
- `ExecEvent` missing `seq` (00 finding 25, 05, 08).
- `mkdir` not awaited in constructor (00 finding 14).
- `Workspace.grep` referenced where it's actually `workspace.fs.grep`
  (09).

### "FUSE default" vs reality
Doc 01/07: FUSE-mounted mirror is the steady state inside the
container. Reality: `wsd` mounts FUSE only when `DISABLE_FUSE` is
unset, and the only shipped backend (`CloudflareContainerBackend`)
pins `DISABLE_FUSE=1`. FUSE-failure handling in `wsd` is also
fatal-on-detect, not the soft `fuseActive=false` degrade the doc
07 promises. Touched by: 01, 07.

### `ws.js` artifact / `cloudflare/workspace` Docker image
The two-line Dockerfile recipe (`COPY --from=cloudflare/workspace
/app/ws.js`) is fiction; the real recipe in
`examples/wsd-container/Dockerfile` copies a locally-built SEA binary.
Touched by: 00 (finding 9), 07 (findings 1/8), 10 (build outputs).

### Schema vs feature wiring
Doc 03 is mostly accurate at the DDL level, but multiple tables /
columns are "schema reserved, no producer/consumer": `_vfs_mounts`,
`vfs_nodes.mount_root`, `vfs_nodes.stub_size`, the `'symlink'` enum
member and `link_target` column (FS-layer support exists for
symlinks but the doc treats them as "future"), and `vfs_changes`
pruning logic that the doc claims happens in the same txn as
`pushRev` advance but doesn't. Touched by: 02 (changes pruning), 03,
06 (mounts).

### `disposeExec` vs `ackExec`
The wire method to release an exec record is `disposeExec`. Both 05
and 08 still call it `ackExec`. (Already cross-referenced between
those audits.)

## 4. Drift grouped by tag

### `doc-fix` (most items — the docs need to catch up to code)

- **Rename throughout**: `ws.js` → `wsd`; `ContainerRPC` →
  `WorkspaceRPC`; `ackExec` → `disposeExec`; `/rpc` → `/ws`;
  `/healthz` → `/health` (audits 00, 07, 08).
- **Port number** drop from `4567` to whatever the canonical value
  is (most likely `45678`, with backend override noted) (00, 07, 08).
- **Constructor example** in `docs/README.md` and
  `docs/01_directory_structure.md` rewritten to
  `{ storage, backends: [new CloudflareContainerBackend({...})] }`
  with `await workspace.ready()` instead of `warmup()` (00, 01).
- **Dockerfile recipe** in `docs/README.md` and
  `docs/07_injected_service.md` replaced with the real
  `examples/wsd-container/Dockerfile` shape (debian base, apt
  `fuse3 libfuse2t64`, `COPY build/wsd-linux-x64 /usr/local/bin/wsd`)
  (00, 07).
- **High-level `Workspace` interface table** (00 finding 26): drop
  `warmup`/`prefetch`/`gc`, fix `push`/`pull` return types to
  `Promise<number>`.
- **`@cloudflare/workspace/shared` entrypoint** doesn't exist; point
  consumers at `@cloudflare/workspace-rpc` subpaths (00 finding 8).
- **Sync wire shape** in 02 and 08: `push({senderRev, changes})`,
  `fetchChanges({sinceRev?, ignore?})` (object param), remove
  `snapshot()` and explain rev-0 fetchChanges baseline, add
  `currentRev`/`watermarks`/`readEntry` to the interface block,
  document the doc-claimed-but-not-real "per batch fetchRev advance"
  and "bounded transactions in applyChanges" as the per-mutation
  reality (audit 02 F8/F10/F11/F12/F21/F24/F33/F34/F38).
- **`ignore` semantics**: list **replaces** the default, doesn't
  extend it (02 F38).
- **`ExecEvent`** add `seq` (05, 08).
- **`exec`'s `resume`** also accepts numeric seq (05).
- **`exec` post-exec pull** only fires when `result()` is awaited,
  not for stream-only consumers (05).
- **`kill()`** does not wait for reap; only signals delivery (05).
- **Wire format** isn't line-buffered; it's chunked bytes with
  pull-based pause/resume on the child pipe; drop the ring-buffer /
  1 MiB spill story (05, 08).
- **`exitCode` mapping** for signal terminations (SIGTERM→143 etc.)
  should be in 05.
- **Schema** doc 03: add `vfs_manifests.last_seen` column,
  `vfs_nodes_by_rev` index, note that `vfs_manifests.encoded` is JSON
  today (planned byte layout), mark `vfs_changes` pruning and
  `_vfs_mounts` use as "(planned, not yet wired)".
- **Filesystem doc 04**: state `grep` is substring not regex; state
  `ls` is segment-aware not pure prefix; document symlinks
  (`symlink`/`readlink`/`ELOOP`) **or** explicitly mark them
  internal-only (see needs-decision); add `ELOOP` to error table;
  drop or future-mark `EACCES`/`EROFS` (no callsite); document
  `find` relative-rooted globs and `ENOENT`/`ENOTDIR` on the
  directory; document `stat("/").name === ""`; document
  `WatchHandle` either by exposing on the class or by noting it as
  a primitive consumed by sync.
- **Injected service doc 07**: full rewrite per recommendations —
  endpoints, env-var table (six vars consumed, not three), reverse
  WS dial, no `LOG_FILE`, no uncaught handlers, FUSE-detect failure
  is fatal under `DISABLE_FUSE=0`, no `fuseActive` flag.
- **Project layout doc 10**: real package list
  (`workspace`/`workspace-fs`/`workspace-rpc`/`wsd`), real
  `packages/workspace/src/` tree (`workspace.ts`, `shell.ts`,
  `backend.ts`, `backends/`, `proxy.ts`, `proxy-stub.ts`, `stub.ts`,
  `test-harness/`), real build outputs (`dist/cjs/index.js`,
  `dist/cli/wsd.cjs`, etc.), `examples/` at repo root, `tests/`
  convention is actually `test-harness/`, Biome lint is disabled.
- **Tool doc 09**: contingent on the keep/drop decision below;
  worst case delete; best case add a "package not yet implemented"
  banner, fix `Workspace.grep` → `workspace.fs.grep`, fix
  `@cloudflare/ai-chat` → real `@cloudflare/agents` path.

### `code-fix` (small code adjustments where the doc target is the correct destination)

- **`EUNKNOWN_HASH`** is reserved in `WireErrorCode` but never thrown;
  `packages/workspace-fs/src/sync/push.ts:22` throws a plain
  `Error("pushObjects: missing blob …")` instead. Wire it up through
  `createWorkspaceError` (08 finding 6).
- **Stale `/rpc` comment** in `packages/workspace-rpc/src/client.ts:18`
  (07 recommendations).
- **Widen `RmOptions` / `MkdirOptions`** boolean fields from `true`
  literal to `boolean` for `node:fs/promises` parity (04).
- **Expose `fs.watch(...)`** on `WorkspaceFilesystem` — primitive
  exists in `fs/watch.ts`, just unbound on the class (04).
- **Biome linter on**: currently `biome.json` has
  `"linter": { "enabled": false }`, yet AGENTS.md tells contributors
  to run `npx biome check .` (10).

### `needs-decision` (real design questions surfaced by the audits)

These are the items where neither side is obviously right and the
project needs to pick.

- **Canonical port number**: 4567 (doc target) vs 45678 (`wsd`
  default) vs 8080 (CF backend override). Three values in one repo
  is the actual bug (07).
- **Publish a `cloudflare/workspace` Docker image?** The doc promises
  a two-line `FROM cloudflare/workspace:latest` DX; today only the
  `examples/wsd-container/` recipe exists (07).
- **Mount feature: build or retire.** Schema slots are pre-allocated
  in `_vfs_mounts` / `mount_root` / `stub_size`. The doc describes a
  substantial API (lazy/eager mounts, R2/GitHub factories,
  prefetch/flush, debounced write-back, conflict hook, per-mount
  options). Either commit to building this or remove the schema
  reservations and the doc (06; touches 01/02/03 also).
- **`fs-tools` (and `git-tools`) package: build or retire.** If
  building, also pick: separate `@cloudflare/fs-tools` package
  vs subpath of `@cloudflare/workspace`? Keep `FileStore`
  indirection or bind tools directly to `Workspace`? (09, 10).
- **Symlinks: public surface or internal-only?** Code supports
  `symlink`/`readlink` with `ELOOP` cap; doc 04 says "no symlinks".
  Pick one and align (04).
- **`watch` placement**: expose `fs.watch(path, options)` on the
  class (mirroring `node:fs/promises`) or leave it as a low-level
  primitive (04).
- **`writeFile` true streaming chunking**: today the stream is
  drained into a single buffer before hashing/chunking. Doc reads
  as zero-copy. Implement streaming or tone down the doc (04
  `needs-decision`; `writeFile.ts:61-64` already has a TODO).
- **`encoding: "utf8"` flush tail bytes**: TransformStream's flush
  drops any returned tail; current behavior is silent loss. Accept,
  emit synthetic, or raise? (05).
- **`cwd` validation in shell exec**: doc promises rejection of
  paths like `/tmp`, runner has no validation. Tighten runner or
  relax doc? (05).
- **Detached / long-running execs retention**: live execs are
  unbounded; sweeper reaps records 5 minutes after exit. Cap or
  document the unboundedness? (05).
- **`pause()` / `resume()` on host exec handle**: doc 08 promises;
  not implemented. Build or drop? (05, 08).
- **`kill()` semantics**: today fire-and-forget post-signal; doc
  says "resolves once reaped". If reap-await is desired, small
  code change. (05).
- **`appliedPushRev` on fetch stream + per-response invariant
  assert on pull**: doc target is wire-inspectable invariant in
  both directions; today only on push (02 F21/F24/F27a).
- **Streaming applyChanges + per-batch `fetchRev` advance**: today
  pullOnce buffers the entry stream and advances `fetchRev` once at
  end of stream. Doc target (bounded peak memory, per-batch crash
  recovery minimal) is genuinely valuable (02 F8/F10/F11/F34).
- **Push-atomic on receiver**: doc says push is atomic from the
  DO's perspective; receiver does sub-transactions per mutation
  (02 F33). Wrap apply in single txn when an on-disk container
  mirror lands?
- **Per-Workspace FIFO mutation queue** (doc 02 line 155-157): no
  implementation visible in `workspace-fs/sync` or
  `workspace-rpc/sync-driver`. Built elsewhere, or aspirational?
  (02 F36).
- **Container watermarks "in-memory only" framing**: today
  container-side `Database` is the same abstraction, persistence
  is a deployment choice (02 F23).
- **`fuseActive=false` soft-fail**: today FUSE-detect failure is
  fatal unless `DISABLE_FUSE=1`. Doc 07 wants a degraded mode where
  RPC still works and writes mirror to host FS — additional code
  path. Build or demote to open question? (07).
- **`LOG_FILE` + `uncaughtException` handler** in `wsd`: doc 07
  promises a log file and crash handler with `exit(1)`; neither
  exists. Likely worth a small code-fix; current stdout-only
  logging is thin for a daemon (07).
- **`@cloudflare/workspace/shared` subpath**: drop in favour of
  `@cloudflare/workspace-rpc`, or add a re-export so consumers
  don't have to learn a second package? (00).
- **`warmup()` naming**: doc says `warmup()`, code has `ready()`.
  Rename / alias / leave? Reads better in an `onStart` block (00).
- **`gc(safetyWindowMs?)`** on `Workspace`: today only a free
  function `gc(db, options)` in `fs/gc.ts`. Expose on the class?
  (00, 03).
- **`packages/internal` reintroduction**: doc 10 lists it; today
  shared types live in `workspace-fs` and `workspace-rpc`. Keep
  current split or re-introduce internal? (10).
- **`onRpcEvent` host hook with byte counts**: today only on
  `createSyncClient` (no byte counts), nothing on host
  `Workspace`. Capnweb doesn't surface frame sizes today (08).
- **Binary-frame rejection** in `acceptWebSocketSession`: doc 08
  promises hard fail on first binary frame; no guard exists today
  (08).

## 5. High-value targets the doc still captures

Aggregating every "drifts where doc target still looks valuable"
section across all eleven audits. These are the places where, even
though code currently wins by audit rules, the doc captured a
design worth keeping on the roadmap.

### Mounts (entire feature)

The whole `docs/06_mount_interface.md` surface is worth building
substantially as specified. The schema author already paid most of
the design cost (`_vfs_mounts` table, `mount_root` / `stub_size`
columns are pre-allocated and consistent with the doc). The doc
spans:

- `WorkspaceOptions.mounts: Record<string, Mount | MountFactory>`
  plus `onMountConflict?` callback (06).
- Built-in factories `R2Bucket(env.SHARED_FILES, { prefix })` and
  `GitHubRepo("cloudflare/agents", { env })` — one-liner pre-fill
  at construction time, in the bindings idiom (00 findings 3/13,
  06).
- Lazy stub semantics: `list()` inserts entries with `mount_root` +
  `stub_size`, first read calls `fetch(relPath)`, concurrent reads
  dedupe per absolute path (06).
- `workspace.prefetch(root?)` for hydrating lazy mounts from
  `onStart` (00 finding 6, 06).
- `workspace.flushMounts()` and per-mount `writeBack`/`writeBackMs`
  debounced write-back (06).
- Mount-root nesting check at construction; read-only mounts
  rejecting writes with `EROFS`; read-only mount drop on post-exec
  pull (01, 04, 06).
- `_vfs_mounts` populated for restart-stable indexing (03, 06).

### Filesystem surface polish

- **True streaming `writeFile(stream)`** — doc reads as zero-copy,
  code buffers; the `writeFile.ts:61-64` TODO is the same target
  (04).
- **`fs.watch(path, options)` exposed on `WorkspaceFilesystem`** —
  primitive in `fs/watch.ts` already, just unbound (04).
- **Widen `RmOptions`/`MkdirOptions` to `boolean`** for
  `node:fs/promises` portability (04).

### Sync protocol durability and observability

- **Streaming consumption in `pullOnce`** — bounded peak memory
  (02 F8).
- **Per-batch transactions in `applyChanges`** for crash safety
  (02 F10/F33).
- **Per-batch `fetchRev` advance** so DO-restart mid-pull resumes
  minimally (02 F11/F34).
- **`appliedPushRev` echoed on fetch stream / `ChangeEntry`** and
  the cross-side invariant asserted on both directions (02
  F21/F24, 08 finding 11). The wire registry already commits to
  `EUNKNOWN_HASH`; the doc's promise of `code`-bearing typed
  rethrow is the right target.
- **`EUNKNOWN_HASH` actually thrown** by `pushObjects` (08 finding
  6) — registry already reserves it.
- **Host-side typed `WorkspaceError` carrying wire `code`** (08
  finding 11).
- **Binary-frame rejection** as a cheap defensive guard (08
  finding 14).
- **Host `onRpcEvent` with byte counts** for observability (08
  finding 15).

### Shell surface

- **`pause()` / `resume()` on host exec handle** (08 finding 17,
  05).
- **`kill()` resolves on reap** rather than fire-and-forget (05).
- **`cwd` validation** under workspace root, matching the absolute-
  path-or-throw discipline elsewhere (05).

### Injected service / deployment story

- **Published `cloudflare/workspace` Docker image** + the one-liner
  Dockerfile DX (00 finding 9, 07 findings 1/8).
- **Provider-agnostic boot sequence** (start → poll health → open
  RPC) as the mental model, with endpoint names corrected (07).
- **`LOG_FILE` + `uncaughtException` / `unhandledRejection`
  handlers** with `process.exit(1)` for daemon robustness (07).
- **`fuseActive=false` soft-fail** mode for resilience (07).

### Workspace lifecycle ergonomics

- **`warmup()`** as the eager-connect verb in `onStart` blocks —
  reads better than `ready()` (00).
- **`gc(safetyWindowMs?)`** on the `Workspace` class — substrate
  in `fs/gc.ts` already (00, 03).
- **`@cloudflare/workspace/shared` subpath** re-exporting wire
  types so consumers don't learn `@cloudflare/workspace-rpc`
  separately (00).
- **Configurable container `MOUNT_POINT` plumbed through the
  Cloudflare backend option** rather than hard-coded in
  `cloudflare-container.ts:210` (01).
- **FUSE-by-default in the Cloudflare container backend** — the
  one-line `DISABLE_FUSE: "1"` is what separates the doc's mental
  model from reality (01).

### Schema-side targets

- **`vfs_changes` pruning** in the same txn as `pushRev` advance
  (03; doc target from doc 02).
- **`_vfs_mounts` actually populated** — depends on mount feature
  (03, 06).
- **Casync `.caidx` byte layout for `vfs_manifests.encoded`** —
  phase 4 swap-in; `sync/manifests.ts:10-12` already flags the
  intent. Open question: does the byte layout actually need
  `offset` since it's recoverable from a prefix-sum of `size`?
  (03).

### Tools (contingent on keep/drop decision)

If `fs-tools`/`git-tools` are kept:
- **`read` tool's `nextOffset` continuation protocol** — small
  detail that pays off in agent loops (09).
- **`edit` tool matching against original file content with
  explicit rejection of overlapping edits** — right semantics for
  incremental edits (09).
- **`grep` tool returning `truncated` flag** rather than
  paginating — pagination is a footgun for LLMs (09).
- **`exec` tool `allowedCommands` allow-list + stdout/stderr byte
  cap with `truncated` flag** — defensible defaults for LLM-driven
  shell (09).
- **`FileStore` swappable adapter** — only if non-`Workspace`
  backends (SSH bridge, remote git working tree) are real targets
  (09).

## 6. Recommended next actions

Ordered by impact and by what unblocks other fixes.

1. **Decide the fate of mounts and tools packages**
   (`needs-decision`). These are the two whole-feature gaps; every
   downstream doc cleanup branches on the answer. If keeping:
   schedule the build. If dropping: delete `docs/06_mount_interface.md`
   and `docs/09_tool_interface.md`, remove schema reservations
   (`_vfs_mounts`, `mount_root`, `stub_size`), and clean
   cross-references in `docs/README.md`, `docs/01_directory_structure.md`,
   `docs/10_project_layout.md`.

2. **Pick a canonical port number and propagate** (`needs-decision`).
   Three values in one repo is a real bug. The path of least
   surprise: `45678` in `wsd` stays, Cloudflare backend's `8080`
   override gets a one-line callout, all `4567` references in docs
   are deleted. Unblocks 00, 07, 08 sweeps.

3. **Rewrite `docs/07_injected_service.md` against current code.**
   Largest single drift in the audit set; touches naming (`wsd`),
   endpoints (`/health`, `/ws`), env vars (six, not three),
   reverse WS dial via `POST /connect`, no `LOG_FILE`, FUSE-detect
   fatal. Pull from the recommendations block in audit 07
   verbatim. Unblocks 00 and 10.

4. **Rewrite `docs/README.md` to match the current API surface.**
   New constructor example (`{ storage, backends:
   [CloudflareContainerBackend(...)] }`), drop `warmup`/`prefetch`/
   `gc`/`mounts` from the high-level interface table (or mark them
   "target, not implemented"), fix the Dockerfile recipe to
   `examples/wsd-container/`, fix `result().exit` → `exitCode`,
   add `seq` to ExecEvent, drop `@cloudflare/workspace/shared`
   (or implement it).

5. **Rewrite `docs/10_project_layout.md`.** Real package list,
   real `packages/workspace/src/` tree, real build outputs,
   `examples/` at repo root, `test-harness/` convention. Note
   Biome linter is disabled (or flip it on as a code-fix).

6. **Rewrite `docs/08_capnweb_interface.md` against
   `packages/workspace-rpc/src/interface.ts`.** `WorkspaceRPC` (with
   `sync`/`shell` split), real push arg shape (`{senderRev,
   changes}`), add `currentRev`/`watermarks`/`readEntry`, drop
   `snapshot()`, fix `ackExec` → `disposeExec`, fix `/rpc` → `/ws`,
   fix port, drop the ring-buffer / spill story.

7. **Code-fix sweep** (small, mechanical):
   - Throw `EUNKNOWN_HASH` from `packages/workspace-fs/src/sync/push.ts`
     via `createWorkspaceError`.
   - Clean stale `/rpc` comment in
     `packages/workspace-rpc/src/client.ts:18`.
   - Widen `RmOptions`/`MkdirOptions` boolean fields to `boolean`.
   - Decide on Biome linter (`biome.json` `"linter": { "enabled": true }`)
     and fix resulting findings, or update AGENTS.md.

8. **Pick a stance on symlinks and `watch`** (`needs-decision`),
   then update `docs/04_filesystem_interface.md` to match (add
   `ELOOP` to error table either way; either document
   `symlink`/`readlink` or mark them internal; either expose
   `fs.watch` on the class or mark it as a sync-layer primitive).
   Also fix the smaller doc 04 items: `grep` is substring, `ls` is
   segment-aware, `EACCES`/`EROFS` either future-marked or
   removed, `find` glob is rel-rooted, `stat("/").name === ""`.

9. **Update `docs/02_sync_protocol.md`** with the wire-shape
   corrections (push arg shape, ignore replaces not extends,
   `fetchRev` advances once at end of stream, `applyChanges`
   "bounded transactions" are counter-only, `appliedPushRev` only
   on push response). Flag the durability/streaming items as
   roadmap targets if we want them.

10. **Update `docs/03_filesystem_schema.md`** — small surgical
    edits: add `vfs_manifests.last_seen`, add `vfs_nodes_by_rev`
    index, note the manifest encoding is JSON today, mark
    `vfs_changes` pruning and `_vfs_mounts` use as "(planned, not
    wired)". Resolve the offset-in-byte-layout question before the
    phase-4 encoding swap.

11. **Update `docs/01_directory_structure.md`**: rewrite the
    constructor example, drop or qualify the `root` option,
    qualify the FUSE-as-default paragraph (Cloudflare backend
    pins `DISABLE_FUSE=1`), remove "root path auto-created" claim
    or scope to `ROOT_INODE` only.

12. **Update `docs/05_shell_interface.md`**: add `seq` to
    ExecEvent, document numeric `resume`, qualify pull-on-result
    (not stream-only), qualify `kill()` as signal-delivery not
    reap, document `exitCode` mapping for signal terminations,
    list error codes (`EEXEC_BUSY`, `ELOG_TRUNCATED`, `ENOENT`),
    remove "line-buffered wire format" or rewrite as chunked-
    bytes / pull-based pause-resume.

13. **Decide the post-decision shell items** (`needs-decision`):
    `cwd` validation, encoding-flush tail bytes, detached-exec
    retention, host-side `pause()`/`resume()`, `kill()` reap-await
    — pick a side per item and fold into 05.
