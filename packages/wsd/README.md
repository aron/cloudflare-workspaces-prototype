# `@cloudflare/workspace-wsd`

Workspace daemon CLI and FUSE mount package.

## `wsd`

`wsd` starts a FUSE-backed virtual filesystem and an HTTP server. The filesystem is backed by `@platformatic/vfs`, while the FUSE mount is provided by `fuse-native`.

The HTTP server listens on the port provided by the `PORT` environment variable, defaulting to `45678`. The FUSE mount point is provided by `MOUNT_POINT`, defaulting to `/workspace`.

```sh
PORT=45678 MOUNT_POINT=/tmp/workspace npx -p @cloudflare/workspace-wsd wsd
```

Current endpoints:

- `GET /health` returns `200 OK` with `ok\n` once the HTTP server is up (it does not currently block on FUSE readiness).
- `GET /__wsd/info` returns JSON with the selected FUSE backend, mount point, and bound port.
- `GET /` returns `200 OK` with an empty JSON object: `{}`.
- `POST /api` is a capnweb HTTP-batch RPC endpoint backed by `@cloudflare/workspace-rpc`. Non-POST methods return `405`.
- `GET /ws` upgrades to a WebSocket carrying the same capnweb RPC surface. This is the container's primary sync carrier.

All other paths and methods return `404`/`405` with a `text/plain` body.

Current filesystem support:

- `@platformatic/vfs` in-memory filesystem provided by `@cloudflare/dofs`'s node provider.
- FUSE operation adapter covering the full `fuse-native` operation surface.
- Unsupported FUSE operations return `ENOSYS` to the kernel; the binding logs a one-shot warning per operation.
- capnweb RPC over `/api` and `/ws` exposes the workspace database and an `exec` runner to clients.
- Optional host/DO synchronization: when `UPSTREAM_URL` is set, `wsd` opens a `SyncClient` from `@cloudflare/workspace-rpc/client` against that URL and runs the sync loop in the background.
- No on-disk persistence yet — the in-memory VFS is rebuilt on each start, with sync pulling state back from the upstream when configured.

## FUSE buffer flushing

The FUSE driver in `src/fuse/driver.ts` keeps a per-file in-memory
buffer (`files` Map) that `write` updates directly. The buffer is
the FUSE read path's source of truth, so reads stay fast even when
the backing `@platformatic/vfs` filesystem would otherwise need to
stream chunks from SQLite.

Writes only become visible through the VFS surface (capnweb sync,
any host-side `@platformatic/vfs` consumer) once the driver spills
the buffer:

- `release` — fires when the kernel drops the last reference to an
  open file. The standard "close-and-forget" path.
- `flush` — fires on every `close(2)`, before `release`. Catches the
  case where one process closes its handle while another keeps the
  file open.
- `fsync(2)` — explicit user-driven sync.

Plain `write` does not spill. A burst of small writes coalesces in
the buffer and pays the chunk/hash cost once on close.

If you're tracking down "file looks empty over RPC" symptoms,
either the writer skipped `close(2)`/`fsync`, or one of the spill
ops is broken. The driver's `flushEntry` helper is the single place
VFS spills happen — a missing call site there is the most likely
cause.

## FUSE prerequisites

Linux hosts/containers need access to `/dev/fuse` and mount permissions.

### macOS: macFUSE

Install macFUSE. On Apple Silicon, macFUSE may require Reduced
Security / kernel extension approval. FUSE-T is intentionally
unsupported — the libfuse2 surface our `fuse-native` dependency
wraps does not work against the FUSE-T userland.

You can override backend detection for debugging:

```sh
WSD_FUSE_BACKEND=auto    # default: detect macFUSE on macOS, /dev/fuse on linux
WSD_FUSE_BACKEND=macfuse # require macFUSE
WSD_FUSE_BACKEND=linux   # require /dev/fuse
```

Additional environment variables:

```sh
DISABLE_FUSE=1                   # skip the FUSE mount; keep HTTP + RPC running
UPSTREAM_URL=https://example/ws  # open a SyncClient against this capnweb endpoint
EXEC_LOG_MAX_BYTES=1048576       # cap the in-memory exec log buffer (bytes)
```

If FUSE is unavailable, `wsd` exits non-zero rather than falling back to a plain directory. Set `DISABLE_FUSE=1` to skip the FUSE mount entirely while keeping the HTTP server and `/api` + `/ws` RPC endpoints alive — handy for tests and tooling that don't need `/dev/fuse`.

## Tests

Tests live next to the source files and are written in TypeScript. The package test script builds first, then runs Node's experimental TypeScript stripping:

```sh
npm test --workspace=@cloudflare/workspace-wsd
```

This package requires Node.js 22+ because `@platformatic/vfs` does, and because the test script uses `--experimental-strip-types`, which is only available on Node 22+ (unflagged on 23.6+).

## Standalone release artifacts

Standalone binaries are release artifacts, not files published in the npm package:

```sh
npm run build:bin --workspace=@cloudflare/workspace-wsd
```

The binary is produced with Node's Single Executable Application (SEA) feature: `scripts/build-bin.mjs` bundles the CLI with `esbuild`, generates a SEA blob via `node --experimental-sea-config`, downloads the target's Node binary, and injects the blob with `postject`. macOS targets are stripped and re-signed ad-hoc. `fuse-native` prebuilds and `libfuse` are embedded as SEA assets per target. See `PLAN.md` Phase 3 for the full migration notes.
