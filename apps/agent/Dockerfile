# Sandbox container image for the agent.
#
# Replaces the prior `cloudflare/sandbox`-based image with the
# next-branch wsd daemon. The image bundles:
#
#   1. The prebuilt wsd SEA binary, pulled in from the
#      cloudflare/workspace-wsd-linux-x64 image (built locally by the
#      predeploy hook). wsd runs as PID 1 and serves the workspace
#      RPC + FUSE mount.
#   2. Project-specific build tools (zig, go, esbuild, wrangler)
#      under the FUSE-mounted /workspace, so `exec` calls from the
#      agent see them on PATH.
#
# Build context is the repo root (see wrangler.jsonc
# `image_build_context: "../.."`) so the COPY paths resolve against
# apps/agent/... — same as the old setup.

FROM --platform=linux/amd64 cloudflare/workspace-wsd-linux-x64:0.1.1 AS wsd

FROM --platform=linux/amd64 debian:stable-slim

# Base toolchain + FUSE runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git \
      fuse3 libfuse2t64 \
      build-essential \
      nodejs npm \
 && rm -rf /var/lib/apt/lists/*

# wsd binary. Statically linked SEA, no external deps needed.
COPY --from=wsd /usr/local/bin/wsd /usr/local/bin/wsd

# Project-specific toolchain. Mirrors the old sandbox image so the
# agent's `exec` tool finds the same compilers and CLIs on PATH.
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
ENV ZIG_LOCAL_CACHE_DIR=/tmp/zig-cache
ENV ZIG_GLOBAL_CACHE_DIR=/tmp/zig-cache

# Zig.
RUN ZIG_VERSION=0.13.0 && \
    curl -fsSL --cacert /etc/ssl/certs/ca-certificates.crt \
      https://ziglang.org/download/${ZIG_VERSION}/zig-linux-x86_64-${ZIG_VERSION}.tar.xz \
      | tar -xJ -C /usr/local && \
    ln -s /usr/local/zig-linux-x86_64-${ZIG_VERSION}/zig /usr/local/bin/zig

# TypeScript / Cloudflare Worker toolchain.
RUN npm install -g esbuild@0.25.0 wrangler@4

# Go.
ENV GOTOOLCHAIN=local
ENV GOPATH=/root/go
ENV PATH=$PATH:/usr/local/go/bin:/root/go/bin
RUN GO_VERSION=1.23.4 && \
    curl -fsSL --cacert /etc/ssl/certs/ca-certificates.crt \
      https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz \
      | tar -xz -C /usr/local && \
    /usr/local/go/bin/go version

# wsd configuration. PORT and MOUNT_POINT are the defaults the
# CloudflareContainerBackend expects. FUSE_SHIM=1 lets wsd run when
# /dev/fuse isn't passed through (wrangler dev on macOS, CI without
# CAP_SYS_ADMIN). Production Cloudflare Containers expose real FUSE
# and ignore the flag.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_SHIM=1
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/wsd"]
