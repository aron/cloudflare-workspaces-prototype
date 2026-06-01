# Audit: docs/10_project_layout.md

Scope: spec-vs-implementation audit of the project layout. Code is
authoritative. Sources traced:

- `package.json` (root), `biome.json`
- `packages/workspace/{package.json,tsconfig*.json,src/,test-harness/}`
- `packages/workspace-fs/{package.json,src/}`
- `packages/workspace-rpc/{package.json,src/}`
- `packages/wsd/{package.json,scripts/,src/}`
- `examples/wsd-container/`

The doc carries the standard "intended design has diverged" banner.
Even so, the layout it describes is far from `main`: three of the four
packages it lists do not exist, and the one that does has a different
internal tree, build output, and test layout.

## Review

### Correct (verified against code)

- **Monorepo with `packages/` and `docs/`.** `package.json` declares
  `"workspaces": ["packages/*", "examples/*"]`. `docs/` is the
  documentation set this audit lives in.
- **`@cloudflare/workspace` lives in `packages/workspace`.** Confirmed
  by `packages/workspace/package.json` (`"name": "@cloudflare/workspace"`).
- **Tests live next to source.** `packages/workspace-fs/src/fs/` has
  `readFile.ts`/`readFile.test.ts`, `stat.ts`/`stat.test.ts`, etc.
  `packages/workspace/src/` has `shell.ts`/`shell.test.ts` and
  `workspace.ts`/`workspace.test.ts`. The doc's claim (lines 48–49,
  87–88) holds.
- **vitest for unit tests.** Every package except `wsd` declares
  `vitest` in devDeps and `"test": "vitest run"` in scripts. `wsd`
  uses `node --experimental-strip-types --test` instead — a wrinkle
  the doc does not mention but is consistent with its native-binary
  nature.
- **TypeScript per package.** Every package has its own
  `tsconfig.json` and most also have `tsconfig.build.json`.
- **Biome for lint+format, no ESLint, no Prettier.** `biome.json` at
  the root; root `package.json` exposes `format` /
  `format:check`. No `.eslintrc*` or `.prettierrc*` anywhere.
- **esbuild used for a bundled binary.** `esbuild` is a root
  devDependency, used by `packages/wsd/scripts/sea/bundle.mjs` to
  produce a single-file bundle of `wsd`.

### Drift — `needs-decision` (no code today, doc target still valuable)

- **`packages/fs-tools` does not exist.** Doc §"`packages/fs-tools`"
  (lines 63–73) describes an AI SDK tools package (`read`, `write`,
  `edit`, `grep`, `exec`, `FileStore`). `ls packages/` shows only
  `workspace`, `workspace-fs`, `workspace-rpc`, `wsd`. There is no
  AI-SDK-shaped tool code anywhere in the repo (a `grep` of the
  workspace turns up only the filesystem-level `fs/grep.ts` in
  `workspace-fs`, which is the VFS primitive, not an agent tool).
  Decision needed: is `fs-tools` still planned, or has the design
  moved (e.g. tools layered on top of `WorkspaceProxy` in
  user-land)? Same question applies to the cross-reference in
  [09 Tool Interface](../09_tool_interface.md).
- **`packages/git-tools` does not exist.** Doc §"`packages/git-tools`"
  (lines 75–78). No git-tool code anywhere in `packages/`. Either
  drop the section or carry it forward with a status banner.
- **`packages/internal` does not exist.** Doc §"`packages/internal`"
  (lines 80–83). What the doc calls "cross-package shared types and
  helpers" is in fact split between `@cloudflare/workspace-fs`
  (re-exported types like `DurableObjectStorageLike`) and
  `@cloudflare/workspace-rpc` (`ContainerRPC` interface, wire
  types). Decision needed: keep a published-but-internal split, or
  re-introduce an `internal` package?

### Drift — `doc-fix` (code wins, doc still useful)

- **Package list is wrong.** Doc tree at lines 14–23 lists
  `workspace`, `fs-tools`, `git-tools`, `internal`. Real tree:
  `workspace`, `workspace-fs`, `workspace-rpc`, `wsd`. The two
  packages the doc misses entirely (`workspace-fs`, `workspace-rpc`)
  are the ones doing most of the heavy lifting, and `wsd` — the
  daemon that became the injected service — is also absent. Update
  the tree and add per-package sections (or at least cross-refs to
  docs 04 and 08 which describe those packages' surfaces).
- **`packages/workspace/src/` tree is largely fiction.** Doc lines
  29–46 claim `vfs.ts`, `path.ts`, `serialize.ts`, `pull-assembly.ts`,
  `container-connection.ts`, `container-startup.ts`, `shared/`,
  `mounts/`, `container-sandbox/`. None of those exist. Real tree
  (`ls packages/workspace/src/`):
  - `index.ts`, `workspace.ts` — public entrypoint + facade (these
    two the doc gets right)
  - `shell.ts`, `shell.test.ts` — Shell facade (doc 05)
  - `backend.ts`, `backends/{cloudflare-container,test}.ts` — pluggable
    backends (the "DO-side facade" piece)
  - `proxy.ts`, `proxy-stub.ts`, `stub.ts` — `WorkspaceProxy`
  - `test-harness/`, `test-harness-worker.ts` — test wiring
  The VFS, path canonicalization, sync/pull, and wire types all
  live in `workspace-fs` and `workspace-rpc` now, not under
  `packages/workspace/src/`. The doc needs a near-total rewrite of
  this section.
- **Build outputs are wrong.** Doc §"Build outputs" (lines 53–61)
  promises `dist/index.js`, `dist/ws.js`, `dist/shared.js`. Real
  output:
  - `@cloudflare/workspace`: dual ESM + CJS via
    `tsc -p tsconfig.build.json && tsc -p tsconfig.cjs.json`, with
    a single `.` export pointing at `dist/cjs/index.js` (no `ws.js`,
    no `shared.js`). The "shared" entrypoint the doc mentions does
    not exist; `ContainerRPC` and wire types live in
    `@cloudflare/workspace-rpc` instead.
  - `@cloudflare/workspace-fs`: `.` and `./testing` exports
    (`dist/index.js`, `dist/testing.js`).
  - `@cloudflare/workspace-rpc`: `.`, `./server`, `./client`,
    `./driver` exports.
  - `@cloudflare/workspace-wsd`: a `dist/cli/wsd.cjs` bin, built by
    `scripts/build.mjs`, optionally bundled into a SEA via
    `scripts/build-bin.mjs` + `scripts/sea/bundle.mjs`.
  The injected `ws.js` script described in
  [07 Injected Service](../07_injected_service.md) is now the `wsd`
  binary (separate package). Doc 10 must reflect that.
- **`examples/` is at the repo root, not under `packages/workspace/`.**
  Doc line 43 puts `examples/` inside `packages/workspace/`; real
  layout is `examples/wsd-container/` at the repo root, and
  `package.json` includes `"examples/*"` in the workspaces glob.
- **`scripts/` directory is at the repo root too.** Doc line 44 puts
  a `scripts/` directory inside `packages/workspace/` for "Build
  pipeline (esbuild + tsc)". `packages/workspace/` has no `scripts/`
  — its `build` script is just two `tsc` invocations. Build
  scripts that do exist live in `packages/wsd/scripts/` (esbuild +
  Node SEA) and in the repo-root `script/` directory (test
  harnesses, soak runners).
- **Integration tests don't live in `tests/` directories.** Doc lines
  50–51 and 89–92 say "cross-cutting integration tests… live in
  `tests/` at the package root". No `tests/` directory exists in
  any package. The integration / harness tests live in
  `packages/workspace/test-harness/` (`end-to-end.test.ts`,
  `load.bench.ts`, `shell.test.ts`, plus `run-harness.sh` and a
  bespoke vitest config `vitest.config.harness.ts`). Doc should
  document the `test-harness/` convention, not invent a `tests/`
  one.
- **Biome lint claim is misleading.** Doc lines 99–101 say "Linting
  and formatting are handled by Biome (`biome check`, `biome
  format`)". `biome.json` has `"linter": { "enabled": false }` and
  the root `package.json` only exposes `format` / `format:check`
  scripts — there is no `biome check` (lint) wired up. The repo
  AGENTS.md instructs running `npx biome check .` after changes,
  but with the linter disabled this is effectively a formatter
  check. Either turn the linter on (a `code-fix`) or soften the doc.
- **No shared root `tsconfig.json` exists.** Doc lines 97–98 say
  every package has a `tsconfig.json` "extending the workspace root
  config". There is no root `tsconfig.json`; each package's
  `tsconfig.json` is standalone (only the per-package
  `tsconfig.build.json` extends `./tsconfig.json`). Either add a
  shared root config (a small `code-fix`) or correct the doc.

### Drift — `code-fix` (doc target is the right move)

- **Linting really should be on.** The repo agent guidelines tell
  contributors to run `npx biome check .`, but `biome.json` disables
  the linter, so the command is a no-op for lint rules. The doc's
  expectation that Biome covers both lint and format is a sensible
  target — flipping `linter.enabled` to `true` (and fixing or
  scoping the resulting findings) would close the gap. Worth a
  follow-up issue rather than rewriting the doc.

### Notes

- The doc's overall framing ("the package lives in
  `packages/workspace`, agent tooling alongside") still describes
  the intended shape, but the agent-tooling story (`fs-tools`,
  `git-tools`) is currently empty. If the project has settled on
  "agents call `WorkspaceProxy` directly, no tools package", doc 10
  and doc 09 should both be rewritten to say so. If the tools
  package is still on the roadmap, mark both sections "Planned, not
  shipped" with a tracking link.
- `packages/wsd` deserves first-class treatment in this doc: it is
  the `ws.js` of doc 10's "Build outputs" section, but it is now a
  full sibling package with its own CLI binary, FUSE driver, exec
  runner, and SEA build pipeline. Cross-link to doc 07.
- `packages/workspace-fs` and `packages/workspace-rpc` carry most of
  the surface area docs 02–04 and 08 describe. Either give them
  per-package sections here, or explicitly defer to those docs.
- `examples/wsd-container/` at the repo root is an inversion of what
  the doc shows; if the convention is "examples live at the repo
  root, one per published shape", document that.
