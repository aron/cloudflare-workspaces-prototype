# Plan: Replace `packages/workspace` with the `next` branch version

## Findings

The `next` branch is **not a drop-in replacement** for the current `packages/workspace`. It's an entire restructured workspace monorepo (`@cloudflare/workspace` as a private root with `packages/dofs`, `packages/rpc`, `packages/workspace`, `packages/wsd`, `examples/*`).

**Key differences:**

| | Current (`hackspace`) | `next` |
|---|---|---|
| Package layout | One package, self-contained | Split across `workspace` + `dofs` + `workspace-rpc` (+ `wsd` daemon) |
| Public API | `Workspace`, `Vfs`, mounts (`R2Bucket`, `GitHubRepo`), `/git` subpath (`commitWorkingTree`, `createVfsFs`, `ForkRegistry`, `ArtifactsBinding`), `/worker-sandbox` (`loadWorker`, `LoadedWorker`), `/shared`, `/container-sandbox` | `Workspace`, `WorkspaceProxy`, `WorkspaceStub`/`WorkspaceShellStub`/`WorkspaceFilesystemStub`/`WorkspaceExecHandleStub`, `WorkspaceShell`, backends (`CloudflareContainerBackend`, `TestBackend`) |
| Sync model | In-DO SQLite VFS, FUSE-mounted in `@cloudflare/sandbox` container | DO holds a `BackendHandle` + `SyncRPC` connection to an external `wsd` daemon running inside a plain Container DO |
| Build | Single `tsc` to `dist/` with multiple `exports` | `tsc` ESM + CJS dual build, single entry |

**Consumers in this repo that depend on removed surface:**

- `apps/agent/**` — imports `Vfs`, `Workspace`, mounts (`R2Bucket as R2Mount`, `EagerMount`, `MountFactory`, `Mount`, `MountEntry`), `loadWorker` / `LoadedWorker`, plus the `/git` helpers (`commitWorkingTree`, `createVfsFs`, `ForkRegistry`, `ForkRecord`, `ArtifactsBinding`)
- `packages/git-tools/package.json` — declares `@cloudflare/workspace` dep (uses the `/git` subpath)

The `next` branch ships `examples/think` which demonstrates the new patterns: workspace-backed fs tools (`src/tools/fs/stores/workspace.ts`), git clone over the new API (`src/tools/git/clone.ts`, `src/tools/git/vfs.ts`), `exec` (`src/tools/exec.ts`), and the agent/workflow wiring. **`examples/think` is the reference for the consumer rewrite.**

## Decisions (resolved)

1. **Scope:** swap the package source *and* fix the world to compile. ✅
2. **Sibling packages:** vendor `@cloudflare/dofs` and `@cloudflare/workspace-rpc` into this repo. ✅
3. **`wsd` daemon:** vendor `packages/wsd` here. It runs inside a Container DO as the wire endpoint for `CloudflareContainerBackend`. ✅
4. **Removed APIs — strategy:** **option (b) hard-cut.** Rewrite `apps/agent` and `packages/git-tools` against the new API in the same change. Use `examples/think` from `next` as the template. ✅
   - **Mounts:** reimplement (need to design — `next` has no mount concept; see Phase 2).
   - **`loadWorker` / worker-sandbox WASM loader:** drop.
   - **`git-tools`:** keep `git clone` only (via the pattern in `examples/think/src/tools/git/clone.ts`). Drop the other git tools for now.
   - **`apps/agent/sandbox/`:** drop the `@cloudflare/sandbox` SDK entirely. Use a plain Container DO. Keep the warm pool — `CloudflareContainerBackend` pulls a container instance from the pool.
5. **Dependency drift:** `next` pins `typescript@^6`, `vitest@^4`, `@cloudflare/vitest-pool-workers@^0.16`. **Lift the monorepo** to these versions.

## Proposed plan

### Phase 1 — Vendor the new packages

1. Create a branch off `hackspace` (e.g. `port-workspace-next`).
2. From `next`, copy:
   - `packages/workspace/` → replace existing `packages/workspace/` wholesale. Delete the old `examples/basic-exec` — no example for now.
   - `packages/dofs/` → new `packages/dofs/`.
   - `packages/rpc/` → new `packages/workspace-rpc/` (preserving the `@cloudflare/workspace-rpc` package name).
   - `packages/wsd/` → new `packages/wsd/`.
   - Relevant `biome.jsonc` config bits, but keep repo-root tooling untouched.
3. Update root `package.json` workspaces: add `packages/dofs`, `packages/workspace-rpc`, `packages/wsd`.
4. Lift repo deps to `next`'s versions: `typescript@^6`, `vitest@^4`, `@cloudflare/vitest-pool-workers@^0.16`. Sweep other packages for incompatibilities.
5. `npm install`, then build each new package in isolation: `npm run build --workspace=@cloudflare/dofs`, `…workspace-rpc`, `…workspace`, `…wsd`. Green here before touching consumers.
6. Run the new package test suites (`vitest run`, `vitest run --config vitest.config.proxy.ts`) and ensure they pass.

### Phase 2 — Rewrite `apps/agent` against the new API (option b)

Reference: `examples/think` on the `next` branch.

7. **Container / sandbox rewrite:**
   - Drop `@cloudflare/sandbox` dep from `apps/agent`.
   - Replace `apps/agent/sandbox/` with a plain Container DO that runs the vendored `wsd` binary as its entrypoint.
   - Preserve the warm pool. Adapt it so each pooled instance is a `wsd`-running container; `CloudflareContainerBackend` checks one out via the pool and hands its DO stub to `Workspace`.
8. **Workspace wiring:** in the agent, instantiate `Workspace` with `CloudflareContainerBackend` pointed at the warm-pool-acquired container. Mirror `examples/think`'s setup (workflow/agent boot sequence).
9. **fs tooling:** replace direct `Vfs` use with the `WorkspaceFilesystemStub` / `WorkspaceShellStub` pattern from `examples/think/src/tools/fs/stores/workspace.ts` and the `read`/`write`/`edit` tools.
10. **exec tooling:** port `examples/think/src/tools/exec.ts` to the agent's tool surface (uses `WorkspaceShell` / `WorkspaceExecHandleStub`).
11. **Mounts — reimplement:** the new package has no mount concept. Design needed before coding. Sketch:
    - Define a `Mount` interface in `apps/agent` (or a new small shim package) that materialises content into the workspace at a given path using `WorkspaceFilesystemStub` writes.
    - Port `R2Bucket` and `GitHubRepo` mount implementations on top of that. `GitHubRepo` can lean on the `git clone` flow from `examples/think/src/tools/git/clone.ts`.
    - Decide eager vs. lazy semantics — current consumers use both (`EagerMount`, `LazyMount`); pick what the agent actually needs and drop the rest.
    - **Open question to resolve during Phase 2:** is mount logic needed in the worker-side `Workspace`, or can it live entirely in agent-side code that just writes into the workspace before tools run? Prefer the latter.
12. **`loadWorker` / WASM tools:** delete all call sites. Identify any tools that relied on it and either drop them or replace with `exec` against the container.
13. **`git-tools`:**
    - Strip down to a single `clone` tool, modelled on `examples/think/src/tools/git/clone.ts` and `git/vfs.ts`.
    - Delete the rest (commit, fork registry, artifacts binding, etc.) for now. They can come back later if needed.
    - Update `packages/git-tools/package.json` dep accordingly.
14. Repo-wide build + typecheck must be green.

### Phase 3 — Container / wsd plumbing

15. Build `wsd` as part of the agent's container image (`Dockerfile` in `apps/agent/sandbox/` or successor). Use `examples/think/Dockerfile` from `next` as the template.
16. Confirm the SyncRPC websocket handshake works through the Container DO → `wsd` chain end-to-end. Add an integration smoke test in the agent.
17. Local dev: wire `TestBackend` so `apps/agent` can run against a locally-run `wsd` (no Container DO) for fast iteration. Env-driven backend selection.

### Phase 4 — Tests, docs, cleanup

18. Run agent unit + integration tests. Triage and fix breakage from API surface change.
19. Update `apps/agent` README and any architecture docs (`O11Y.md`, root `README.md`) to describe the new wsd-based design.
20. Delete dead code: old mount system, old `worker-sandbox`, deleted git tools, `@cloudflare/sandbox` references, old container sandbox dir.
21. Final repo-wide `npm run build && npm test`.

## Estimated risk / size

- **Phase 1** (vendor packages, lift toolchain, green in isolation): half a day, mostly mechanical, with some hours for the toolchain lift.
- **Phase 2** (agent rewrite — option b): multi-day. The agent leans heavily on mounts and the `/git` subpath; mounts in particular require design.
- **Phase 3** (wsd container + warm pool integration): 1–2 days depending on how cleanly the warm pool abstracts.
- **Phase 4** (cleanup + docs): half a day.

## Sequencing note

Phase 1 lands as one PR (vendored packages compile and test in isolation, repo otherwise untouched). Phase 2+3 land as a second PR (agent rewrite). This keeps the diff reviewable and gives a clean rollback point if the agent rewrite stalls.
