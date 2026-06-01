#!/usr/bin/env bash
# Non-interactive harness for ./script/shell that runs fs-bench.
# Mount the wsd binary, fs-bench, and this script into a debian
# container, then invoke this as the entrypoint. wsd runs in the
# background; fs-bench is executed against the FUSE mount with a
# /tmp/baseline directory for the wsd-vs-native comparison; the
# wsd process is shut down before the script exits with
# fs-bench's status code.
#
# Mirrors run-fs-tests.sh; differs only in that fs-bench needs
# npm + git for the language-tool scenarios. go is still skipped
# because it's not in debian:stable-slim's apt and pulling the
# binary release would bloat the bootstrap time.
set -u
apt-get update >/dev/null 2>&1
apt-get install -y --no-install-recommends fuse3 libfuse2t64 attr util-linux coreutils findutils git ca-certificates curl npm >/dev/null 2>&1

mkdir -p /tmp/workspace
PORT=45678 MOUNT_POINT=/tmp/workspace /usr/local/bin/wsd >/tmp/wsd.log 2>&1 &
WSD_PID=$!

for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:45678/health >/dev/null 2>&1; then
    echo "wsd ready after ${i}s"
    break
  fi
  sleep 1
done

if ! kill -0 "$WSD_PID" 2>/dev/null; then
  echo "wsd died:"
  cat /tmp/wsd.log
  exit 1
fi

MOUNT=/tmp/workspace BASE=/tmp/baseline /usr/local/bin/fs-bench
status=$?

kill "$WSD_PID" 2>/dev/null
wait "$WSD_PID" 2>/dev/null
exit $status
