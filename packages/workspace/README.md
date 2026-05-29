# `@cloudflare/workspace`

Initial scaffold for the Cloudflare Workspace daemon CLI.

## `wsd`

`wsd` starts a FUSE-backed in-memory filesystem and an HTTP server. The HTTP server listens on the port provided by the `PORT` environment variable, defaulting to `4567`. The FUSE mount point is provided by `MOUNT_POINT`, defaulting to `/workspace`.

```sh
PORT=4567 MOUNT_POINT=/tmp/workspace npx -p @cloudflare/workspace wsd
```

Current endpoints:

- `GET /health` returns `200 OK` with `ok` once the FUSE mount is ready.
- `GET /` returns `200 OK` with an empty JSON object: `{}`.

Current filesystem support:

- In-memory directories and regular files.
- Basic file operations: create, read, write, truncate, rename, unlink, mkdir, rmdir, readdir, stat, chmod, and statfs.
- No persistence, WebSocket/RPC, or host/DO synchronization yet.

## FUSE prerequisites

Linux hosts/containers need access to `/dev/fuse` and mount permissions. macOS hosts need macFUSE installed.

If FUSE is unavailable, `wsd` exits non-zero rather than falling back to a plain directory.

## Standalone release artifacts

Standalone binaries are built with `pkg` as release artifacts, not as files published in the npm package:

```sh
npm run build:bin --workspace=@cloudflare/workspace
```

The binary build includes `fuse-native` prebuild assets via the root `pkg.assets` config. The initial targets are:

- `wsd-linux-x64`
- `wsd-macos-x64`

The binaries are written to `artifacts/wsd/`.

Run a generated Linux binary with `PORT` and `MOUNT_POINT` set:

```sh
mkdir -p /tmp/wsd-workspace
PORT=4567 MOUNT_POINT=/tmp/wsd-workspace ./artifacts/wsd/wsd-linux-x64
curl http://127.0.0.1:4567/health
```

macOS binaries produced from Linux are not signed. Before distribution, sign them on macOS or install `ldid` in the build environment. macOS arm64 is not currently emitted because the installed `fuse-native` package only includes x64 prebuilds in this environment.
