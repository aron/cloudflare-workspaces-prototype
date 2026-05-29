created: 2026-05-29
last updated: 2026-05-29

# Implementation Plan: Basic `wsd` FUSE Mount

## Overview

Add the first FUSE-backed filesystem implementation to the existing `wsd` CLI scaffold. This phase should stay local to the daemon process: no WebSocket, no capnweb/RPC, and no host/DO synchronization yet. The daemon should create an in-memory filesystem, mount it at `MOUNT_POINT`, and continue serving the existing HTTP endpoints (`GET /health` and `GET /`) on `PORT`.

The goal is to prove that `wsd` can own a mount point and expose a small writable filesystem that normal host/container tools can access through FUSE.

## Source Notes

- The design docs describe the injected service as owning a FUSE mount at `MOUNT_POINT` with default `/workspace`, with HTTP readiness on the daemon port.
- The previous design-branch implementation used `fuse-native` plus an in-memory VFS, with FUSE paths translated into VFS paths.
- This branch intentionally starts from the minimal CLI scaffold; do not copy over WebSocket/RPC behavior yet.
- The current scaffold already has:
  - `packages/workspace/src/cli/wsd.ts`
  - package/bin/build scripts
  - `node:test` integration test for `PORT`, `/health`, and `/`
  - `pkg` binary build scaffolding

## Decisions

- Use `MOUNT_POINT` to choose the mount location; default to `/workspace` for container use.
- Keep `GET /health` as the readiness endpoint.
- Keep `GET /` returning `{}` for now, unless we explicitly agree to expose status metadata later.
- Do not add WebSocket/RPC endpoints in this phase.
- Use Node standard library for the VFS itself and `fuse-native` for FUSE bindings.
- Treat FUSE smoke tests as environment-sensitive: run them when `/dev/fuse` and mount permissions are available, otherwise skip with an explicit reason.
- Keep the fallback story simple: if FUSE mount fails, `wsd` should log the failure and exit non-zero for now. A later phase can add a no-FUSE plain-directory fallback if needed.

## Risks / Unknowns

- `fuse-native` is a native dependency. It may complicate `pkg` standalone binaries because native `.node` assets often need explicit packaging or extraction handling.
- macOS FUSE requires macFUSE or an equivalent system installation; CI/local tests may need to skip FUSE smoke tests there.
- Container images need `fuse3`/`libfuse2` and access to `/dev/fuse`.
- Mount lifecycle must be careful: tests need reliable unmount/cleanup on normal exit, `SIGINT`, and `SIGTERM`.

## Task List

### Phase 1: In-memory filesystem foundation

## Task 1: Add a small in-memory VFS model

**Description:** Implement the minimal filesystem data model needed by the FUSE driver. The VFS should support directories and regular files, path normalization, metadata needed for `getattr`, and basic read/write/truncate/delete operations.

**Acceptance criteria:**
- [ ] `packages/workspace/src/fuse/vfs.ts` exists.
- [ ] VFS creates a root directory during initialization.
- [ ] VFS supports `mkdir`, `readdir`, `getattr`-style metadata, `createFile`, `read`, `write`, `truncate`, `unlink`, and `rename`.
- [ ] Invalid paths cannot escape the VFS root.
- [ ] File mtimes update on writes/truncates/renames.

**Verification:**
- [ ] Unit tests pass for VFS directory creation, file write/read, truncate, delete, rename, and path normalization.
- [ ] `npm test --workspace=@cloudflare/workspace` passes.

**Dependencies:** None

**Files likely touched:**
- `packages/workspace/src/fuse/vfs.ts`
- `packages/workspace/tests/vfs.test.js` or TypeScript equivalent
- `packages/workspace/package.json` if test script needs to include additional tests

**Estimated scope:** Medium: 2-3 files

## Task 2: Add FUSE operation adapter

**Description:** Add a FUSE adapter that maps `fuse-native` callbacks to the VFS operations. Keep the first operation set small but useful enough for normal shell tools: stat, list, create, open, read, write, truncate, unlink, mkdir, rmdir, rename, access, and statfs.

**Acceptance criteria:**
- [ ] `packages/workspace/src/fuse/driver.ts` exists.
- [ ] FUSE path `/` maps to the VFS root.
- [ ] `getattr` returns stable mode, size, and mtime values for files and directories.
- [ ] File reads/writes work at arbitrary offsets.
- [ ] Unsupported operations return appropriate FUSE error codes rather than throwing.
- [ ] The driver exposes `mountFuse({ mountPoint, vfs })` and an unmount/close function.

**Verification:**
- [ ] Driver tests can exercise FUSE ops directly without requiring a real kernel mount.
- [ ] `npm test --workspace=@cloudflare/workspace` passes.

**Dependencies:** Task 1

**Files likely touched:**
- `packages/workspace/src/fuse/driver.ts`
- `packages/workspace/src/fuse/fuse-native.d.ts`
- `packages/workspace/tests/fuse-driver.test.js` or TypeScript equivalent
- `packages/workspace/package.json`
- `package-lock.json`

**Estimated scope:** Medium: 3-5 files

### Checkpoint: FUSE logic testable without kernel mount

- [ ] VFS tests pass.
- [ ] FUSE operation adapter tests pass.
- [ ] Existing HTTP server integration test still passes.
- [ ] No WebSocket/RPC surface has been added.

### Phase 2: Wire FUSE into `wsd`

## Task 3: Add daemon startup configuration for `MOUNT_POINT`

**Description:** Extend the CLI startup path to parse `MOUNT_POINT`, create the mount directory if needed, initialize the VFS, and mount FUSE before reporting readiness on `/health`.

**Acceptance criteria:**
- [ ] Missing `MOUNT_POINT` defaults to `/workspace`.
- [ ] Relative `MOUNT_POINT` values are rejected with a clear error.
- [ ] The mount directory is created if it does not exist.
- [ ] FUSE is mounted before the HTTP server begins listening or before `/health` can return `200`.
- [ ] Startup logs include the selected `PORT` and `MOUNT_POINT`.

**Verification:**
- [ ] `npm test --workspace=@cloudflare/workspace` passes.
- [ ] Manual check on FUSE-capable Linux: `MOUNT_POINT=$(mktemp -d) PORT=4567 npm exec --workspace=@cloudflare/workspace -- wsd`, then `curl http://127.0.0.1:4567/health` returns `200`.

**Dependencies:** Tasks 1-2

**Files likely touched:**
- `packages/workspace/src/cli/wsd.ts`
- `packages/workspace/src/fuse/index.ts`
- `packages/workspace/tests/wsd.test.js`

**Estimated scope:** Medium: 2-3 files

## Task 4: Add graceful unmount on shutdown

**Description:** Update signal and shutdown handling so the daemon closes the HTTP server, unmounts FUSE, and exits cleanly. This is especially important for integration tests because stale mount points can poison later runs.

**Acceptance criteria:**
- [ ] `SIGINT` and `SIGTERM` trigger HTTP close and FUSE unmount.
- [ ] Unmount errors are logged but do not hang process exit.
- [ ] Test cleanup does not leave mounted temp directories behind.
- [ ] Repeated start/stop cycles on the same temp mount point do not fail due to stale process state.

**Verification:**
- [ ] Integration test starts and stops `wsd` at least twice in one test run on a FUSE-capable host.
- [ ] Manual check: after stopping `wsd`, `mount | grep <mount-point>` no longer shows the FUSE mount.

**Dependencies:** Task 3

**Files likely touched:**
- `packages/workspace/src/cli/wsd.ts`
- `packages/workspace/src/fuse/driver.ts`
- `packages/workspace/tests/wsd-fuse.test.js`

**Estimated scope:** Medium: 2-3 files

### Checkpoint: daemon owns a mount lifecycle

- [ ] `wsd` can mount and unmount a temp FUSE filesystem.
- [ ] `/health` only reports ready after the mount is available.
- [ ] Existing `/` behavior remains `{}`.
- [ ] Existing non-FUSE HTTP test still passes or is adjusted to supply a temp mount.

### Phase 3: FUSE integration smoke test

## Task 5: Add an environment-gated FUSE smoke test

**Description:** Add a `node:test` integration test that starts the built `wsd` with a temporary mount point, waits for `/health`, then uses normal Node `fs` APIs against the mount point to create, read, list, rename, truncate, and delete files.

**Acceptance criteria:**
- [ ] Test uses `node:test` and Node standard assertions.
- [ ] Test skips explicitly when FUSE prerequisites are unavailable.
- [ ] Test starts `wsd` with both `PORT` and `MOUNT_POINT` set.
- [ ] Test verifies file IO through the mounted path, not by calling VFS internals.
- [ ] Test stops `wsd` and removes the temp directory afterward.

**Verification:**
- [ ] On FUSE-capable Linux/container: `npm test --workspace=@cloudflare/workspace` runs the FUSE smoke test and passes.
- [ ] On non-FUSE hosts: `npm test --workspace=@cloudflare/workspace` passes with a clear skip message.

**Dependencies:** Tasks 3-4

**Files likely touched:**
- `packages/workspace/tests/wsd-fuse.test.js`
- `packages/workspace/tests/helpers/process.js` if shared process helpers are extracted from the current test

**Estimated scope:** Medium: 2 files

## Task 6: Update package and binary build handling for native FUSE dependency

**Description:** Add `fuse-native` to package dependencies and update build/binary scripts so TypeScript build and npm distribution work with the native dependency. Investigate whether `pkg` binaries can include or locate the required native addon; if not, document the limitation and keep npm execution as the supported FUSE path for this phase.

**Acceptance criteria:**
- [ ] `fuse-native` is declared in the appropriate package dependencies.
- [ ] TypeScript build succeeds with local type declarations if upstream types are unavailable.
- [ ] npm package files include compiled FUSE modules.
- [ ] `build:bin` either succeeds with documented native-asset handling or fails fast with a clear documented limitation.
- [ ] README explains system prerequisites: FUSE runtime, `/dev/fuse` access, and macFUSE on macOS.

**Verification:**
- [ ] `npm run build --workspace=@cloudflare/workspace` passes.
- [ ] `npm test --workspace=@cloudflare/workspace` passes.
- [ ] `npm run build:bin --workspace=@cloudflare/workspace` behavior is verified and documented.

**Dependencies:** Tasks 1-5

**Files likely touched:**
- `packages/workspace/package.json`
- `package-lock.json`
- `packages/workspace/scripts/build-bin.mjs`
- `packages/workspace/README.md`

**Estimated scope:** Medium: 3-4 files

### Checkpoint: basic FUSE implementation ready for review

- [ ] Unit tests cover VFS behavior and FUSE op mapping.
- [ ] Integration smoke test verifies real mounted-file IO when supported by the environment.
- [ ] `wsd` still exposes `GET /health` and `GET /` without WebSocket/RPC.
- [ ] Shutdown unmounts cleanly.
- [ ] Native dependency and binary-build limitations are documented.

## Out of Scope for This Plan

- WebSocket or capnweb RPC.
- DO-to-container synchronization.
- Dirty tracking protocol.
- Blob/chunk manifests.
- Shell exec API beyond using normal tools against the mounted filesystem.
- No-FUSE plain directory fallback.
- Auth for any future RPC endpoint.
