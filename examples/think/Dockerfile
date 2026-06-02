# Container image for the think example. Identical wiring to
# examples/wsd-container — we pull a wsd binary from the
# cloudflare/workspace-wsd-linux-x64 image staged by the predev /
# predeploy hooks, drop it into a slim debian, and run it as PID 1.
#
# wsd mounts a FUSE filesystem at MOUNT_POINT so exec'd commands
# (git, npm, vitest, …) see the same files the Workspace RPC
# surface reads and writes.

FROM --platform=linux/amd64 cloudflare/workspace-wsd-linux-x64:0.1.1 AS wsd

FROM --platform=linux/amd64 debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

COPY --from=wsd /usr/local/bin/wsd /usr/local/bin/wsd

ENV PORT=8080
ENV MOUNT_POINT=/workspace
# FUSE_SHIM=1 lets wsd run without /dev/fuse — required when the
# container host can't expose the FUSE device (e.g. wrangler dev on
# any platform that doesn't pass through /dev/fuse, or a sandbox
# without CAP_SYS_ADMIN). In production on Cloudflare Containers the
# real FUSE mount works; this flag is for local iteration only.
ENV FUSE_SHIM=1
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/wsd"]
