# 07. Injected Service

The "injected service" is the workspace-server process that runs *inside*
the sandbox container. It owns the FUSE mount, the in-container VFS
mirror, and the capnweb RPC endpoint the DO talks to.

The package ships it as a single pre-built script — `ws.js` — that you
copy into your container image. The script needs a Node.js runtime
present in the image to execute; future versions will look at packaging
it as a self-contained binary so that requirement goes away.

## Responsibilities

1. **FUSE mount.** Mounts the in-container VFS at the configured
   workspace root (override with `MOUNT_POINT`) so any tool that runs
   inside the container — node, shells, compilers — sees the same tree
   the DO sees, with the same paths.
2. **Dirty tracking.** Every write that flows through FUSE is recorded
   in the VFS mirror with a fresh container-side revision. The pull RPCs
   serve those revisions back to the DO.
3. **Exec.** Runs shell commands and streams stdout/stderr back over
   capnweb. See [05. Shell Interface](./05_shell_interface.md).
4. **Apply.** Accepts changes pushed by the DO and writes them into the
   mirror, suppressing its own dirty-tracking so deletes don't bounce
   back.
5. **Health.** Exposes a small HTTP health endpoint so the host-side
   workspace can poll for readiness before opening the RPC connection.

## Installing into your sandbox image

The simplest path is to copy `ws.js` out of the published
`cloudflare/workspace` image in a multi-stage build:

```dockerfile
# Stage 1: pull the pre-built workspace server out of the published image.
FROM cloudflare/workspace:latest AS workspace

# Stage 2: your sandbox image. Anything Node-capable will do.
FROM cloudflare/sandbox:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
      fuse3 libfuse2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=workspace /app/ws.js ./ws.js

# ...your own tools below (compilers, runtimes, etc.)

EXPOSE 4567
```

Requirements on the target image:

- A Node.js runtime on `PATH` (the script is executed via `node /app/ws.js`).
- `fuse3` and `libfuse2` available at runtime for the FUSE mount.

That's the whole install surface — no `npm install`, no
`package.json`, no native build step.

## Boot sequence

Bootstrapping the service is the same shape regardless of which sandbox
provider hosts the container:

1. **Start the binary.** The host-side workspace asks its sandbox
   provider to launch `ws.js` as a long-lived process.
2. **Poll the health endpoint.** The host polls `GET /healthz` on the
   workspace-server port (default 4567) until it answers `200`. This is
   the readiness signal — the FUSE mount and RPC listener are both up
   by the time `/healthz` returns OK.
3. **Open the capnweb session.** The host issues a WebSocket upgrade to
   `/rpc` (same port) and bootstraps a capnweb session against the
   server's `ContainerRPC` stub.

These three steps are deliberately provider-agnostic so the workspace
can target multiple sandbox runtimes over time (Cloudflare Containers
today, others in future).

### Cloudflare Containers specifics

On `@cloudflare/sandbox`, each step has a concrete implementation:

1. **Start.** The workspace looks for an existing
   `workspace-server` process via `getProcess()`. If a `running` or
   `starting` record exists it's reused; otherwise it
   `startProcess("node /app/ws.js", { processId: "workspace-server" })`.
2. **Poll.** `containerFetch(req, port)` against the workspace-server
   port acts as the health probe. The first `200` ends the wait.
3. **Connect.** A WS-upgrade `containerFetch` opens the WebSocket; the
   capnweb session is wired through a deferred transport so queued
   sends flush as soon as the upgrade resolves.

The startup logic has to defend against a few sharp edges specific to
the sandbox SDK — stale `failed` process records, concurrent warmup
races, and DO restarts where the server is still up from a previous
incarnation. See `src/container-startup.ts` for the failure modes and
the recovery paths.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4567` | Port the HTTP/WS server listens on (health + RPC). |
| `MOUNT_POINT` | `/workspace` | Absolute path inside the container to mount the FUSE filesystem at. |
| `LOG_FILE` | `/tmp/server.log` | Where the server writes its log. Stdout is reserved for the sandbox SDK's process events. |

## Failure handling

- `uncaughtException` and `unhandledRejection` log to `LOG_FILE` and
  `process.exit(1)`. The sandbox provider restarts the process record;
  the DO detects the dropped WebSocket and rebuilds on the next call.
- If FUSE refuses to mount, the server still starts but with
  `fuseActive=false`. Container-side writes are mirrored to the host
  filesystem so exec'd commands still see consistent data.

## Lifetime

The server outlives DO restarts. The sandbox container is reaped only
when its lifetime policy says so; the workspace-server process runs for
the full container lifetime and serves every reconnect from the DO over
the same in-memory VFS.

## Open questions

These behaviours aren't fully specified yet. File an issue if your use
case depends on a particular resolution.

- **Connection auth.** Today the WebSocket endpoint trusts anything
  that can reach the port. On `@cloudflare/sandbox` that's safe because
  only the owning Worker can `containerFetch` into the container, but
  the moment we support sandbox providers with broader network exposure
  the server needs its own auth on the RPC handshake. Candidates: a
  short-lived shared secret minted by the workspace on `startProcess`
  and passed via an env var, a per-connection challenge, or an mTLS
  client cert provisioned at boot. The wire surface
  ([08. Capnweb Interface](./08_capnweb_interface.md)) will need a
  hello/auth phase before the bootstrap stub is exposed.
- **Process user and file ownership.** The server currently runs as
  whatever user the sandbox image's `ENTRYPOINT` runs as — typically
  `root`, which is a poor default for a process that mounts FUSE and
  spawns arbitrary shell commands. The intent is to run `ws.js` as an
  unprivileged user so a misbehaving exec can't escalate, *but* exec'd
  commands need to be able to read and write the FUSE-mounted tree.
  Open: which user owns the mount, what user `exec` runs as
  (`workspace`? per-exec dynamic?), and how `allow_other` / setuid /
  shared-group ownership get wired so the two see the same files
  without opening the mount to every process in the container.
