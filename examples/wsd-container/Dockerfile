# Container image for the wsd-container example.
#
# wsd ships as a single Node SEA binary on npm:
# @cloudflare/workspace-wsd-linux-x64. Pull it via a build stage,
# COPY into a minimal runtime image. No local SEA build, no binary
# staged into the build context.
#
# wsd mounts a FUSE filesystem at MOUNT_POINT so exec'd commands
# see the same VFS the RPC surface reads and writes. Cloudflare
# Containers expose /dev/fuse to the workload; locally,
# `wrangler dev` does not, so this image is intended for deploys.

FROM --platform=linux/amd64 node:22-slim AS wsd
RUN npm install --no-save --omit=dev \
    @cloudflare/workspace-wsd-linux-x64@0.1.0

FROM --platform=linux/amd64 debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=wsd \
  /node_modules/@cloudflare/workspace-wsd-linux-x64/bin/wsd \
  /usr/local/bin/wsd
RUN chmod +x /usr/local/bin/wsd

# wsd's defaults: HTTP+WS on :8080, FUSE mount on MOUNT_POINT.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/wsd"]
