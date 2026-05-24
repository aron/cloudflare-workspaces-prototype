# Sandbox build helpers

This directory is copied into the Docker build context.

## Optional: corporate / WARP root CA

If you're behind a TLS-intercepting proxy (Cloudflare WARP with the certificate
override, Zscaler, a corporate egress gateway, etc.), the Zig tarball download
in the Dockerfile will fail with a certificate verification error.
### Automatic (recommended)

`npm run deploy` runs `sandbox/sync-host-ca.sh` as part of `predeploy`. It copies
the bundle from `$SSL_CERT_FILE` (or `$NODE_EXTRA_CA_CERTS` / `$REQUESTS_CA_BUNDLE`)
into `sandbox/host-ca.crt` so the Docker build trusts the same roots as your host.
If none of those env vars are set, the script is a no-op and the build proceeds
with the standard system trust store.

The staged file is gitignored (`apps/agent/sandbox/*.crt`) so the cert never
leaves your machine.

### Manual

Drop any root CA into this directory as a `.crt` file (PEM). The build copies
every `*.crt` and installs them via `update-ca-certificates`:

```
sandbox/your-root-ca.crt
```

Multiple files are fine. None are required — if the directory only contains
this README and the helper script, the build uses the default trust store.
