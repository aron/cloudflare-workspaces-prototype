# Container image for the wsd-container example.
#
# Pulls the wsd binary from the `cloudflare/workspace-wsd-linux-x64`
# docker image — built locally via the example's predev / predeploy
# hooks, or pulled from a registry once published. Docker's image
# resolution prefers a local tag when one is present, so both paths
# use the same Dockerfile.
#
# wsd mounts a FUSE filesystem at MOUNT_POINT so exec'd commands
# see the same VFS the RPC surface reads and writes. Cloudflare
# Containers expose /dev/fuse to the workload; locally,
# `wrangler dev` does not, so this image is intended for deploys.

FROM --platform=linux/amd64 cloudflare/workspace-wsd-linux-x64:0.1.0-alpha.1 AS wsd

FROM --platform=linux/amd64 debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=wsd /usr/local/bin/wsd /usr/local/bin/wsd

# wsd's defaults: HTTP+WS on :8080, FUSE mount on MOUNT_POINT.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/wsd"]
