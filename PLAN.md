created: 2026-05-29
last updated: 2026-05-29

# Implementation Plan: Cloudflare DO Storage-backed Workspace VFS Package

## Overview

Build a JavaScript/TypeScript package for the Cloudflare workspace project from an entirely clean branch. This should **not** be a CLI. The package should take a Cloudflare Durable Object `storage` interface backed by SQLite and return an object exposing the documented Workspace filesystem interface from the design docs.

The target public API is a small package that can be used inside a Durable Object:

```ts
import { createWorkspace } from "@cloudflare/workspace";

export class WorkspaceDurableObject extends DurableObject {
  workspace = createWorkspace(this.ctx.storage);

  async fetch(request: Request) {
    const text = await this.workspace.fs.readFile("/workspace/README.md", "utf8");
    return new Response(text);
  }
}
```

The first implementation should focus on `Workspace.fs`, backed by the documented `cf_vfs_*` SQLite schema. It should also expose VFS stats that can be served from a Durable Object endpoint, and a Node-oriented `node:fs`-like adapter that lets tests and future socket/container phases interact with the same VFS through familiar filesystem calls. Shell, container sync, FUSE, mounts, and RPC are out of scope unless needed to preserve schema compatibility.

## Source References

- `docs/03_filesystem_schema.md` — authoritative SQLite schema, invariants, revisions, chunks, manifests, watermarks, and GC expectations.
- `docs/04_filesystem_interface.md` — authoritative JavaScript filesystem interface: `readFile`, `writeFile`, `rm`, `mkdir`, `readdir`, `stat`, `findFiles`, `listFilesUnder`, and `grep`.
- `docs/02_sync_protocol.md` — revision/change/tombstone model relevant to future sync and current delete tracking.
- `docs/01_directory_structure.md` — absolute POSIX path expectations and workspace path conventions.
- `docs/10_project_layout.md` — package layout guidance, though this implementation starts from a clean branch.

## Goals

- Start from an entirely clean branch with no inherited implementation files.
- Provide a reusable JS module, not a command-line tool.
- Accept a Cloudflare Durable Object storage object, or a narrow adapter around it, as the persistence layer.
- Initialize and use the documented SQLite schema inside DO storage.
- Expose the documented `WorkspaceFilesystem` API through `workspace.fs`.
- Expose VFS state/statistics through a package API that can be wired into a Durable Object HTTP endpoint.
- Provide a Node-oriented filesystem adapter for tests and future socket/container integration.
- Keep core behavior testable outside Workers by using a storage adapter/fake that mimics DO SQLite semantics.
- Use TDD: write tests for schema/interface behavior before implementation.

## Non-goals

- No CLI commands.
- No FUSE implementation.
- No WebSocket/RPC sync protocol.
- No container shell execution.
- No R2 lazy mount implementation in the first pass.
- No UI or full Worker app scaffold beyond tests/examples needed to validate package usage.
- No transparent monkey-patching of the built-in `node:fs` module in the first pass; provide an explicit adapter/facade instead.

## Proposed Package Shape

```ts
export interface Workspace {
  fs: WorkspaceFilesystem;
  stats(): Promise<WorkspaceVfsStats>;
  gc(safetyWindowMs?: number): Promise<{ manifestsFreed: number; blobsFreed: number }>;
}

export interface WorkspaceFilesystem {
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(path: string, options: { encoding?: "utf8" }): Promise<string | ReadableStream<Uint8Array>>;
  writeFile(path: string, content: string | Uint8Array | ReadableStream<Uint8Array>, options?: { mode?: number }): Promise<void>;
  rm(path: string, options?: { recursive?: true; force?: true }): Promise<void>;
  mkdir(path: string, options?: { recursive?: true; mode?: number }): Promise<void>;
  readdir(path: string): Promise<Array<{ name: string; parentPath: string; isFile: boolean; isDirectory: boolean }>>;
  stat(path: string): Promise<{ name: string; mode: number; mtime: number; size: number; isFile: boolean; isDirectory: boolean }>;
  findFiles(directory: string, pattern?: string): Promise<Array<{ path: string; type: "file" | "dir" }>>;
  listFilesUnder(prefix: string): Promise<string[]>;
  grep(pattern: string, path: string, options?: { ignoreCase?: boolean }): Promise<Array<{ path: string; line: number; text: string }>>;
}

export interface WorkspaceVfsStats {
  schemaVersion: number;
  rev: number;
  pushRev: number;
  fetchRev: number;
  nodes: { files: number; directories: number; total: number };
  dirents: number;
  content: {
    filesBytes: number;
    chunks: number;
    blobs: number;
    blobBytes: number;
    manifests: number;
    deduplicatedBytes: number;
  };
  changes: { tombstones: number; latestRev: number | null };
  mounts: { total: number; indexed: number };
}

export function createWorkspace(storage: DurableObjectStorage, options?: WorkspaceOptions): Workspace;
export function createWorkspaceStatsResponse(workspace: Workspace): Promise<Response>;
export function createNodeFsAdapter(fs: WorkspaceFilesystem): WorkspaceNodeFsAdapter;
```

Implementation can introduce internal adapters if the exact Cloudflare type is inconvenient in tests:

```ts
interface WorkspaceSqlStorage {
  exec<T = unknown>(sql: string, ...bindings: unknown[]): Iterable<T>;
}
```

But the user-facing entrypoint should take the normal Durable Object storage interface.

The stats endpoint should be a small helper rather than a full router, so DO code can opt in explicitly:

```ts
async fetch(request: Request) {
  const url = new URL(request.url);
  if (url.pathname === "/__workspace/stats") {
    return createWorkspaceStatsResponse(this.workspace);
  }
  return new Response("not found", { status: 404 });
}
```

The Node adapter should be an explicit `node:fs/promises`-style facade used by tests and future socket/container code:

```ts
const nodeFs = createNodeFsAdapter(workspace.fs);
await nodeFs.mkdir("/workspace/src", { recursive: true });
await nodeFs.writeFile("/workspace/src/index.ts", "export {};\n", "utf8");
const text = await nodeFs.readFile("/workspace/src/index.ts", "utf8");
```

It is not expected to make the built-in `node:fs` module transparently point at the VFS without an explicit facade or later monkey-patching layer.

## Architecture Decisions

- Put the reusable package at `packages/workspace` and publish it as `@cloudflare/workspace`.
- Keep implementation Worker-compatible: no Node-only APIs in package runtime code. Tests may use Node helpers.
- Hide SQLite details behind internal modules; expose the documented workspace object/interface plus explicit stats and adapter helpers.
- Use the `cf_vfs_*` table names exactly as documented so future Worker/container sync can share the database.
- Split file data into 512 KiB chunks and content-address them with SHA-256 from the start.
- Store manifests using the documented encoded format, with tests pinning encoding/decoding behavior.
- Bump the singleton `cf_vfs_meta.rev` on every mutation and write delete tombstones to `cf_vfs_changes`.
- Throw `NodeJS.ErrnoException`-shaped errors with stable `code` values for POSIX-style behavior.
- Keep stats read-only and cheap enough to serve on demand from a DO endpoint.
- Keep the Node adapter as a thin translation layer over `WorkspaceFilesystem`, not a separate implementation.

## Task List

### Phase 1: Clean branch and package scaffold

## Task 1: Create clean package branch

**Description:** Create an orphan/clean branch with no inherited implementation content, then add minimal package scaffolding and copied design docs needed as implementation references.

**Acceptance criteria:**
- [ ] Branch contains no existing source implementation from the design/main branches.
- [ ] Root package config and TypeScript config exist.
- [ ] `packages/workspace` exists as the package under development.
- [ ] Relevant design docs are copied into `docs/` or referenced clearly.
- [ ] Package exports are declared but may initially throw `NotImplemented`.

**Verification:**
- [ ] `git ls-files` shows only intentional clean scaffolding/docs/config.
- [ ] `npm install` succeeds.
- [ ] `npm test` runs.

**Dependencies:** None

**Files likely touched:**
- `package.json`
- `tsconfig.base.json`
- `packages/workspace/package.json`
- `packages/workspace/src/index.ts`
- `docs/**`

**Estimated scope:** Small/Medium

## Task 2: Define storage adapter and public API tests

**Description:** Define the public `createWorkspace(storage)` API and an internal storage adapter for DO SQLite. Add tests that instantiate the package against a fake/test SQLite storage and assert the shape of the returned object.

**Acceptance criteria:**
- [ ] `createWorkspace(storage)` returns `{ fs, stats, gc }`.
- [ ] `fs` exposes all documented methods.
- [ ] Runtime package code does not depend on Node-only modules.
- [ ] Tests can run in Node using a fake/in-memory SQLite adapter while preserving DO-style SQL behavior.

**Verification:**
- [ ] API shape tests fail before implementation and pass after the minimal entrypoint is added.

**Dependencies:** Task 1

**Files likely touched:**
- `packages/workspace/src/index.ts`
- `packages/workspace/src/storage.ts`
- `packages/workspace/src/types.ts`
- `packages/workspace/test/helpers/storage.ts`
- `packages/workspace/test/index.test.ts`

**Estimated scope:** Medium

### Checkpoint: Package skeleton

- [ ] Clean branch is ready.
- [ ] Public API shape is locked by tests.
- [ ] No CLI assumptions remain in docs or package design.

### Phase 2: SQLite schema and initialization

## Task 3: Implement schema initialization

**Description:** Create the documented `cf_vfs_*` and `_cf_vfs_*` tables in DO SQLite, seed root inode `1`, and seed singleton metadata rows.

**Acceptance criteria:**
- [ ] `cf_vfs_meta`, `cf_vfs_nodes`, `cf_vfs_dirents`, `cf_vfs_blobs`, `cf_vfs_blob_bytes`, `cf_vfs_chunks`, `cf_vfs_manifests`, `cf_vfs_changes`, `_cf_vfs_watermark`, and `_cf_vfs_mounts` are created.
- [ ] Root directory is inode `1`, type `dir`, with no parent dirent.
- [ ] `cf_vfs_meta` contains `schema_version` and `rev`.
- [ ] `_cf_vfs_watermark` contains initial `pushRev` and `fetchRev`.
- [ ] Opening a database with a newer schema version fails safely.

**Verification:**
- [ ] Schema tests assert table existence, seed rows, root invariants, and newer-schema rejection.

**Dependencies:** Tasks 1-2

**Files likely touched:**
- `packages/workspace/src/schema.ts`
- `packages/workspace/src/database.ts`
- `packages/workspace/test/schema.test.ts`

**Estimated scope:** Medium

## Task 4: Implement transaction/revision helpers

**Description:** Add helpers for serialized mutations, revision bumps, and storage error wrapping.

**Acceptance criteria:**
- [ ] Every mutation can run in a single SQLite transaction.
- [ ] `cf_vfs_meta.rev` is atomically incremented and returned.
- [ ] New/updated live nodes are stamped with the mutation rev.
- [ ] Delete operations can insert tombstones into `cf_vfs_changes`.
- [ ] Storage failures are wrapped as `EIO` where appropriate.

**Verification:**
- [ ] Unit tests assert monotonic rev behavior and transaction rollback on failure.

**Dependencies:** Task 3

**Files likely touched:**
- `packages/workspace/src/transactions.ts`
- `packages/workspace/src/errors.ts`
- `packages/workspace/test/revisions.test.ts`

**Estimated scope:** Small/Medium

### Phase 3: Path resolution and content storage

## Task 5: Implement POSIX path validation and inode resolution

**Description:** Implement absolute POSIX path handling and traversal through `cf_vfs_dirents` to resolve files/directories.

**Acceptance criteria:**
- [ ] All public fs methods require absolute POSIX paths.
- [ ] Duplicate slashes and `.` segments are handled consistently.
- [ ] Escape above root is rejected with `EINVAL`.
- [ ] Missing leaf paths, missing parent paths, and file-as-parent cases are distinguishable.
- [ ] Root path `/` is handled correctly and cannot be removed.

**Verification:**
- [ ] Tests cover root, nested paths, invalid paths, file-as-parent `ENOTDIR`, missing path `ENOENT`, and root deletion `EPERM`.

**Dependencies:** Task 3

**Files likely touched:**
- `packages/workspace/src/path.ts`
- `packages/workspace/src/resolve.ts`
- `packages/workspace/test/path.test.ts`

**Estimated scope:** Medium

## Task 6: Implement blob/chunk/manifest storage

**Description:** Implement file content storage using 512 KiB chunks, SHA-256 blob hashes, blob bytes, chunks, and manifest rows.

**Acceptance criteria:**
- [ ] Empty, small, and multi-chunk files are encoded correctly.
- [ ] Identical chunks deduplicate `cf_vfs_blobs` and `cf_vfs_blob_bytes` rows.
- [ ] Identical file contents deduplicate manifest rows.
- [ ] Manifest encoding starts with `0x01` and includes chunk hash/offset/size records.
- [ ] File bytes can be read back as a stream without buffering the entire file when possible.

**Verification:**
- [ ] Tests cover binary data, UTF-8 text, empty files, multi-chunk files, deduplication, and manifest encoding fixtures.

**Dependencies:** Tasks 3-5

**Files likely touched:**
- `packages/workspace/src/blob-store.ts`
- `packages/workspace/src/manifest.ts`
- `packages/workspace/src/content.ts`
- `packages/workspace/test/content.test.ts`

**Estimated scope:** Medium/Large

### Phase 4: Documented `Workspace.fs` methods

## Task 7: Implement `mkdir`

**Description:** Implement `fs.mkdir(path, options?)` with documented recursive and mode behavior.

**Acceptance criteria:**
- [ ] Creates directories with default or provided mode.
- [ ] Supports `{ recursive: true }`.
- [ ] Throws `EEXIST` for existing path without recursive behavior.
- [ ] Throws `ENOTDIR` when a parent segment is a file.
- [ ] Stamps new/changed directories with mutation rev.

**Verification:**
- [ ] TDD tests cover happy paths and POSIX error cases.

**Dependencies:** Tasks 4-5

**Files likely touched:**
- `packages/workspace/src/fs.ts`
- `packages/workspace/test/mkdir.test.ts`

**Estimated scope:** Small/Medium

## Task 8: Implement `writeFile` and `readFile`

**Description:** Implement streaming/text/binary file writes and stream/text reads using the chunk storage layer.

**Acceptance criteria:**
- [ ] `writeFile` accepts `string`, `Uint8Array`, and `ReadableStream<Uint8Array>`.
- [ ] `writeFile` creates or overwrites files.
- [ ] `writeFile` honors `{ mode }` for new files and explicit mode changes.
- [ ] `readFile(path)` returns `ReadableStream<Uint8Array>`.
- [ ] `readFile(path, "utf8")` and `{ encoding: "utf8" }` return strings.
- [ ] `readFile` on a directory throws `EISDIR`.

**Verification:**
- [ ] Tests cover all input/output forms, binary data, stream input, stream output, overwrite, modes, and error cases.

**Dependencies:** Tasks 5-6

**Files likely touched:**
- `packages/workspace/src/fs.ts`
- `packages/workspace/test/read-write.test.ts`

**Estimated scope:** Medium/Large

## Task 9: Implement `stat` and `readdir`

**Description:** Implement metadata and directory listing methods exactly as documented.

**Acceptance criteria:**
- [ ] `stat` returns `{ name, mode, mtime, size, isFile, isDirectory }`.
- [ ] Directory size behavior is documented and tested.
- [ ] `readdir` returns dirent-shaped entries with `{ name, parentPath, isFile, isDirectory }`.
- [ ] Results have stable ordering.
- [ ] Missing paths and file-as-directory cases throw appropriate codes.

**Verification:**
- [ ] Tests cover files, directories, root, nested entries, and missing/error cases.

**Dependencies:** Tasks 7-8

**Files likely touched:**
- `packages/workspace/src/fs.ts`
- `packages/workspace/test/stat-readdir.test.ts`

**Estimated scope:** Medium

## Task 10: Implement `rm`

**Description:** Implement `fs.rm(path, options?)` replacing unlink/rmdir semantics with documented recursive and force behavior.

**Acceptance criteria:**
- [ ] Removes files.
- [ ] Removes empty directories.
- [ ] Throws `ENOTEMPTY` for non-empty directories without recursive.
- [ ] Supports `{ recursive: true }` for subtree deletion.
- [ ] Supports `{ force: true }` for missing paths.
- [ ] Refuses to remove root with `EPERM`.
- [ ] Writes delete tombstones to `cf_vfs_changes` with bumped revisions.

**Verification:**
- [ ] Tests cover file delete, directory delete, recursive delete, force, root protection, and tombstones.

**Dependencies:** Tasks 4, 7-9

**Files likely touched:**
- `packages/workspace/src/fs.ts`
- `packages/workspace/test/rm.test.ts`

**Estimated scope:** Medium

## Task 11: Implement traversal/search methods

**Description:** Implement `findFiles`, `listFilesUnder`, and `grep` over the SQLite VFS.

**Acceptance criteria:**
- [ ] `findFiles(directory)` returns files and directories under the directory.
- [ ] `findFiles(directory, pattern)` supports documented simple globs such as `*.ts` and `**/*.md`.
- [ ] `listFilesUnder(prefix)` returns a flat list of file paths only.
- [ ] `grep(pattern, path, options?)` scans text files and returns `{ path, line, text }` hits.
- [ ] `grep` supports `ignoreCase`.
- [ ] Binary/unreadable text handling is documented and tested.

**Verification:**
- [ ] Tests cover nested trees, pattern matching, prefix listing, grep hits, case-insensitive grep, and no-hit behavior.

**Dependencies:** Tasks 8-10

**Files likely touched:**
- `packages/workspace/src/search.ts`
- `packages/workspace/src/glob.ts`
- `packages/workspace/test/search.test.ts`

**Estimated scope:** Medium

### Checkpoint: Documented filesystem API complete

- [ ] Every method documented in `docs/04_filesystem_interface.md` has tests and implementation.
- [ ] Tests assert POSIX-style error `code` values.
- [ ] The package works by calling `createWorkspace(storage).fs`, not by invoking a CLI.

### Phase 5: Stats, adapters, schema invariants, GC, and future-sync hooks

## Task 12: Implement VFS stats API and stats endpoint helper

**Description:** Add a read-only `workspace.stats()` API that summarizes the current VFS database, plus a small `createWorkspaceStatsResponse(workspace)` helper for exposing the stats from a Durable Object endpoint.

**Acceptance criteria:**
- [ ] `workspace.stats()` returns schema version, rev, watermarks, file/dir counts, dirent count, content/chunk/blob/manifest counts, total live file bytes, estimated deduplicated bytes, tombstone count, latest tombstone rev, and mount index counts.
- [ ] Stats are computed from SQLite and do not depend on in-memory caches.
- [ ] Stats queries are read-only and do not mutate `last_seen`, `rev`, or watermarks.
- [ ] `createWorkspaceStatsResponse(workspace)` returns JSON with `content-type: application/json`.
- [ ] Example Durable Object code shows routing `/__workspace/stats` to the helper.

**Verification:**
- [ ] Tests create files, duplicate content, directories, deletes, and mount rows, then assert stats values.
- [ ] Endpoint helper test asserts status, content type, and JSON body.

**Dependencies:** Tasks 3, 6, 8, 10

**Files likely touched:**
- `packages/workspace/src/stats.ts`
- `packages/workspace/src/http.ts`
- `packages/workspace/test/stats.test.ts`
- `packages/workspace/test/http.test.ts`

**Estimated scope:** Medium

## Task 13: Implement Node filesystem adapter

**Description:** Add a Node-oriented `node:fs/promises`-style adapter over `WorkspaceFilesystem` for tests and the next socket implementation phase. This adapter should let code use familiar methods without duplicating VFS behavior.

**Acceptance criteria:**
- [ ] `createNodeFsAdapter(workspace.fs)` returns an object with documented `node:fs/promises`-like methods backed by `WorkspaceFilesystem`.
- [ ] Initial methods include `readFile`, `writeFile`, `mkdir`, `rm`, `readdir`, `stat`, `lstat`, `unlink`, `rmdir`, and `access` where they can map cleanly to the VFS.
- [ ] `readFile` and `writeFile` support Node-like encoding/options forms used by tests.
- [ ] `stat`/`lstat` return a `Stats`-like object with `isFile()` and `isDirectory()` methods.
- [ ] Adapter errors preserve POSIX-style `code` values.
- [ ] The adapter is explicit; it does not monkey-patch global `node:fs`.

**Verification:**
- [ ] Existing package tests can use the adapter for black-box filesystem behavior.
- [ ] Adapter contract tests compare representative behavior with `node:fs/promises` for matching operations.
- [ ] Future socket-facing tests can use the adapter without touching SQLite internals.

**Dependencies:** Tasks 7-11

**Files likely touched:**
- `packages/workspace/src/node-fs-adapter.ts`
- `packages/workspace/src/node-stats.ts`
- `packages/workspace/test/node-fs-adapter.test.ts`

**Estimated scope:** Medium

## Task 14: Implement schema verification helpers

**Description:** Add internal or exported diagnostic helpers to validate documented schema invariants.

**Acceptance criteria:**
- [ ] Verification checks root inode, file/chunk/manifest relationships, blob byte existence, dirent references, and rev bounds.
- [ ] Returns structured diagnostics rather than only throwing.
- [ ] Does not mutate storage.

**Verification:**
- [ ] Tests intentionally corrupt test databases and assert useful diagnostics.

**Dependencies:** Tasks 3-11

**Files likely touched:**
- `packages/workspace/src/verify.ts`
- `packages/workspace/test/verify.test.ts`

**Estimated scope:** Medium

## Task 15: Implement `Workspace.gc`

**Description:** Implement garbage collection for unreferenced manifests and blobs using the documented safety window.

**Acceptance criteria:**
- [ ] `workspace.gc(safetyWindowMs?)` returns `{ manifestsFreed, blobsFreed }`.
- [ ] Live manifests/blobs are preserved.
- [ ] Unreferenced old rows are removed.
- [ ] Blob bytes cascade or are removed consistently with blob metadata.
- [ ] Default safety window is conservative and documented.

**Verification:**
- [ ] Tests cover overwritten files, removed files, shared chunks, safety window behavior, and return counts.

**Dependencies:** Tasks 6, 10, 14

**Files likely touched:**
- `packages/workspace/src/gc.ts`
- `packages/workspace/test/gc.test.ts`

**Estimated scope:** Medium

## Task 16: Add change/revision inspection for future sync

**Description:** Add a package-level read-only API for changed live nodes and delete tombstones since a revision. This is not the sync protocol, but it preserves the documented revision model and makes future sync implementation testable.

**Acceptance criteria:**
- [ ] Can list live nodes changed after a given rev.
- [ ] Can list delete tombstones from `cf_vfs_changes` after a given rev.
- [ ] Output is structured and marked internal/provisional if exported.
- [ ] Does not implement WebSocket/RPC.

**Verification:**
- [ ] Tests cover writes, overwrites, deletes, and recursive deletes across revisions.

**Dependencies:** Tasks 4, 8, 10

**Files likely touched:**
- `packages/workspace/src/changes.ts`
- `packages/workspace/test/changes.test.ts`

**Estimated scope:** Small/Medium

### Phase 6: Worker compatibility and documentation

## Task 17: Add Worker/Durable Object integration tests or examples

**Description:** Validate that the package can be constructed with a Durable Object storage-like interface and used in a Worker-compatible environment.

**Acceptance criteria:**
- [ ] Example Durable Object shows `createWorkspace(this.ctx.storage)`.
- [ ] Example Durable Object exposes `/__workspace/stats` using `createWorkspaceStatsResponse(workspace)`.
- [ ] Test harness verifies schema initialization and basic fs operations in a Worker-like environment if available.
- [ ] Runtime package remains free of Node-only APIs.

**Verification:**
- [ ] Package tests pass in Node.
- [ ] Worker compatibility test/example runs or is documented with exact command.

**Dependencies:** Tasks 1-13

**Files likely touched:**
- `packages/workspace/examples/durable-object.ts`
- `packages/workspace/test/worker-compat.test.ts`
- `README.md`

**Estimated scope:** Medium

## Task 18: Final docs and package validation

**Description:** Document package usage, API, schema compatibility, and known deferred features.

**Acceptance criteria:**
- [ ] README explains that this is a package, not a CLI.
- [ ] README includes Durable Object usage example.
- [ ] README documents the optional stats endpoint helper.
- [ ] README documents the Node filesystem adapter and its explicit-facade limitation.
- [ ] API docs mirror `docs/04_filesystem_interface.md`.
- [ ] Deferred features are listed: shell, FUSE, WebSocket/RPC sync, lazy mounts, R2 tiering.
- [ ] Build, typecheck, and tests all pass from a clean checkout.

**Verification:**
- [ ] `npm run build`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] Package export smoke test imports `@cloudflare/workspace` and calls `createWorkspace`.

**Dependencies:** Tasks 1-17

**Files likely touched:**
- `README.md`
- `packages/workspace/README.md`
- `packages/workspace/package.json`

**Estimated scope:** Small/Medium

## Risks and Open Questions

- **Exact DO storage typing:** Need to confirm whether the public function should accept `DurableObjectStorage` directly, `DurableObjectState`, or a narrowed `{ sql }` adapter.
- **SQLite API differences in tests:** Node SQLite test harness must match Cloudflare DO SQLite enough to avoid false confidence.
- **Crypto compatibility:** SHA-256 hashing should use Web Crypto (`crypto.subtle`) for Worker compatibility, not Node `crypto` in runtime code.
- **ReadableStream ergonomics:** Stream read/write paths must work in Workers and tests without relying on Node streams.
- **Manifest varint encoding:** Need exact varint fixtures to avoid incompatible manifests.
- **Path normalization:** Decide whether `..` is rejected outright or canonicalized while preventing root escape.
- **Hardlinks/rename:** Schema supports inode indirection and hardlinks, but the documented fs interface does not currently expose `link`/`rename`; avoid implementing extra public API unless requested.
- **Verification API visibility:** Decide whether invariant verification is public, internal, or test-only.
- **Stats endpoint shape:** Decide whether `/__workspace/stats` is the recommended path or only an example, and whether stats need redaction/auth hooks.
- **Node adapter scope:** Node does not let `node:fs` transparently target an arbitrary userland filesystem without monkey-patching or FUSE. Decide whether the first adapter remains an explicit facade or later grows a patching layer for socket-side code.

## Suggested First Milestone

Complete Tasks 1-6 first. That yields a clean, tested package skeleton with schema initialization, path resolution, and chunk/manifest storage. Then Tasks 7-11 implement the full documented `Workspace.fs` interface on top of that foundation. Tasks 12-13 add the stats endpoint helper and Node filesystem adapter needed for observability, tests, and the next socket phase.
