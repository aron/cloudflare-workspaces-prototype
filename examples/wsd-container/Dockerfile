# Container image for the wsd-container example.
#
# wsd is a single Node SEA binary produced by
# `npm run build:bin --workspace @cloudflare/workspace-wsd`. The
# example's predev/predeploy hook stages it into ./build/wsd-linux-x64
# so the image build context stays small and self-contained.
#
# Cloudflare Containers do not expose /dev/fuse today, so we run wsd
# with DISABLE_FUSE=1 and only exercise the capnweb RPC surface
# (/health, /api, /ws). libfuse is still installed so the image is
# ready the moment FUSE access lands on the platform — flipping the
# env var off is the only change needed.

FROM --platform=linux/amd64 debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY build/wsd-linux-x64 /usr/local/bin/wsd
RUN chmod +x /usr/local/bin/wsd

# wsd's defaults: HTTP+WS on :8080. MOUNT_POINT is ignored when
# DISABLE_FUSE=1 but we set it anyway so the startup log line is
# consistent across environments.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV DISABLE_FUSE=1
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/wsd"]
