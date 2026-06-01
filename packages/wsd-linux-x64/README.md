# @cloudflare/workspace-wsd-linux-x64

Prebuilt `wsd` binary for linux-x64. `wsd` is the workspace daemon
side of [`@cloudflare/workspace`](../workspace) — see [`docs/`](../../docs)
for the wire protocol and architecture.

The binary is a Node SEA (Single Executable Application). Everything
needed at runtime — the Node runtime, fuse-native, libfuse — is baked
in. The host needs `/dev/fuse` and a recent enough kernel for FUSE,
nothing else.

## Install

```sh
npm install @cloudflare/workspace-wsd-linux-x64
```

Adds `wsd` to `node_modules/.bin/`. On any host that isn't linux-x64
npm refuses the install via the package's `os` / `cpu` constraints —
that's intentional.

## Docker

The intended path. Multi-stage build pulls the binary from npm,
copies it into a minimal runtime image:

```dockerfile
FROM node:22-slim AS wsd
RUN npm install --no-save --omit=dev \
    @cloudflare/workspace-wsd-linux-x64@0.1.1

FROM debian:stable-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=wsd \
  /node_modules/@cloudflare/workspace-wsd-linux-x64/bin/wsd \
  /usr/local/bin/wsd

ENV PORT=8080 MOUNT_POINT=/workspace
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/wsd"]
```

No local SEA build, no binary staged into the build context. Pin the
version explicitly — `latest` is fine for experimentation but bites in
production when wire-protocol changes land.

## Configuration

`wsd` reads its config from environment variables. The interesting ones:

| var | default | meaning |
|---|---|---|
| `PORT` | `8080` | HTTP + WebSocket listener port. |
| `MOUNT_POINT` | `/workspace` | Path the FUSE filesystem mounts at. |
| `DISABLE_FUSE` | unset | Set to `1` to skip the FUSE mount. The HTTP / WS surfaces still come up; useful for testing in environments without `/dev/fuse`. |
| `UPSTREAM_URL` | unset | If set, wsd dials this WebSocket on boot and runs a bidirectional sync loop against it. |
