# `@cloudflare/workspace`

Initial scaffold for the Cloudflare Workspace daemon CLI.

## `wsd`

`wsd` starts a small HTTP server on the port provided by the `PORT` environment variable. If `PORT` is not set, it defaults to `4567`.

```sh
PORT=4567 npx -p @cloudflare/workspace wsd
```

Current endpoints:

- `GET /health` returns `200 OK` with `ok`.
- `GET /` returns `200 OK` with an empty JSON object: `{}`.

This is only the initial scaffold. Workspace RPC, filesystem sync, and FUSE behavior are future work.

## Standalone release artifacts

Standalone binaries are built with `pkg` as release artifacts, not as files published in the npm package:

```sh
npm run build:bin --workspace=@cloudflare/workspace
```

The binaries are written to `artifacts/wsd/`:

- `wsd-linux-x64`
- `wsd-macos-x64`
- `wsd-macos-arm64`

Run a generated binary with `PORT` set:

```sh
PORT=4567 ./artifacts/wsd/wsd-linux-x64
curl http://127.0.0.1:4567/health
```
