# Plan: Replace `packages/workspace` with the `next` branch version

## Status

Phase 1: ✅ Done.
Phase 2: 🟡 Build-green. Runtime-untested. Known regressions listed.
Phase 3 (revised): ✅ Done — vendor tree deleted, agent on
published `@cloudflare/workspace@0.0.0-alpha.3` + GHCR wsd image.
Phase 4: ✅ Done. Agent-suite green (13/13), unit tests green
(223/223). Regressions #3 (`/tar` route), #4 (skills R2 mount),
#7 (decorator transform) closed. End-to-end `wrangler dev` smoke
passes: container builds (WARP CA threaded through), three
Sandbox containers start from the warm pool, `/tar` round-trips
the live `WorkspaceStub` through capnweb and returns a `vfs/`
block. READMEs rewritten for the published package + GHCR image
wiring. Only known regression still open is #1 (streaming exec),
blocked on upstream `WorkspaceShellStub` getting a framed event
transport.

Work landed in branch `port-workspace-next` (off `hackspace`).

## Curveball: the upstream package is now published

The `next` branch was promoted to https://github.com/cloudflare/workspace
and published to npm as `@cloudflare/workspace`, current tag
`0.0.0-alpha.3`. A matching wsd container image is on GHCR at
`ghcr.io/cloudflare/workspace-wsd-linux-x64:0.0.0-alpha.3`.

Notable facts that change the plan:

1. **Only `@cloudflare/workspace` is on npm.** `dofs`,
   `workspace-rpc`, and `workspace-wsd` are **not** published as
   separate packages — they're bundled into the single
   `@cloudflare/workspace` tarball at build time (rolldown bundle
   in `dist/index.js` plus a re-exported `dist/git.js`).
2. **The wsd SEA binary ships in the tarball** as
   `dist/bin/wsd-linux-x64` (~120 MB unpacked), but for container
   use you don't need it locally: pull the GHCR image instead.
3. **`SQLiteWorkspaceProvider` is exported directly from
   `@cloudflare/workspace`.** Consumers no longer import from
   `@cloudflare/dofs` at all.
4. **There is a `@cloudflare/workspace/git` subpath export.**
   `createGitClient({ ws })` wraps `@platformatic/vfs` +
   isomorphic-git and exposes `clone()` / `diff()`. This collapses
   `packages/git-tools/src/tools/vfs.ts` to zero lines and unblocks
   the disabled `git_clone` tool (regression #5).
5. **wsd accepts `FUSE_MOUNT=auto`** (replaces the older
   `FUSE_SHIM=1`). Same image works under wrangler dev (userspace
   shim, no `/dev/fuse`) and Cloudflare Containers (real FUSE).
6. **Peer deps on the published package** are optional and only
   needed if you use the git subexport: `@platformatic/vfs`,
   `diff`, `isomorphic-git`. We already pin all three (transitively
   through the vendored workspace + git-tools).

Net effect: Phase 3 becomes a deletion exercise. The five vendored
packages disappear; the agent depends on one published npm module
and one GHCR image, both pinned at `0.0.0-alpha.3`.

## Decisions (resolved earlier)

1. Swap source + fix the world to compile. ✅
2. Vendor `@cloudflare/dofs` and `@cloudflare/workspace-rpc`. ✅
3. Vendor `@cloudflare/workspace-wsd` (and `@cloudflare/workspace-wsd-linux-x64` for the prebuilt SEA). ✅
4. Hard-cut consumers. Reference: `examples/think` on the `next` branch.
   - Mounts: reimplement on demand; currently deferred. None of the
     v1 surface re-enables them.
   - `loadWorker` / worker-sandbox: dropped.
   - `git-tools`: trimmed to `gitClone` only, modelled on
     `examples/think/src/tools/git/clone.ts`.
   - `apps/agent/sandbox/`: dropped. New `Sandbox` DO owns a wsd
     container directly; warm pool retained, drives the new DO.
5. Toolchain lift: deferred. Vendored packages keep their own
   pinned TS6/vitest4 in `devDependencies`. The repo-wide TS pin is
   still 5.7; the agent + git-tools typecheck under that without
   tripping the new packages' built `.d.ts`.

## Phase 1 — Vendor (done)

Commit: `Phase 1: vendor @cloudflare/workspace from next branch`

- `packages/workspace/` overwritten from `next`.
- `packages/dofs/`, `packages/workspace-rpc/` (renamed from `next`'s
  `packages/rpc/`), `packages/wsd/`, `packages/wsd-linux-x64/` added.
- Root `package.json` workspaces list trimmed (no more
  `packages/workspace/examples/*`).
- `fuse-native` made optional on `@cloudflare/workspace-wsd` so arm64
  dev hosts don't fail npm install.
- `wsd-linux-x64`'s `os: ["linux"]` / `cpu: ["x64"]` constraint relaxed
  locally for the same reason.
- Tests: `@cloudflare/dofs` 251/251 ✅. `@cloudflare/workspace-rpc`
  42/42 ✅. `@cloudflare/workspace` test suite not yet exercised
  (needs miniflare proxy worker; deferred).

## Phase 2 — Hard-cut consumer rewrite (build-green)

Four commits:

### 2a — Demolish removed surface

- Deleted: `apps/agent/src/worker/`, `apps/agent/src/fork-registry.ts`,
  `apps/agent/src/debug-tar.ts`, agent-suite tests for mounts/skills/
  mount-host.
- `packages/git-tools` trimmed: deleted `commit/create-repo/list-repos/
  push/share` tools, replaced `clone` with the example-think version,
  added `vfs.ts` glue.

### 2b — New `Sandbox` container DO

- `apps/agent/src/sandbox.ts` (new): container-enabled DO that owns
  a `Workspace` + `CloudflareContainerBackend`. Same-DO constraint of
  the backend means this DO holds the Workspace, not the Agent.
  Exposes `getWorkspace()` (returns a `WorkspaceStub`) plus the four
  RPC methods the warm pool drives: `startAndWaitForPorts`, `stop`,
  `renewActivityTimeout`, `getState`.
- `apps/agent/src/pool.ts` retypes the `PoolEnv` for the new
  `Sandbox` DO and ships a `sandboxForSession` helper.
- `apps/agent/src/warm-pool.ts` body unchanged; its container-side
  calls already routed through `env.Sandbox.idFromName(...)`.
- `apps/agent/src/index.ts` re-exports `WorkspaceProxy`, replaces
  `@cloudflare/sandbox` debug routes with the new
  `WorkspaceStub.shell.exec` / `fs.readFile` surface.
- `worker-configuration.d.ts` retypes `Sandbox`, drops `LOADER` and
  `Artifacts`.
- `package.json` drops `@cloudflare/sandbox`.

### 2c — agent.ts ported

- Imports: drop `Workspace`, `R2Mount`, `ForkRegistry`,
  `WorkerDeployer`, fetch helpers, `debug-tar`, exec scaffolding;
  add `WorkspaceStub` type and the new `workspace-adapter.ts`.
- Workspace acquisition: now lazy, via `getWorkspace()` →
  `resolveContainerId` → `Sandbox.getWorkspace()`. Cached in
  `_workspaceStub`; rebuilt on a sandbox cycle.
- `onStart` / `beforeTurn` warmup routes through
  `warmupWorkspace()`.
- Request handlers `/vfs`, `/files-list`, `/files` rewritten against
  `Workspace.fs.find` / `.stat` / `.readFile`. `/tar` returns 501
  until the new fs surface gets a `tar` helper or we re-port
  `debug-tar.ts`.
- `buildTools`: read/write/edit close over a lazy `FileStore` that
  wraps the new stub through `workspace-adapter.adaptForFsTools`.
  ls/stat/mkdir/rm/find/grep map to `ws.fs.*`. Exec degrades to a
  non-streaming `runCancellable` over `ws.shell.exec` (streaming
  exec is not yet plumbed through `WorkspaceShellStub`).
- Deleted (~250 lines): `_recoverInflightExecs`,
  `_recoverOneInflightExec`, `_patchExecPart`, `_execStreamingTool`,
  `_inflight()`, the `git_*` family (except `clone`, currently
  disabled — see below), `worker_deploy`, `worker_fetch`.
- `apps/agent/src/workspace-adapter.ts` (new): structural adapter
  that satisfies `@cloudflare/fs-tools.WorkspaceLike` from the
  new `WorkspaceStub.fs`.
- `apps/agent/src/{exec-buffer,exec-inflight}.ts` and their tests
  deleted.

### 2d — Container config

- `apps/agent/Dockerfile` rewritten around
  `cloudflare/workspace-wsd-linux-x64`. Drops the
  `cloudflare/sandbox:0.9.3` base; debian-slim + COPYd wsd binary +
  project toolchain (zig, go, esbuild, wrangler).
- `apps/agent/wrangler.jsonc` drops `worker_loaders` (`LOADER`) and
  `artifacts` (`Artifacts`).
- Agent-suite `wrangler.jsonc` drops `MountHost` and `LOADER`.
- `apps/agent/sandbox/` (CA-sync helper for the old image) deleted.

### Build / test status at end of Phase 2

- `npx tsc --noEmit` in `apps/agent/`: ✅
- `npx tsc --noEmit -p tests/agent-suite/tsconfig.json`: ✅
- `npx tsc --noEmit` in `packages/git-tools/`: ✅
- `npm run build` for `@cloudflare/dofs`, `workspace-rpc`,
  `workspace`, `workspace-wsd`: ✅
- `apps/agent` unit tests (`npx vitest run`): ✅ 227/227 pass
- `apps/agent` agent-suite (`vitest-pool-workers`): ❌ all 6 files
  fail with a generic `SyntaxError: Invalid or unexpected token` at
  the workerd module evaluator. No filename/line; not a code
  regression in our source (typecheck is clean). Likely the
  pool can't ingest one of the new packages' compiled output
  (probably `node:sqlite` inside dofs). **Deferred to Phase 4.**
- Production wrangler build: not yet attempted.

## Known regressions to revisit

1. **Streaming exec.** The non-streaming degrade means the chat UI
   no longer shows live stdout/stderr from long-running commands.
   Restoring it needs a byte-framed streaming method on
   `WorkspaceShellStub` (the underlying `WorkspaceShell.exec` does
   return a `ReadableStream<WorkspaceExecEvent>`; the stub just
   doesn't expose it because Workers RPC can't carry the event
   stream without an SSE / length-prefixed transport).
2. **Exec inflight recovery.** A DO eviction mid-exec leaves the
   tool part in `input-streaming`. The new API has no
   `getProcess` / `streamProcessLogs` reattach, so we lean on
   `resolveOrphanToolCalls` in `beforeTurn` to mark it cancelled on
   the next turn. Acceptable trade-off for now.
3. **`/tar` debug export.** Returns 501. Re-implement against
   `Workspace.fs.find` + `readFile`, or drop the route.
4. **Skills R2 mount.** The R2-backed skill discovery pipeline was
   wired through `R2Mount`. `discoverSkills(workspace)` is no
   longer called at startup; the system prompt's
   `<available_skills>` will be empty. Reimplement: poll R2
   directly in the system-prompt builder, or rebuild a small
   "materialise into workspace" helper that walks the bucket and
   writes via `ws.fs.writeFile` before the first turn.
5. **git_clone disabled.** Wiring needs the dofs provider, which
   lives inside the Sandbox DO. Either add a passthrough RPC on
   Sandbox that exposes the provider (tricky — capnweb might
   choke on the `@platformatic/vfs` wrapper) or move git_clone
   into a method on the Sandbox DO that the agent invokes by RPC.
6. **`worker_deploy` / `worker_fetch` tools.** Dropped along with
   `worker-sandbox`. If the agent persona still needs WASM /
   Worker preview deploys, this needs a separate design.
7. **Agent-suite vitest-pool-workers failure.** Six test files
   fail at module evaluation. Need a real error location (set
   `VITE_DEBUG`, run with `--no-isolate`, or inspect the workerd
   logs) and probably a `deps.optimizer` or `external` entry for
   one of the new packages.

## Phase 3 (revised) — Drop the vendor tree, consume the published package

Single commit, mechanical. No new runtime behaviour; we're just
swapping the source of the same code.

### 3a — Add the npm dependency

- `apps/agent/package.json`:
  - `dependencies["@cloudflare/workspace"]`: `*` → `^0.0.0-alpha.3`.
  - Add `@platformatic/vfs`, `diff`, `isomorphic-git` to
    `dependencies` (currently transitive through the vendored
    git-tools; once that package retargets they need to be direct
    or git-tools needs to keep them as peers — see 3c).
  - Drop the `predeploy` script entirely. No more local wsd image
    build, no more `@cloudflare/workspace` build step — both come
    from npm / GHCR. `predeploy` becomes
    `npm run build --workspace=@app/frontend` (or move that into
    `deploy` and delete the hook).
- `packages/git-tools/package.json`:
  - Drop `@cloudflare/dofs` from `peerDependencies` and
    `devDependencies`.
  - Keep `@cloudflare/workspace` (it's now where
    `SQLiteWorkspaceProvider` lives).
  - Keep `@platformatic/vfs` only if we don't move clone over to
    the new `/git` subexport. Plan is to move it, so drop it.
- Root `package.json`:
  - Remove `packages/dofs`, `packages/workspace-rpc`,
    `packages/workspace`, `packages/wsd`, `packages/wsd-linux-x64`
    from `workspaces`.
  - Optionally pin the alpha tag in `overrides` so transitive
    consumers can't drift:
    `"overrides": { "@cloudflare/workspace": "0.0.0-alpha.3" }`.

### 3b — Delete the vendored sources

```bash
git rm -r packages/dofs packages/workspace-rpc packages/workspace \
          packages/wsd packages/wsd-linux-x64
```

Also clear out the uncommitted leftovers in the working tree:
`packages/wsd-linux-x64/Dockerfile.build`,
`packages/wsd-linux-x64/warp-ca.crt`, the modified
`packages/wsd/package.json` (`fuse-native` optional patch — no
longer needed; the published binary doesn't dlopen libfuse on
non-FUSE hosts when `FUSE_MOUNT=auto` picks the shim).

### 3c — Retarget `packages/git-tools`

- `src/tools/vfs.ts`: delete. The `/git` subexport on the published
  package owns this glue.
- `src/tools/clone.ts`: rewrite against
  `@cloudflare/workspace/git`. Mirror
  `examples/think/src/tools/git/clone.ts` from the upstream repo:
  takes a `Workspace` (not a `SQLiteWorkspaceProvider`), builds the
  client once via `createGitClient({ ws, cache })`, calls
  `git.clone({ url, dir, ref, depth, singleBranch: true })`.
  - The shared isogit cache (`cache?: Record<string, unknown>`)
    matters for any future `diff` / `walk` tool; thread it through
    even though `clone` is the only consumer today.
- `src/index.ts`: update the exported `createGitCloneTool`
  signature — `{ ws: Workspace }` instead of
  `{ provider: SQLiteWorkspaceProvider }`.
- `apps/agent/src/agent.ts`: re-enable `git_clone` in `buildTools`,
  passing the cached `WorkspaceStub` from `getWorkspace()`. The
  upstream `WorkspaceLike` is duck-typed on `.provider()`, but the
  stub *does not* implement `.provider()` directly — only the
  Workspace in the Sandbox DO does. **Open question:** does
  `createGitClient` accept a `WorkspaceStub`, or do we need a
  passthrough RPC method on `Sandbox` (e.g.
  `Sandbox.gitClone(opts)`) that builds the client on the DO side?
  Inspect `createGitClient`'s use of `ws.provider()` to confirm.
  Likely answer: git has to run on the Sandbox DO, so add
  `Sandbox.gitClone(opts)` and let the agent invoke it by RPC.

### 3d — Container image

- `apps/agent/Dockerfile`:
  - `FROM ghcr.io/cloudflare/workspace-wsd-linux-x64:0.0.0-alpha.3 AS wsd`
    (replaces the local `cloudflare/workspace-wsd-linux-x64:0.1.1`).
  - `ENV FUSE_MOUNT=auto` (replaces `ENV FUSE_SHIM=1`).
  - Keep the project toolchain layers (zig, go, esbuild,
    wrangler) — that's hackspace-specific.
- `apps/agent/wrangler.jsonc`: no schema change. `image_build_context`
  can drop to `.` (or be removed; the FROM is now an external image
  pull and the build only needs the toolchain layer context).

### 3e — Verify (actual results)

- `npm install`: ✅ (after cleaning the npm metadata cache; the
  proxy had a stale view of `tinyglobby` / `@oxc-project/types`).
- Root `overrides.rolldown = "1.0.2"` added because 1.0.3 pins
  `@oxc-project/types@=0.133.0` which isn't published yet.
- `apps/agent` typecheck: ✅
- `apps/agent` agent-suite tsconfig typecheck: ✅
- `packages/git-tools` typecheck: ✅
- `apps/agent` unit tests (`npx vitest run`): ✅ 227/227 pass
- `apps/agent` agent-suite (`vitest-pool-workers`): ❌ still 6 files
  fail with `SyntaxError: Invalid or unexpected token`. Identical
  symptom to pre-swap state; regression #7 below stays open.

### 3f — API surface notes for future readers

While porting, the published alpha.3 surface differed from the
vendored snapshot in two places that bit us:

1. **`CloudflareContainerBackend` constructor.** No longer takes
   `{ container, egress }`. New shape is
   `{ container: () => ContainerHostHolder, workspace: WorkspaceRef }`.
   `ContainerHostHolder` is satisfied by the DO itself when it's
   wrapped in `withWorkspaceContainer(...)`; the egress fetcher is
   wired up by that mixin via `ctx.exports.WorkspaceProxy` so
   `WorkspaceProxy` must still be re-exported from the worker
   entrypoint. Pattern lifted verbatim from
   `examples/wsd-container/src/index.ts`.
2. **`GitClient.clone` returns `void`.** No `head` field. Upstream's
   `examples/think` tool drops `head` from the tool result, so we
   match that — the model never used the field meaningfully
   anyway, but it's worth knowing if a caller did.

## Phase 4 — Tests, docs, cleanup

### Done

- **Sandbox lifecycle simplified.** Original bug report: agents
  hit `Workspace not connected — await ready() first` after a
  container restart — the warm pool was handing out stubs whose
  underlying capnweb session had been torn down. Two-step fix:
  1. `getState()` now returns `{ status: "healthy" | "stopped",
     lastChange }` projected directly from `ctx.container.running`,
     matching the upstream `examples/wsd-container` shape. The
     pool's `isAssignmentUsable` check (`status === "healthy"`)
     now correctly rejects assignments whose container has died.
  2. Sandbox restructured to be a thin pass-through over
     `ctx.container.*` plus `Workspace.ready()`. Removed the
     `#connected` flag, `#tearDownWorkspace` dance, synthetic
     state machine, `renewActivityTimeout` no-op, and the
     agent-side `getState()` probe-before-cached-stub-reuse. The
     Workspace's own `connect()` retry handles transient session
     drops; we don't need to drive it from outside. ~100 LOC
     lighter and structurally identical to the upstream example.
- **`wrangler dev` smoke (worker side).** Booted the worker with
  the `containers` array commented out (first pass). All DO
  classes register and migrate cleanly, App creates rooms
  (`POST /api/app/rooms` → 201), R2 binding wires through. `GET
  /api/threads/<id>/tar` returns a 3.5 KB POSIX ustar with the
  expected `<id>/metadata.json` + `<id>/messages.json` entries
  (cold-sandbox fallback). Pinned `@cloudflare/worker-bundler@^0.2.0`
  as a direct dependency — `agents@0.14` does a dynamic
  `import("@cloudflare/worker-bundler")` from its skill-runner path
  that esbuild resolves at bundle time, so the package has to be on
  disk or wrangler refuses to start with a 'Could not resolve'
  error.
- **`wrangler dev` smoke (container path).** Dockerfile now
  conditionally installs CA bundles dropped at `apps/agent/ca/*.crt`
  before any `curl`/`npm` step (`COPY apps/agent/ca/ /opt/agent-ca/`
  + a conditional `update-ca-certificates`). Hosts behind
  Cloudflare WARP (or any other decrypting TLS proxy) put their
  root bundle at `apps/agent/ca/warp-ca.crt`; gitignored so it
  stays host-specific. `apps/agent/ca/` itself is committed with a
  `.keep` so the `COPY` always succeeds. Verified end-to-end: image
  builds, three Sandbox containers boot, `/tar` round-trips a live
  `WorkspaceStub` through capnweb (empty `vfs-index.json` on the
  cold workspace, but the round-trip itself is the proof). One
  benign workerd warning: `WorkspaceFsError: no such path:
  /workspace` on the first `find` call against a fresh VFS — the
  /tar route already catches it and falls through to an empty
  index.
- **READMEs.** Root, `apps/agent`, and `packages/git-tools`
  rewritten end-to-end for the published `@cloudflare/workspace`
  shape: dropped references to the vendored package paths, the
  `predeploy` workspace-build / sandbox CA-sync steps, and the
  retired `gitCommit`/`gitPush`/`worker_deploy` families.
  Documented the new `apps/agent/ca/` opt-in for WARP / corporate
  TLS proxies, the GHCR pin, and the lockstep upgrade workflow.
  `apps/agent/README.md` got an updated architecture diagram
  (Agent DO + Sandbox DO + wsd container) and a 'Known gaps'
  section for regressions #1 / inflight-exec-recovery.
- **Regression #3 — `/tar` debug export.** Ported `debug-tar.ts`
  to the new `WorkspaceStub.fs` surface (`find` + `stat` +
  `readFile`). One round-trip per file instead of the old
  `workspace.vfs.snapshot()` single-stream walk, but the output
  shape is identical (POSIX ustar, `<agentName>/{metadata,messages,
  vfs-index}.json` + `<agentName>/vfs/<path>` entries). The route
  no longer 501s; missing-sandbox callers still get a usable
  tarball with just metadata + messages.
- **Cloudflare dep bumps.** `@cloudflare/ai-chat` 0.7→20.8,
  `@cloudflare/think` 0.7→0.8, `agents` 0.13→0.14,
  `@cloudflare/workers-types` pin bumped to 4.20260606. All
  caret-respected; transitive `node_modules/agents` is now a single
  copy at 0.14.3.
- **Regression #7 — agent-suite vitest-pool-workers
  `SyntaxError`.** Root-caused: vite's SSR transform leaves
  `@callable()` decorators in place, oxc/rolldown's default
  transformer doesn't implement TC39 stage-3 decorators yet
  ([oxc#9170]), so workerd's V8 rejects the module at load time
  with an opaque syntax error (no line/column — attributes to
  whichever file first awaits an import of the offending module).
  Diagnostic path: patched `node_modules/vitest/.../module-evaluator.js`
  to re-parse failed source with Acorn before throwing; that gave a
  real `loc` pointing at `@(0,__vite_ssr_import_N__.callable)()`.
  Fix: add `@rolldown/plugin-babel` + `@babel/plugin-proposal-decorators`
  (`version: "2023-11"`) to the agent-suite vitest config. Same
  pattern as `cloudflare/agents/packages/agents/src/vite.ts`,
  inlined locally so we don't pull in the rest of that plugin's
  surface (skills import rewrite, turndown stub).
- **Regression #4 — skills R2 mount.** `discoverSkills` rewritten
  to walk the R2 binding directly instead of going through the old
  `R2Mount`. Wired into both `onStart` (background prime) and
  `beforeTurn` (synchronous fallback when `_skills` is empty so a
  cold turn from a fresh DO still gets the prompt block populated).
- **Compat date.** Test wrangler bumped from 2026-01-28 to
  2026-06-06 so the test runtime matches production capability
  surface. Also enables
  [`enable_top_level_await_in_require`](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#disable-top-level-await-in-require)
  defensively — vite's SSR transform emits `await __vite_ssr_import__(...)`
  at module top level inside the `require()`d wrapper, and the
  default-on `disable_top_level_await_in_require` flag rejects
  that. Not the actual cause of the original failure (decorators
  were), but the same wrapper would trip it eventually, so leave
  it set.
- **Dropped `worker_deploy` / `worker_fetch` references.** The
  tools themselves were removed in Phase 2; this pass cleaned up
  stale references in the system prompt, agent tool tests,
  README, and the `cloudflare-workers` / `sandbox-sdk` /
  `capabilities-overview` skills.

### Remaining

- **Regression #1 — streaming exec.** `WorkspaceShellStub.exec`
  returns `{ stdout, stderr, exitCode }` once the command exits;
  there's no incremental stream across the DO RPC boundary.
  Upstream's underlying `WorkspaceShell.exec` does return a
  `ReadableStream<WorkspaceExecEvent>`, but exposing it across
  capnweb needs a framed / length-prefixed transport that
  alpha.3 doesn't ship. Track upstream; revisit on the next
  workspace package bump.
- **Pick up `@cloudflare/workspace/observe/cloudflare`.** Shipped
  after alpha.3 in upstream commit `6fe9774`. When we bump past
  alpha.3 we should pass `observer: createCloudflareObserver({ tracing })`
  to the Workspace constructor in `sandbox.ts` so workspace ops
  show up alongside the runtime's automatic fetch + binding spans
  in the Observability dashboard. Mirrors the upstream example.

## Reproduce / verify (post-Phase 3)

```bash
git checkout port-workspace-next
npm install
cd apps/agent && npx tsc --noEmit && npx vitest run
```
