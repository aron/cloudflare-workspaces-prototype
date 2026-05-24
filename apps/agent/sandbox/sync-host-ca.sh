#!/usr/bin/env bash
# Stage the host's CA bundle into the Docker build context so the Sandbox
# image trusts the same roots as the host. Picks up TLS-intercepting proxies
# (Cloudflare WARP, Zscaler, corporate gateways) without committing any cert.
#
# Source precedence (first set wins): SSL_CERT_FILE, NODE_EXTRA_CA_CERTS,
# REQUESTS_CA_BUNDLE. If none are set, this is a no-op.
#
# The destination is gitignored (apps/agent/sandbox/*.crt) so the cert never
# leaves your machine. Safe to re-run.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="$here/host-ca.crt"

src="${SSL_CERT_FILE:-${NODE_EXTRA_CA_CERTS:-${REQUESTS_CA_BUNDLE:-}}}"

if [[ -z "$src" ]]; then
  echo "sync-host-ca: no SSL_CERT_FILE / NODE_EXTRA_CA_CERTS / REQUESTS_CA_BUNDLE set — skipping"
  rm -f "$dest"
  exit 0
fi

if [[ ! -r "$src" ]]; then
  echo "sync-host-ca: \$SSL_CERT_FILE='$src' is not readable" >&2
  exit 1
fi

cp "$src" "$dest"
echo "sync-host-ca: staged $src -> $dest"
