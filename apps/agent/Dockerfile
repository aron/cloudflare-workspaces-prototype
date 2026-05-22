FROM --platform=linux/amd64 cloudflare/sandbox:0.9.2

# Install any user-supplied root CAs (sandbox/*.crt). Optional — see
# sandbox/README.md. The directory always exists (the README sits there),
# so this COPY never fails on a fresh checkout.
RUN apt-get update && apt-get install -y ca-certificates
COPY apps/agent/sandbox/ /tmp/sandbox-ctx/
RUN find /tmp/sandbox-ctx -maxdepth 1 -name '*.crt' -exec cp {} /usr/local/share/ca-certificates/ \; && \
    update-ca-certificates && \
    rm -rf /tmp/sandbox-ctx

# Workspace container-sandbox prerequisites: FUSE.
RUN apt-get install -y --no-install-recommends \
      fuse3 libfuse2 \
      build-essential xz-utils curl \
    && rm -rf /var/lib/apt/lists/*

# Workspace container-sandbox: copy the pre-built server + its runtime deps.
WORKDIR /app
COPY node_modules/@cloudflare/workspace/dist/ /app/workspace-dist/
RUN cp /app/workspace-dist/container-sandbox.cjs            /app/server.cjs && \
    cp /app/workspace-dist/container-sandbox.package.json   /app/package.json && \
    rm -rf /app/workspace-dist
RUN npm install --omit=dev

# ---- Project-specific toolchain ---------------------------------------------

ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
ENV ZIG_LOCAL_CACHE_DIR=/tmp/zig-cache
ENV ZIG_GLOBAL_CACHE_DIR=/tmp/zig-cache

RUN ZIG_VERSION=0.13.0 && \
    curl -fsSL --cacert /etc/ssl/certs/ca-certificates.crt \
      https://ziglang.org/download/${ZIG_VERSION}/zig-linux-x86_64-${ZIG_VERSION}.tar.xz \
      | tar -xJ -C /usr/local && \
    ln -s /usr/local/zig-linux-x86_64-${ZIG_VERSION}/zig /usr/local/bin/zig

# TypeScript / Cloudflare Worker toolchain.
RUN npm install -g esbuild@0.25.0 wrangler@4

# Go toolchain.
ENV GOTOOLCHAIN=local
ENV GOPATH=/root/go
ENV PATH=$PATH:/usr/local/go/bin:/root/go/bin
RUN GO_VERSION=1.23.4 && \
    curl -fsSL --cacert /etc/ssl/certs/ca-certificates.crt \
      https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz \
      | tar -xz -C /usr/local && \
    /usr/local/go/bin/go version

# Do NOT override the entrypoint — cloudflare/sandbox:0.9.2 runs
# /container-server/sandbox which starts the control plane on port 3000.
# The workspace server is started via startProcess() from Workspace.warmup().
EXPOSE 4567
