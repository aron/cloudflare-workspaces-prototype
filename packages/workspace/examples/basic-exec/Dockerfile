# Build context is the monorepo root (see wrangler.jsonc → image_build_context).
FROM --platform=linux/amd64 cloudflare/sandbox:0.9.3

# Workspace container-sandbox needs FUSE.
RUN apt-get update && apt-get install -y --no-install-recommends \
      fuse3 libfuse2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pre-built workspace server (FUSE + capnweb + the HTTP /exec route) plus
# its runtime deps. The Workspace class starts this via startProcess() on
# the first exec()/warmup() call.
WORKDIR /app
COPY packages/workspace/dist/container-sandbox.cjs            ./server.cjs
COPY packages/workspace/dist/container-sandbox.package.json   ./package.json
RUN npm install --omit=dev

# The control plane on port 3000 (provided by cloudflare/sandbox) is what
# Worker code reaches via getSandbox(). The workspace server itself listens
# on 4567 inside the container; we don't expose that to the outside world.
EXPOSE 4567
