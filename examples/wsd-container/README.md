# wsd-container example

A Cloudflare Worker + Durable Object that boots a Container running
the `wsd` daemon and exposes a minimal `write` / `read` / `exec`
HTTP surface, modelled on the
[cloudflare/sandbox-sdk](https://github.com/cloudflare/sandbox-sdk)
bridge.

## Architecture

```
client ─► Worker /c/<name>/{file,exec}
             │  (DO RPC calls)
             ▼
       DO (ContainerExample) ──► Container ──► wsd (:8080)
             ▲                                  │
             │      ws://workspace.internal/ws  │
             └────────── capnweb session ◄──────┘
```

1. The DO constructs a `CloudflareContainerBackend` from
   `@cloudflare/workspace` and hands it to a `Workspace` instance.
   That backend owns the entire wsd lifecycle: container start,
   outbound egress interception, port-readiness polling, POST
   `/connect` to wsd, `/ws` upgrade routing, and capnweb session
   attach.
2. wsd reaches the Worker through the container's **outbound
   interception** (`ctx.container.interceptOutboundHttp("workspace.internal",
   …)`, set up by the backend). The DO passes
   `ctx.exports.WorkspaceProxy({ props: { binding, id } })` as the
   egress fetcher; that `WorkerEntrypoint` (re-exported from
   `@cloudflare/workspace`) routes `/ws` upgrades back to the owning DO.
3. When `Workspace.ready()` is called for the first time, the
   backend posts `/connect` into wsd with
   `{ url: "http://workspace.internal" }`. wsd polls
   `workspace.internal/health`, then dials
   `ws://workspace.internal/ws`.
4. `WorkspaceProxy.fetch` forwards the upgrade to the DO's `fetch()`
   via the DO binding looked up from its props. The DO's `fetch()`
   delegates to `backend.handleFetch(req)`, which performs the
   WebSocket upgrade, resolves the in-flight `connect()`, and
   attaches a capnweb client session to the server-side socket.
5. The DO exposes a single `getWorkspace()` RPC method that
   returns a `WorkspaceStub` (an `RpcTarget` wrapping the inner
   `Workspace`). The Worker's fetch handler calls
   `await stub.getWorkspace()` once per request and then drives
   `ws.fs.writeFile(...)` / `ws.fs.readFile(...)` /
   `ws.shell.exec(...)` directly. Promise pipelining keeps the
   nested-property pattern (`ws.fs.writeFile`) at one round trip.

The DO extends the plain `DurableObject` class from
`cloudflare:workers`. The container lifecycle plumbing all lives
in `CloudflareContainerBackend` — the DO is a thin host.

The container mounts wsd's VFS at `MOUNT_POINT` via FUSE, so
`exec`'d commands see the same tree the RPC surface reads and
writes. Cloudflare Containers expose `/dev/fuse` to the workload.
`wrangler dev` does not, so local runs need the Dockerfile patched
to set `DISABLE_FUSE=1` first; `exec` then runs against the
container's own root filesystem rather than the VFS.

## R2 mount

The DO mounts the `R2_HELLO` R2 bucket at `/workspace/r2` via
`R2Bucket(env.R2_HELLO)`. On the first call into the workspace the
mount indexer pages through the bucket, streams each object into
`vfs_nodes`, and from then on `/workspace/r2/<key>` reads like any
other file. The mount is read-only; writes under `/workspace/r2`
reject with `EROFS`.

Seed the bucket once with the bundled fixture (`./seed/r2-hello/hello.txt`,
which contains the bytes `hello world`):

```sh
# Local miniflare bucket — use this with `wrangler dev`.
npm run seed:r2:local --workspace @cloudflare/example-wsd-container

# Real Cloudflare R2 bucket — use this after `wrangler deploy`.
npm run seed:r2 --workspace @cloudflare/example-wsd-container
```

Then:

```sh
curl http://127.0.0.1:8787/c/demo/file/workspace/r2/hello.txt
# => hello world
```

## HTTP surface

```
PUT  /c/<name>/file/<path...>   raw body → wsd writeFile
GET  /c/<name>/file/<path...>   octet-stream of file bytes
POST /c/<name>/exec             { command | argv, cwd?, encoding? }
                                → JSON { exitCode, stdout, stderr }

```

`<name>` selects a DO instance; each gets its own container.

## Run it locally

Requires Docker.

```sh
# Boot the example. predev builds the wsd docker image
# (cloudflare/workspace-wsd-linux-x64:VERSION) so the example's
# Dockerfile can COPY --from it.
npm run dev --workspace @cloudflare/example-wsd-container
```

Smoke test:

```sh
# Trigger the container (first call also boots wsd + the capnweb session).
curl http://127.0.0.1:8787/c/demo/health

# Write a file
echo 'hello' | curl -X PUT --data-binary @- \
  http://127.0.0.1:8787/c/demo/file/hello.txt

# Read it back
curl http://127.0.0.1:8787/c/demo/file/hello.txt

# Exec a command
curl -X POST http://127.0.0.1:8787/c/demo/exec \
  -H 'content-type: application/json' \
  -d '{"command":"echo hi && uname -a","encoding":"utf8"}'
```

## Layout

```
examples/wsd-container/
  Dockerfile                debian + libfuse + wsd binary (ENTRYPOINT)
  wrangler.jsonc            Worker + DO + Container binding
  src/index.ts              Worker handler, DO (ContainerExample)
```

## Known limitations / next steps

- **Local `wrangler dev` won't run this image.** The container
  mounts FUSE on boot, which needs `/dev/fuse` plus CAP_SYS_ADMIN.
  Cloudflare Containers grant both to deployed workloads; the
  local container runtime `wrangler dev` shells out to does not,
  and there's no flag to opt in. wsd exits with a mount-permission
  error before `/health` ever comes up. To exercise the example
  end-to-end you have to `wrangler deploy` it. For local iteration
  on the *Worker* code, flip the Dockerfile to `DISABLE_FUSE=1`
  by hand — `exec` then runs against the container's local root
  rather than the VFS, but file reads and writes still go through
  the RPC surface.
- **Exec is run-and-collect, not streamed.** The handler awaits
  `handle.result()` and emits one JSON response. Live streaming needs
  the DO to expose an async-iterable RPC; v1 keeps the surface flat.
- **No auth.** The egress proxy trusts anything the container sends.
  Fine for in-DO traffic (only the owning Worker can address it),
  but the moment we expose `workspace.internal` more broadly we need
  a handshake.
- **One-shot session.** If wsd's WebSocket drops mid-session, the
  cached `BackendHandle` goes stale and the next call throws.
  `Workspace.ready()` will retry on the next call, but in-flight
  operations are lost. Transparent reconnect is Phase 5 R2
  deferred work.
