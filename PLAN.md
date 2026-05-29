created: 2026-05-29
last updated: 2026-05-29

# Implementation Plan: `wsd` CLI Scaffold

## Overview

Scaffold a `wsd` command-line tool from an otherwise blank branch by creating a new `@cloudflare/workspace` package. The first version will be intentionally small: when started, it reads `PORT` from the environment, starts an HTTP server on that port, returns `{}` from `/`, and exposes a `/health` readiness endpoint that an integration test can probe. The package should expose the command for npm/npx usage via `npx -p @cloudflare/workspace wsd` and add a `pkg`-based build path for standalone Ubuntu and macOS release artifacts.

## Source Notes

- The requested `docs` branch was not present on the remote; the available documentation branch is `design`, which contains the CLI/server design docs.
- `docs/07_injected_service.md` describes the intended workspace-server process: it runs in the sandbox container, listens on `PORT` with default `4567`, exposes health over HTTP, and will eventually host RPC/FUSE responsibilities.
- Implementation should start from a blank branch with no existing project files. Create only the minimal monorepo/package scaffold needed for the initial CLI, tests, npm package output, and release-artifact binary build.

## Architecture Decisions

- Create a minimal workspace layout from scratch with the package located at `packages/workspace`.
- Add the CLI under `packages/workspace/src/cli/wsd.ts` so it ships as part of `@cloudflare/workspace` rather than as a separate package.
- Expose the npm command with `"bin": { "wsd": "./dist/cli/wsd.cjs" }` in `packages/workspace/package.json`, enabling `npx -p @cloudflare/workspace wsd` for now.
- Use `pkg` to produce standalone binaries from the built CommonJS CLI entrypoint. Initial targets: Ubuntu/Linux x64, macOS x64, and macOS arm64. Treat these binaries as release artifacts only, not files included in the npm package.
- Keep the initial server dependency-free, using Node's `http` module. Return `200 OK` from `GET /health` as the readiness contract and return an empty JSON object from `GET /`.
- Use `node:test` for the integration test. The test should spawn the built CLI as a child process on a random free localhost port, poll `GET /health`, and assert a `200` response.

## Task List

### Phase 1: CLI Foundation

## Task 1: Add the minimal `wsd` server entrypoint

**Description:** Create the CLI source file that starts an HTTP server using `process.env.PORT`, defaults to `4567` if unset, and serves a health response. Add signal handling so the process exits cleanly when tests or users terminate it.

**Acceptance criteria:**
- [ ] `packages/workspace/src/cli/wsd.ts` exists and uses only Node standard library APIs.
- [ ] `PORT=0` or an explicit port starts a listening HTTP server.
- [ ] `GET /health` returns HTTP `200` with a simple body such as `ok`.
- [ ] `GET /` returns HTTP `200` with `{}` as JSON.
- [ ] Missing `PORT` uses `4567`.

**Verification:**
- [ ] Manual check: `PORT=4567 node dist/cli/wsd.cjs`, then `curl http://127.0.0.1:4567/health` returns `200`.
- [ ] Manual check: `curl http://127.0.0.1:4567/` returns `{}`.

**Dependencies:** None

**Files likely touched:**
- `packages/workspace/src/cli/wsd.ts`

**Estimated scope:** Small: 1 file

## Task 2: Wire the CLI into the package build

**Description:** Create the minimal workspace package metadata and build setup so the CLI is compiled into `dist/cli/wsd.cjs` and exposed as the `wsd` npm binary. Ensure the npm package includes the CLI artifact.

**Acceptance criteria:**
- [ ] Root package/workspace files are created for the blank branch.
- [ ] `packages/workspace/scripts/build.mjs` or an equivalent build command emits `dist/cli/wsd.cjs`.
- [ ] `packages/workspace/package.json` includes `"bin": { "wsd": "./dist/cli/wsd.cjs" }`.
- [ ] The emitted CLI file has a usable shebang.
- [ ] `npm run build --workspace=@cloudflare/workspace` succeeds.

**Verification:**
- [ ] Build succeeds: `npm run build --workspace=@cloudflare/workspace`.
- [ ] Manual check: `./packages/workspace/dist/cli/wsd.cjs` starts the server when `PORT` is set.

**Dependencies:** Task 1

**Files likely touched:**
- `package.json`
- `packages/workspace/package.json`
- `packages/workspace/scripts/build.mjs` or equivalent
- `tsconfig.json` files as needed

**Estimated scope:** Medium: 3-5 files

### Checkpoint: npm CLI scaffold

- [ ] Build passes for `@cloudflare/workspace`.
- [ ] `wsd` can be executed from the built package output.
- [ ] `/health` responds with `200`.
- [ ] `/` responds with `{}`.

### Phase 2: Integration Test

## Task 3: Add a `node:test` integration test for the CLI server

**Description:** Add an integration test that builds or uses the built CLI artifact, finds an available localhost port, starts `wsd` with that `PORT`, polls the health endpoint until it responds, and tears the child process down after the assertion.

**Acceptance criteria:**
- [ ] Test uses `node:test` and Node standard assertions.
- [ ] Test spawns the built CLI on the host with `PORT` set to a test port.
- [ ] Test verifies `GET /health` returns `200`.
- [ ] Test verifies `GET /` returns HTTP `200` with an empty JSON object.
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

**Description:** Add `pkg` as a development dependency and scripts that package `dist/cli/wsd.cjs` into standalone binaries for Ubuntu/Linux and macOS. Keep binary output under a predictable distribution directory for release artifacts only; do not include these binaries in the npm package files list.

**Acceptance criteria:**
- [ ] `pkg` is added to `packages/workspace` dev dependencies or root tooling, following the monorepo's dependency pattern.
- [ ] A script such as `build:bin` builds the CLI first and then invokes `pkg`.
- [ ] Binary targets include Linux x64, macOS x64, and macOS arm64.
- [ ] Output filenames clearly identify platform and architecture, e.g. `wsd-linux-x64`, `wsd-macos-x64`, and `wsd-macos-arm64`.

**Verification:**
- [ ] Build succeeds: `npm run build:bin --workspace=@cloudflare/workspace`.
- [ ] Manual check on the current host: run the matching generated `wsd-*` binary with `PORT` set and verify `/health` returns `200` and `/` returns `{}`.

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
- [ ] README documents standalone binary invocation as release-artifact usage.
- [ ] README documents `GET /health` as the initial readiness endpoint.
- [ ] README documents `GET /` returning `{}`.
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
- [ ] Standalone binaries build for initial target platforms as release artifacts.
- [ ] Integration test passes.
- [ ] README reflects the current scaffold behavior.

## Resolved Decisions from Review

- Start from an entirely blank branch with no existing project files.
- Use `GET /health`, not `/healthz`, for readiness.
- Support `npx -p @cloudflare/workspace wsd` for now.
- Treat `pkg` binaries as release artifacts only, not npm package contents.
- Return an empty JSON object from `GET /`.
- Do not plan around reusing an existing container-sandbox server; this scaffold starts from scratch.
