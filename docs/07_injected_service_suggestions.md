# 07. Injected Service — Suggestions

Proposals against `07_injected_service.md`.

## 1. Move off in-memory VFS to a disk-backed mirror (high leverage)

**Problem.** The container-side VFS is in-memory. The advertised
"10 GB" workspace ceiling is really `min(10 GB, container RAM)`.
`node_modules` is on the default ignore list precisely because the
bytes still live in container memory even though they do not cross
the wire.

**Proposal.** Replace the in-memory VFS with a write-through to a
container-local scratch directory (tmpfs if RAM is plentiful,
overlay-on-disk otherwise). FUSE keeps arbitrating reads/writes for
dirty tracking — what changes is where the bytes live. The dirty set
becomes a list of changed paths plus a small in-memory index;
content is read from disk on `pullDirty`.

Knock-on effects:

- `pullIgnore` becomes about **wire cost**, not **memory cost**.
- Container restart goes from "always cold" to "warm if the scratch
  volume survives," which on Cloudflare Containers it usually does.
- Crash-atomicity (see `02_suggestions.md` item 6) needs an answer
  because partial bytes can survive — a staging-dir-then-rename or
  WAL pattern works.

## 2. Replace FUSE with virtiofs / 9p (long-term)

**Problem.** FUSE adds an order of magnitude to metadata-heavy
syscalls (`stat`, `readdir`, `open`) — the README acknowledges this.
It also requires `libfuse2` + `fuse3` packages in every user image
and runs at user-mode-roundtrip cost for every operation.

**Proposal.** On runtimes that support it (Firecracker — what
Cloudflare Containers runs on), mount the workspace tree via
**virtiofs** from a host-side workspace-server process. The guest
sees a real kernel filesystem. The workspace-server runs on the
host where it has direct access to the underlying tree, no FUSE
process inside the container.

Fallbacks:

- **9p over virtio** if virtiofs isn't available.
- **FUSE** as today for providers that expose neither.

This is a multi-quarter change and worth treating as a roadmap item
rather than a near-term ship. The doc already gestures at being
provider-agnostic; making "which mount transport" part of the
provider abstraction sets it up.

## 3. Bind-mount + inotify as a near-term FUSE replacement

**Problem.** Same as (2) but virtiofs/9p is far away.

**Proposal.** Have the workspace-server write into a real directory
inside the container and bind-mount that directory at the workspace
root. Use `fanotify` (or `inotify` recursive watches) for dirty
tracking. Loses the elegant "FUSE intercepts everything" model but
gains:

- No `libfuse` install.
- Near-native `stat`/`readdir`/`open` performance.
- The "FUSE refused to mount → fallback to host filesystem" branch
  becomes the only branch, simpler.

The hard part is lazy-stub materialization on first read.
Workable approach: stubs are zero-byte files marked with an xattr;
an open of one triggers a synchronous fetch via a small `LD_PRELOAD`
shim or via an `open()` watcher on `fanotify` permission events.

Prototype-worthy. Specify the perf delta against FUSE before
committing.

## 4. Self-contained binary instead of `ws.js`

**Problem.** `ws.js` requires a Node runtime in the user image —
implicit ~50 MB, plus version-skew risk.

**Proposal.** Ship `ws` as a single statically-linked binary built
with Bun's `--compile`, or `pkg`/`nexe` for Node, or rewrite the hot
parts in Rust/Go and link them with a thin JS surface.

The doc already plans for this. Concrete acceptance criteria:

- One binary per supported arch (`linux/amd64`, `linux/arm64`).
- Published from the same image (`cloudflare/workspace:latest`) under
  `/app/ws` so the Dockerfile snippet becomes `COPY --from=workspace
  /app/ws /usr/local/bin/ws`.
- No runtime deps other than `fuse3` (and even that goes away under
  proposals 2 or 3).

## 5. Resolve the connection-auth open question

**Problem.** The RPC port trusts anything that can reach it. Safe on
Cloudflare Containers today, footgun the moment a user maps the port
out, or on future providers with broader network exposure.

**Proposal.** Shared-secret handshake, minimum viable:

1. On `startProcess`, the DO mints a 256-bit token and passes it via
   env (`WORKSPACE_AUTH_TOKEN`).
2. The first frame after WS upgrade is `{ token }`. Mismatch → close
   with a clean error code.
3. After the hello, the existing capnweb bootstrap proceeds.

Combine with the version handshake from `02_suggestions.md` item 8 —
they share a single hello frame.

mTLS is overkill for the v1; a per-boot token closes the gap.

## 6. Resolve the process-user open question

**Problem.** `ws.js` runs as whatever the image's `ENTRYPOINT` user is
— usually `root`. `exec`'d commands inherit. Defense-in-depth is
weak.

**Proposal.**

- The published image creates a `workspace` user (UID 1000) and group.
- `ws` runs as `workspace`.
- FUSE is mounted with `allow_other` so exec'd commands (also run as
  `workspace`, in the default case) can read and write.
- A per-exec option `runAs?: "workspace" | "root" | { uid, gid }`
  lets callers opt into root when they really need it (apt-get during
  setup, etc.) — explicit, not default.

Sandbox isolation is still the container boundary; this is purely
hardening.

## 7. Bounded dirty buffer with backpressure

**Problem.** A long-running exec writing faster than the DO can pull
grows the dirty set unboundedly. In-memory VFS today turns this into
OOM.

**Proposal.** Soft cap (configurable, default 256 MiB of pending
bytes or 100k paths). Above the cap:

- FUSE write replies are delayed (real backpressure into the writer).
- The server opportunistically pushes to the DO out-of-band rather
  than waiting for the post-exec pull.

Compose with (1): once bytes live on disk the byte cap matters less
than the path-count cap, but both still need limits.

## 8. Health endpoint carries version + capabilities

**Problem.** `/healthz` returns `200` and nothing else. The DO has
no way to learn what the container can do without a successful WS
upgrade.

**Proposal.**

```http
GET /healthz
200 OK
{
  "ready": true,
  "fuseActive": true,
  "protocolVersion": 3,
  "build": "ws-2026.04.17",
  "mountPoint": "/workspace"
}
```

Lets the DO refuse mismatched versions before opening a session, and
surfaces `fuseActive=false` as a structured signal rather than a
silent perf cliff.

## 9. Logging discipline

**Problem.** `LOG_FILE` defaults to `/tmp/server.log`. That's invisible
to the host; on a crash there's no way to retrieve it after the
container is reaped.

**Proposal.** Add an optional log-forwarding RPC: the workspace-server
buffers structured log records and the DO drains them on each pull.
On crash, the last N records are kept in memory and re-sent on
reconnect via a small `getRecentLogs()` call. Cheap, makes triage
real.

## Suggested ordering

1. (5) Auth handshake + (8) version on `/healthz` — small, closes
   real risks.
2. (6) Drop root by default — security hardening.
3. (7) Bounded dirty buffer — correctness under load.
4. (4) Self-contained binary — UX, kills Node-version support tickets.
5. (1) Disk-backed mirror — the structural change that lifts the
   memory ceiling.
6. (3) Bind-mount + inotify — prototype against (1) for perf.
7. (2) virtiofs/9p — long-term destination.
8. (9) Log forwarding — opportunistic.
