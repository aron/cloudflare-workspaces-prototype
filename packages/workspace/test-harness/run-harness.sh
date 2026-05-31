#!/usr/bin/env bash
# Wrapper that runs the docker harness vitest project end-to-end.
#
# - Boots the wsd container via run-wsd.sh, exporting the URL into
#   WSD_HARNESS_URL so the vitest config can wire it into the
#   worker's bindings.
# - Runs vitest against test-harness/vitest config.
# - Kills the container on any exit path, including SIGINT.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$HERE/.." && pwd)"

cleanup() {
  local cid="${WSD_HARNESS_CID:-}"
  if [[ -n "$cid" ]]; then
    docker kill "$cid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

# Skip when docker is unavailable. The harness vitest project
# also skips in that case; this keeps `npm run test:harness`
# from failing on contributors without Docker.
if ! docker info >/dev/null 2>&1; then
  echo "docker not available; skipping harness" >&2
  cd "$WORKSPACE_ROOT"
  exec npx vitest run --config vitest.config.harness.ts
fi

# Capture the container id from run-wsd.sh's stderr while
# letting the URL on stdout reach $WSD_HARNESS_URL.
STDERR_FILE="$(mktemp)"
trap 'rm -f "$STDERR_FILE"; cleanup' EXIT
WSD_HARNESS_URL="$("$HERE/run-wsd.sh" 2>"$STDERR_FILE")"
WSD_HARNESS_CID="$(grep -oE 'WSD_HARNESS_CID=[0-9a-f]+' "$STDERR_FILE" | head -1 | cut -d= -f2)"
export WSD_HARNESS_URL WSD_HARNESS_CID

echo "harness: wsd at $WSD_HARNESS_URL (container $WSD_HARNESS_CID)" >&2

cd "$WORKSPACE_ROOT"
npx vitest run --config vitest.config.harness.ts
