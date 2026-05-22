# Sandbox build helpers

This directory is copied into the Docker build context.

## Optional: corporate / WARP root CA

If you're behind a TLS-intercepting proxy (Cloudflare WARP with the certificate
override, Zscaler, a corporate egress gateway, etc.), the Zig tarball download
in the Dockerfile will fail with a certificate verification error.

Drop your root CA into this directory as a `.crt` file (PEM, single cert) and
the Docker build will install it via `update-ca-certificates`:

```
sandbox/your-root-ca.crt
```

The build copies every `*.crt` in this directory, so any name works. Multiple
files are fine too. None are required — if the directory only contains this
README, the build proceeds with the standard system trust store.
