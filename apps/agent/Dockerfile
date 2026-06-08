# Sandbox container image for the agent.
#
# Pulls the prebuilt wsd SEA binary out of the public GHCR image
# published by github.com/cloudflare/workspace, pinned in lockstep
# with the `@cloudflare/workspace` npm dependency (see
# package.json). wsd runs as PID 1 and serves the workspace RPC +
# FUSE mount.
#
# Layered on top: project-specific build tools (zig, go, esbuild,
# wrangler) so `exec` calls from the agent find them on PATH inside
# the FUSE-mounted /workspace.

FROM --platform=linux/amd64 ghcr.io/cloudflare/workspace-wsd-linux-x64:0.0.0-alpha.5 AS wsd

FROM --platform=linux/amd64 debian:stable-slim

# Base toolchain + FUSE runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git \
      fuse3 libfuse2t64 \
      build-essential \
 && rm -rf /var/lib/apt/lists/*

# Optional WARP / corporate-MITM CA bundle.
#
# When the host runs behind Cloudflare WARP (or any other decrypting
# TLS proxy), the certificates the public CA bundle trusts are
# replaced with WARP's own roots. `curl`, `npm install`, etc. inside
# the build then fail with "unable to get local issuer certificate"
# the first time they touch an external HTTPS endpoint.
#
# The fix is to drop the WARP root bundle at `apps/agent/ca/warp-ca.crt`
# (gitignored — host-specific) before the build. The `ca/` directory
# itself is committed with a `.keep` so the `COPY` below always has
# at least one source; when no real CA file is present, the conditional
# `update-ca-certificates` is a no-op and the build behaves identically.
#
# Hosts without WARP just don't drop the file and pay zero cost.
COPY apps/agent/ca/ /opt/agent-ca/
RUN if ls /opt/agent-ca/*.crt >/dev/null 2>&1; then \
      cp /opt/agent-ca/*.crt /usr/local/share/ca-certificates/ \
      && update-ca-certificates ; \
    fi \
 && rm -rf /opt/agent-ca

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

# Node.js 22 + TypeScript / Cloudflare Worker toolchain.
# Debian's `nodejs` package version moves with the base image; install the
# official binary tarball so shells inside the workspace consistently see
# Node 22.
RUN NODE_VERSION=22.12.0 && \
    curl -fsSL --cacert /etc/ssl/certs/ca-certificates.crt \
      https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz \
      | tar -xJ -C /usr/local --strip-components=1 && \
    node --version && npm --version && \
    npm install -g esbuild@0.25.0 wrangler@4

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
# CloudflareContainerBackend expects. FUSE_MOUNT=auto probes
# /dev/fuse at startup: real FUSE under Cloudflare Containers,
# userspace shim when /dev/fuse isn't passed through (wrangler dev
# on macOS, CI without CAP_SYS_ADMIN). Same image works in both.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/wsd"]
