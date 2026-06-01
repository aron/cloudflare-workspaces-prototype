# Container image for the wsd-container example.
#
# wsd is a single Node SEA binary produced by
# `npm run build:bin --workspace @cloudflare/workspace-wsd`. The
# example's predev/predeploy hook stages it into ./build/wsd-linux-x64
# so the image build context stays small and self-contained.
#
# wsd mounts a FUSE filesystem at MOUNT_POINT so exec'd commands
# see the same VFS the RPC surface reads and writes. Cloudflare
# Containers expose /dev/fuse to the workload; locally,
# `wrangler dev` does not, so this image is intended for deploys.

FROM --platform=linux/amd64 debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY build/wsd-linux-x64 /usr/local/bin/wsd
RUN chmod +x /usr/local/bin/wsd

# wsd's defaults: HTTP+WS on :8080, FUSE mount on MOUNT_POINT.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/wsd"]
