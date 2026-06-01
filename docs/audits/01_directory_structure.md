# Audit: docs/01_directory_structure.md

## Scope

Spec-vs-implementation audit of `docs/01_directory_structure.md`. Every
normative claim in the doc — workspace root, constructor shape, path
conventions, mount semantics, reserved paths, and sandbox/FUSE
behaviour — is traced to current code under `packages/`. Code is
authoritative; doc targets are flagged where they diverge.

## Methodology

1. Read `docs/01_directory_structure.md` end-to-end.
2. Extracted each normative claim with its doc line range.
3. Traced each claim to source, primarily:
   - `packages/workspace/src/workspace.ts` (`Workspace`,
     `WorkspaceOptions`)
   - `packages/workspace/src/backends/cloudflare-container.ts` (the
     concrete sandbox/container backend)
   - `packages/workspace-fs/src/path.ts` (path canonicalization)
   - `packages/workspace-fs/src/errors.ts` (error codes)
   - `packages/workspace-fs/src/fs/{rm,mkdir,writeFile,symlink}.ts`
     (root / reserved-path behaviour)
   - `packages/workspace-fs/src/schema/{core,sync}.ts`
     (`ROOT_INODE`, `_vfs_mounts`)
   - `packages/wsd/src/cli/wsd.ts` (`MOUNT_POINT`, FUSE)
4. Recorded matches, partial matches, and drifts. Did not modify any
   source or doc files outside `docs/audits/`.

## Findings

| Claim (doc lines) | Status | Evidence | Notes | Tag |
| --- | --- | --- | --- | --- |
| "The workspace exposes a single absolute path namespace rooted at `/`." (lines 13–14) | ✅ Match | `packages/workspace-fs/src/path.ts:15-17` requires `path.startsWith("/")`; `packages/workspace-fs/src/schema/core.ts:5` defines `ROOT_INODE = 1`. | Absolute-path namespace is enforced consistently across FS helpers. | — |
| "By convention everything lives under `/workspace`, but the root is configurable — pass `root` to the `Workspace` constructor to anchor the tree somewhere else." (lines 14–17) | ❌ Drift | `packages/workspace/src/workspace.ts:25-39` defines `WorkspaceOptions` with `{ storage, backends, now? }` only. No `root` option exists. `/workspace` is hard-coded as the container's `MOUNT_POINT` in `packages/workspace/src/backends/cloudflare-container.ts:210`. | Doc invents a configurable host-side `root`. In code, `/workspace` is just the conventional container mount; the host-side VFS root is `/` (`ROOT_INODE`), not parameterized. | doc-fix |
| Constructor example `new Workspace({ storage, sandbox, sessionId, root })` (lines 19–24) | ❌ Drift | `packages/workspace/src/workspace.ts:25-39, 50-59`. Actual fields: `storage`, `backends`, optional `now`. There is no `sandbox` or `sessionId` field; sandbox wiring is hidden behind `backends: WorkspaceBackend[]` (e.g. `CloudflareContainerBackend`). | Entire example is wrong API-shape, not just the `root` field. | doc-fix |
| "Inside the sandbox container the same tree is mounted on the host filesystem at the same path via FUSE, so paths on both sides of the wire match byte-for-byte." (lines 15–18) | ⚠️ Partial | `packages/wsd/src/cli/wsd.ts:307-316` mounts via FUSE when `DISABLE_FUSE` is unset; however `packages/workspace/src/backends/cloudflare-container.ts:209-213` always sets `DISABLE_FUSE: "1"` for the Cloudflare container backend. | FUSE exists in `wsd` but is disabled by default in the only shipped backend. Doc is aspirational for the container case. | doc-fix |
| Tree diagram with `.agents`, `/workspace/project`, `/workspace/documentation`, etc. (lines 26–33) | ⚠️ Partial | No code seeds these paths. `initializeSchema` (`packages/workspace-fs/src/schema/index.ts`) creates only the root inode (`ROOT_INODE = 1`); even `/workspace` is not pre-created — see `packages/workspace-fs/src/fs/ls.test.ts:36` which calls `mkdir(db, "/workspace", …)` explicitly. | Pure illustration; the `.agents/skills` mount path has no special meaning in code. Fine if labeled as illustrative; misleading as written because of the "created automatically on first boot" sentence below. | doc-fix |
| "The root path is created automatically on first boot" (lines 35–36) | ❌ Drift | `packages/workspace-fs/src/schema/index.ts:42` seeds only `ROOT_INODE` (the VFS `/`). `/workspace` is not auto-created by `Workspace` or `initializeSchema`; tests create it manually. | If "root path" means `/workspace`, claim is false; if it means `/`, claim is trivially true but ambiguous. | doc-fix |
| "Absolute paths only. Every fs and shell call takes an absolute path… Relative paths are rejected with `EINVAL`." (lines 39–43) | ✅ Match | `packages/workspace-fs/src/path.ts:15-17` throws via `invalidPath(path, "must be absolute")`; `invalidPath` returns code `EINVAL` (`packages/workspace-fs/src/errors.ts:33-35`). | Shell side delegates to the same canonicalizer. | — |
| "Forward slashes. Paths are POSIX-style. Backslashes are not separators." (lines 44–45) | ✅ Match | `packages/workspace-fs/src/path.ts:24` splits on `"/"` only; backslashes are treated as ordinary name bytes. | Consistent with POSIX behavior. | — |
| "No trailing slash. `/workspace/foo` and `/workspace/foo/` are the same directory; the canonical form has no trailing slash. The root `/` is the one exception." (lines 46–48) | ✅ Match | `packages/workspace-fs/src/path.ts:24-44`: empty segments are skipped (`part === ""`), and the canonical form is `parts.length === 0 ? "/" : "/" + parts.join("/")`. Test: `packages/workspace-fs/src/path.test.ts:11-24`. | — | — |
| "Reserved root. `/` itself cannot be deleted (`EPERM`)." (lines 49–50) | ✅ Match | `packages/workspace-fs/src/fs/rm.ts:63-67` raises `EPERM` for `parts.length === 0`. Test: `packages/workspace-fs/src/fs/rm.test.ts:78-85`. Also `writeFile.ts:135-137` raises `EISDIR` on the root, and `symlink.ts:12-14` raises `EEXIST` on the root. | — | — |
| "Mount roots cannot be deleted either — remove the mount from `WorkspaceOptions` instead." (lines 51–52) | ❌ Drift | `WorkspaceOptions` (`packages/workspace/src/workspace.ts:25-39`) has no `mounts` field. No mount-root protection exists in `rm.ts`/`provider.ts`. The schema declares `_vfs_mounts` (`packages/workspace-fs/src/schema/sync.ts:23-25`) and a `mount_root` column on nodes (`packages/workspace-fs/src/schema/core.ts:18`), but nothing in `packages/` wires a host-side mount API to them. | Entire mount feature is unimplemented on the host facade. The doc's directive to remove a mount from `WorkspaceOptions` references an option that does not exist. | doc-fix |
| "Mount roots must be absolute and must not nest. A mount at `/workspace/a` and another at `/workspace/a/b` is rejected at construction." (lines 60–62) | ❌ Drift | No mount-construction validation in `packages/workspace/src/workspace.ts` or elsewhere — there is no construction-time mount list. | Aspirational; no code path enforces nesting. | doc-fix |
| "Read-only mounts (the default) reject all writes under their root with `EROFS`." (lines 63–64) | ❌ Drift | `EROFS` is declared in `packages/workspace-fs/src/errors.ts:10` but is never thrown anywhere under `packages/` (verified by grep — no production call site). No write-side mount enforcement. | Aspirational. | doc-fix |
| "Writes that originate from `shell.exec` under a read-only mount are silently dropped on the post-exec pull." (lines 65–66) | ❌ Drift | The post-exec pull (`packages/workspace/src/shell.ts:11-23`, `pullOnce` from `workspace-rpc/driver`) applies every entry it receives; no mount-aware filtering. | Tied to the missing mount feature. | doc-fix |
| Reserved-paths table — `/` row "VFS root. Never delete. Treat as read-only." (lines 70–71) | ✅ Match | See `rm.ts:63-67`, `writeFile.ts:135-137`, `symlink.ts:12-14`. | "Treat as read-only" is enforced for writes/symlinks/rm. | — |
| Reserved-paths table — "`root` (default `/workspace`) … Created automatically. Cannot be deleted." (lines 72–73) | ❌ Drift | No host-side `root` option (see earlier rows). `/workspace` is just a name used as the container `MOUNT_POINT`; it is not auto-created by the host workspace, and `rm` does not specially protect it — it would be treated like any user directory if it existed. | doc-fix |
| Reserved-paths table — "Mount roots cannot be deleted while the mount is configured." (line 74) | ❌ Drift | No mount API; no enforcement. See above. | doc-fix |
| Reserved-paths table — "`/tmp` (container only) … wiped on container restart." (line 75) | ⚠️ Partial | The Cloudflare container backend (`packages/workspace/src/backends/cloudflare-container.ts:204-213`) starts the container fresh with no persistent mount beyond what `wsd` exposes; outside the FUSE mount the filesystem is the container's. Not enforced/observable in `packages/` directly. | True by virtue of how containers work, but not a workspace-fs invariant. | doc-fix (clarify) |
| "Paths like `/workspace/.agents/skills` aren't reserved — they only exist because a mount was configured at that path." (lines 77–80) | ❌ Drift | No mount configuration exists; `.agents/skills` is just an ordinary path that no code creates. | Tied to the missing mount feature. | doc-fix |
| "When the workspace boots a sandbox container, the VFS is mounted at `MOUNT_POINT` (default `/workspace`) via FUSE." (lines 84–86) | ⚠️ Partial | `MOUNT_POINT` env var is read by `wsd` with default `/workspace` (`packages/wsd/src/cli/wsd.ts:24, 41`). FUSE mount happens unless `DISABLE_FUSE=1` (`wsd.ts:307-316`). The Cloudflare backend always sets `DISABLE_FUSE=1` (`cloudflare-container.ts:210-212`). | FUSE path is implemented in `wsd`; the only shipped backend disables it. Doc reads as if FUSE is the steady state for the container; reality is sync-over-RPC for that backend. | doc-fix |
| "Reads route through the FUSE driver to the in-container VFS mirror." (lines 87–88) | ⚠️ Partial | True only when FUSE is enabled (`packages/wsd/src/fuse/vfs.ts`). With `DISABLE_FUSE=1` the in-container filesystem is the host container FS, and reads go through `shell.exec`/sync. | doc-fix |
| "Writes are recorded as dirty in the mirror and pulled back to the DO after the next `exec()` completes, or whenever you explicitly call `workspace.pull()`. The matching `workspace.push()` flushes pending DO-side writes…" (lines 88–94) | ✅ Match (semantics) | `packages/workspace/src/workspace.ts:117-125` exposes `push()`/`pull()` calling `pushOnce`/`pullOnce`. `packages/workspace/src/shell.ts:11-23` brackets `exec` with the same. | The push/pull surface and bracketing exist. The "mirror"/"dirty" framing is implementation-leaky language about the sync model documented in 02. | — |
| "Container-local paths outside the mount (e.g. `/usr`, `/tmp`, `/app`) are the container's own filesystem and are not synced." (lines 94–96) | ✅ Match | The sync coalesce/driver paths operate strictly under the VFS; nothing under `/usr` etc. is enumerated. The DO has no access to the container's non-mounted filesystem. | — | — |

## Drift summary

- **Constructor API is wrong.** `WorkspaceOptions` is `{ storage,
  backends, now? }`, not `{ storage, sandbox, sessionId, root }`. The
  doc's example signature must be rewritten against
  `workspace.ts:25-39`.
- **No host-side `root` configurability.** `/workspace` is a string
  hard-coded as the container's `MOUNT_POINT`; on the DO side the VFS
  root is always `/` (`ROOT_INODE`). The doc's "configurable root"
  story is aspirational.
- **Mounts are entirely unimplemented on the host facade.** Schema
  scaffolding exists (`_vfs_mounts`, `nodes.mount_root`) but no
  `WorkspaceOptions.mounts`, no nesting check, no `EROFS` enforcement,
  no read-only mount drop on pull. Several whole sections of the doc
  (Mount roots, the `.agents/skills` example, two reserved-path rows)
  rest on this missing feature.
- **FUSE is the default in `wsd`, but the only host backend disables
  it.** Doc presents FUSE as the steady-state container view; in
  practice the Cloudflare container backend sets `DISABLE_FUSE=1`, so
  the in-container "mirror" is not a FUSE-backed VFS today.
- **Path semantics (absolute paths, POSIX `/`, no trailing slash, `/`
  cannot be deleted) all match the implementation.** These claims are
  faithful and well-tested.

## Recommendations

1. Replace the constructor example with the real signature:
   ```ts
   new Workspace({
     storage:  ctx.storage,
     backends: [new CloudflareContainerBackend({ … })],
   });
   ```
   And drop the `root` claim, or call out explicitly that the
   container mount point (default `/workspace`) is configured via the
   backend / `MOUNT_POINT` env var, not on the host `Workspace`.
2. Either implement mounts as designed or scope the doc to today's
   reality and move the mount sections behind a clear "Planned"
   heading. Currently the file presents unimplemented behaviour
   (`EROFS`, nesting rejection, mount-root deletion guard, read-only
   mount drop on pull) as if it were live.
3. Clarify the FUSE paragraph: in the Cloudflare container backend
   today, the in-container filesystem is the container's own FS and
   sync happens over RPC; FUSE exists in `wsd` and is the target end
   state but is not the default for shipped backends.
4. Remove or qualify "The root path is created automatically on first
   boot" — only `ROOT_INODE` (`/`) is seeded by `initializeSchema`;
   the conventional `/workspace` directory is not.
5. Keep the Conventions section (lines 38–52, except the mount-root
   bullet) — it is accurate and well-tested.

## Drifts where doc target still looks valuable

- **Reserved mount roots / nesting validation / `EROFS` on read-only
  mounts.** The intent is sound; the schema even pre-allocates a
  `_vfs_mounts` table and a `mount_root` column on `vfs_nodes`. This
  looks like a deliberate forward design, not accidental doc drift.
  Tag as `code-fix` if/when the mount feature lands.
- **Configurable container mount point.** `wsd` already honours
  `MOUNT_POINT`. Plumbing that through the Cloudflare backend (rather
  than hard-coding `/workspace` in `cloudflare-container.ts:210`) and
  exposing it as a `WorkspaceOptions`/backend option would close the
  gap with the doc cheaply. `code-fix`.
- **FUSE-by-default in the container backend.** The
  `DISABLE_FUSE: "1"` line in `cloudflare-container.ts:212` is the
  single thing standing between the doc's mental model and reality.
  Whether to flip that default is a `needs-decision` item (likely
  blocked on FUSE availability inside Cloudflare containers).
