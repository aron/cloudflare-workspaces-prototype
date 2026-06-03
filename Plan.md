# Plan: Replace `packages/workspace` with the `next` branch version

## Status

Phase 1: ✅ Done.
Phase 2: 🟡 Build-green. Runtime-untested. Known regressions listed.
Phase 3+: ⏳ Pending.

Work landed in branch `port-workspace-next` (off `hackspace`). Five
commits so far, each rebaseable on its own.

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

## Phase 3 — Container / wsd plumbing

Pending. Wsd binary builds locally via `npm run build:bin
--workspace @cloudflare/workspace-wsd` once
`@cloudflare/workspace-wsd-linux-x64`'s `bin/wsd` is staged. The
`predeploy` hook on `@app/agent` calls `npm run
build --workspace=@cloudflare/workspace-wsd` (not `build:bin`); for
a real deploy we'd want `npm run build:docker --workspace
@cloudflare/workspace-wsd` so the
`cloudflare/workspace-wsd-linux-x64` image referenced from the
agent Dockerfile actually exists locally. **Action item:** update
`apps/agent/package.json`'s `predeploy` to run
`build:docker --workspace @cloudflare/workspace-wsd` once we're
confident the build pipeline works on the deploy machine.

`TestBackend` path for local dev (run wsd as a host process,
point the agent at it) not yet wired.

## Phase 4 — Tests, docs, cleanup

- Diagnose and fix the agent-suite vitest-pool-workers regression.
- End-to-end smoke test: `wrangler dev`, create an agent, run a
  read/write/exec sequence against the container.
- Update `apps/agent/README.md` and the root README for the wsd-
  based design.
- Delete `apps/agent/sandbox/` references in docs/markdown.

## Reproduce / verify

```bash
git checkout port-workspace-next
npm install
npm run build --workspace=@cloudflare/dofs \
              --workspace=@cloudflare/workspace-rpc \
              --workspace=@cloudflare/workspace \
              --workspace=@cloudflare/workspace-wsd
cd apps/agent && npx tsc --noEmit && npx vitest run
```
