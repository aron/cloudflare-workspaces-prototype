created: 2026-05-29
last updated: 2026-05-29

# Implementation Plan: `wsd` CLI Scaffold

## Overview

Scaffold a `wsd` command-line tool inside the existing `@cloudflare/workspace` package. The first version will be intentionally small: when started, it reads `PORT` from the environment, starts an HTTP server on that port, and exposes a readiness endpoint that an integration test can probe. The package should expose the command for npm/npx usage and add a `pkg`-based build path for standalone Ubuntu and macOS binaries.

## Source Notes

- The requested `docs` branch was not present on the remote; the available documentation branch is `design`, which contains the CLI/server design docs.
- `docs/07_injected_service.md` describes the intended workspace-server process: it runs in the sandbox container, listens on `PORT` with default `4567`, exposes health over HTTP, and will eventually host RPC/FUSE responsibilities.
- `packages/workspace` is the existing `@cloudflare/workspace` package and already builds Node-oriented container server artifacts into `dist/`.

## Architecture Decisions

- Add the CLI under `packages/workspace/src/cli/wsd.ts` so it ships as part of `@cloudflare/workspace` rather than as a separate package.
- Expose the npm command with `"bin": { "wsd": "./dist/cli/wsd.cjs" }` in `packages/workspace/package.json`, enabling local installs and npx workflows such as `npx -p @cloudflare/workspace wsd`.
- Use `pkg` to produce standalone binaries from the built CommonJS CLI entrypoint. Initial targets: Ubuntu/Linux x64, macOS x64, and macOS arm64.
- Keep the initial server dependency-free, using Node's `http` module. Return `200 OK` from `GET /healthz` as the readiness contract, matching the docs.
- Use `node:test` for the integration test. The test should spawn the built CLI as a child process on a random free localhost port, poll `GET /healthz`, and assert a `200` response.

## Task List

### Phase 1: CLI Foundation

## Task 1: Add the minimal `wsd` server entrypoint

**Description:** Create the CLI source file that starts an HTTP server using `process.env.PORT`, defaults to `4567` if unset, and serves a health response. Add signal handling so the process exits cleanly when tests or users terminate it.

**Acceptance criteria:**
- [ ] `packages/workspace/src/cli/wsd.ts` exists and uses only Node standard library APIs.
- [ ] `PORT=0` or an explicit port starts a listening HTTP server.
- [ ] `GET /healthz` returns HTTP `200` with a simple body such as `ok`.
- [ ] Missing `PORT` uses `4567`.

**Verification:**
- [ ] Manual check: `PORT=4567 node dist/cli/wsd.cjs`, then `curl http://127.0.0.1:4567/healthz` returns `200`.

**Dependencies:** None

**Files likely touched:**
- `packages/workspace/src/cli/wsd.ts`

**Estimated scope:** Small: 1 file

## Task 2: Wire the CLI into the package build

**Description:** Update the workspace package build so the CLI is compiled into `dist/cli/wsd.cjs` and exposed as the `wsd` npm binary. Ensure published package files include the CLI artifact.

**Acceptance criteria:**
- [ ] `packages/workspace/scripts/build.mjs` emits `dist/cli/wsd.cjs`.
- [ ] `packages/workspace/package.json` includes `"bin": { "wsd": "./dist/cli/wsd.cjs" }`.
- [ ] The emitted CLI file has a usable shebang.
- [ ] `npm run build --workspace=@cloudflare/workspace` succeeds.

**Verification:**
- [ ] Build succeeds: `npm run build --workspace=@cloudflare/workspace`.
- [ ] Manual check: `./packages/workspace/dist/cli/wsd.cjs` starts the server when `PORT` is set.

**Dependencies:** Task 1

**Files likely touched:**
- `packages/workspace/scripts/build.mjs`
- `packages/workspace/package.json`

**Estimated scope:** Small: 2 files

### Checkpoint: npm CLI scaffold

- [ ] Build passes for `@cloudflare/workspace`.
- [ ] `wsd` can be executed from the built package output.
- [ ] `/healthz` responds with `200`.

### Phase 2: Integration Test

## Task 3: Add a `node:test` integration test for the CLI server

**Description:** Add an integration test that builds or uses the built CLI artifact, finds an available localhost port, starts `wsd` with that `PORT`, polls the health endpoint until it responds, and tears the child process down after the assertion.

**Acceptance criteria:**
- [ ] Test uses `node:test` and Node standard assertions.
- [ ] Test spawns the built CLI on the host with `PORT` set to a test port.
- [ ] Test verifies `GET /healthz` returns `200`.
- [ ] Test reliably cleans up the child process on success and failure.

**Verification:**
- [ ] Tests pass: `npm test --workspace=@cloudflare/workspace`.

**Dependencies:** Tasks 1-2

**Files likely touched:**
- `packages/workspace/tests/wsd.test.ts`
- `packages/workspace/package.json` if the test script needs to include TypeScript test files consistently

**Estimated scope:** Medium: 2 files

### Checkpoint: tested CLI scaffold

- [ ] `npm run build --workspace=@cloudflare/workspace` passes.
- [ ] `npm test --workspace=@cloudflare/workspace` passes.
- [ ] The test proves the server starts on a host port and exposes HTTP readiness.

### Phase 3: Standalone Binary Distribution

## Task 4: Add `pkg` binary build scripts

**Description:** Add `pkg` as a development dependency and scripts that package `dist/cli/wsd.cjs` into standalone binaries for Ubuntu/Linux and macOS. Keep binary output under a predictable distribution directory that is included in package files if desired.

**Acceptance criteria:**
- [ ] `pkg` is added to `packages/workspace` dev dependencies or root tooling, following the monorepo's dependency pattern.
- [ ] A script such as `build:bin` builds the CLI first and then invokes `pkg`.
- [ ] Binary targets include Linux x64, macOS x64, and macOS arm64.
- [ ] Output filenames clearly identify platform and architecture, e.g. `wsd-linux-x64`, `wsd-macos-x64`, and `wsd-macos-arm64`.

**Verification:**
- [ ] Build succeeds: `npm run build:bin --workspace=@cloudflare/workspace`.
- [ ] Manual check on the current host: run the matching generated `wsd-*` binary with `PORT` set and verify `/healthz` returns `200`.

**Dependencies:** Tasks 1-2

**Files likely touched:**
- `packages/workspace/package.json`
- `packages/workspace/scripts/build-bin.mjs` or equivalent
- `package-lock.json`

**Estimated scope:** Medium: 2-3 files

## Task 5: Document initial CLI usage

**Description:** Add a short README section describing how to run `wsd` via npx, how to run a standalone binary, and what the initial health endpoint does. Clarify that RPC/FUSE behavior is future work and this scaffold only starts the HTTP server.

**Acceptance criteria:**
- [ ] README documents `PORT=4567 npx -p @cloudflare/workspace wsd`.
- [ ] README documents standalone binary invocation.
- [ ] README documents `GET /healthz` as the initial readiness endpoint.
- [ ] README explicitly marks this as a scaffold, not the full injected service.

**Verification:**
- [ ] Documentation review confirms commands match package scripts and output paths.

**Dependencies:** Tasks 2 and 4

**Files likely touched:**
- `packages/workspace/README.md`
- Optionally `docs/07_injected_service.md` if the docs should reference the new `wsd` command

**Estimated scope:** Small: 1-2 files

### Checkpoint: distributable scaffold

- [ ] npm bin entry works from the package.
- [ ] Standalone binaries build for initial target platforms.
- [ ] Integration test passes.
- [ ] README reflects the current scaffold behavior.

## Open Questions

- Should `npx @cloudflare/workspace` directly invoke `wsd`, or is `npx -p @cloudflare/workspace wsd` acceptable for the scoped package? This affects how the `bin` field should be structured.
- Should the `pkg` binary artifacts be included in the npm package `files` list immediately, or produced as release artifacts only?
- Should `/` also return a `200` response, or should `/healthz` be the only supported endpoint until the RPC surface is added?
- Should the existing `container-sandbox` server eventually be renamed/reused as `wsd`, or should `wsd` remain a thin launcher around that implementation?
