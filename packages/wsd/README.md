# `@cloudflare/workspace-wsd`

Workspace daemon CLI and FUSE mount package.

## `wsd`

`wsd` starts a FUSE-backed virtual filesystem and an HTTP server. The filesystem is backed by `node-vfs-polyfill`, while the FUSE mount is provided by `fuse-native`.

The HTTP server listens on the port provided by the `PORT` environment variable, defaulting to `4567`. The FUSE mount point is provided by `MOUNT_POINT`, defaulting to `/workspace`.

```sh
PORT=4567 MOUNT_POINT=/tmp/workspace npx -p @cloudflare/workspace-wsd wsd
```

Current endpoints:

- `GET /health` returns `200 OK` with `ok` once the FUSE mount is ready.
- `GET /` returns `200 OK` with an empty JSON object: `{}`.

Current filesystem support:

- `node-vfs-polyfill` in-memory filesystem.
- FUSE operation adapter covering the full `fuse-native` operation surface.
- Unsupported FUSE operations intentionally throw `NotImplementedError` for visibility.
- No persistence, WebSocket/RPC, or host/DO synchronization yet.

## FUSE prerequisites

Linux hosts/containers need access to `/dev/fuse` and mount permissions. macOS hosts need macFUSE installed.

If FUSE is unavailable, `wsd` exits non-zero rather than falling back to a plain directory.

## Tests

Tests live next to the source files and are written in TypeScript. Run them with Node's built-in TypeScript stripping support:

```sh
npm test --workspace=@cloudflare/workspace-wsd
```

This package requires Node.js 22+ because `node-vfs-polyfill` requires Node.js 22+.

## Standalone release artifacts

Standalone binaries are release artifacts, not files published in the npm package:

```sh
npm run build:bin --workspace=@cloudflare/workspace-wsd
```

The binary build includes native `fuse-native` prebuild assets and `node-vfs-polyfill` assets via the root `pkg.assets` config. If `pkg` cannot produce a Node 22-compatible artifact, npm execution is the supported path until the binary build is updated.
