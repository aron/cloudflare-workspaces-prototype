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
       DO (WsdContainer) ──► Container ──► wsd (:8080)
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
   …)`, set up by the backend). The DO supplies a `WsdEgress`
   `WorkerEntrypoint` instance with its own id in props; the
   entrypoint routes `/ws` upgrades back to the owning DO.
3. When `Workspace.ready()` is called for the first time, the
   backend posts `/connect` into wsd with
   `{ url: "http://workspace.internal" }`. wsd polls
   `workspace.internal/health`, then dials
   `ws://workspace.internal/ws`.
4. `WsdEgress.fetch` forwards the upgrade to the DO's `fetch()` via
   the DO binding. The DO's `fetch()` delegates to
   `backend.handleFetch(req)`, which performs the WebSocket upgrade,
   resolves the in-flight `connect()`, and attaches a capnweb
   client session to the server-side socket.
5. The DO exposes flat RPC methods (`do_writeFile`, `do_readFile`,
   `do_execCollect`) that delegate to `this.#workspace.fs` /
   `.shell`. The Worker's fetch handler parses paths and forwards.

The DO extends the plain `DurableObject` class from
`cloudflare:workers`. The container lifecycle plumbing all lives
in `CloudflareContainerBackend` — the DO is a thin host.

FUSE is currently disabled (`DISABLE_FUSE=1`) — Cloudflare Containers
don't expose `/dev/fuse`. That means `exec`'d commands see the
container's local filesystem, **not** the wsd VFS. File reads /
writes go through the RPC stub; exec is a separate channel. Once
FUSE access lands on the platform, dropping `DISABLE_FUSE` mounts
the same VFS into the container so both surfaces see the same tree.

## HTTP surface

```
PUT  /c/<name>/file/<path...>   raw body → wsd writeFile
GET  /c/<name>/file/<path...>   octet-stream of file bytes
POST /c/<name>/exec             { command | argv, cwd?, encoding? }
                                → SSE result frame
GET  /c/<name>/<wsd-path>       raw HTTP passthrough into wsd
```

`<name>` selects a DO instance; each gets its own container.

## Run it locally

Requires Docker.

```sh
# Build the wsd SEA binary (one-time / after wsd changes).
npm run build:bin --workspace @cloudflare/workspace-wsd

# Boot the example. predev stages the binary into ./build/.
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
  src/index.ts              Worker handler, DO, WsdEgress entrypoint
  scripts/stage-wsd.mjs     copies wsd-linux-x64 into ./build/
```

## Known limitations / next steps

- **Exec doesn't see wsd VFS files.** FUSE disabled — see above.
- **Exec is run-and-collect, not streamed.** The handler awaits
  `handle.result()` and emits one SSE frame. Live streaming needs
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
