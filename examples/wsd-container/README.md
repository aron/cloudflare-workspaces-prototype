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

1. The DO boots the Container; the Container's entrypoint is the
   `wsd` SEA binary.
2. wsd reaches the Worker through the **outbound egress proxy**
   (`http://workspace.internal`, intercepted by
   `WsdContainer.outboundByHost`).
3. The DO POSTs `/connect` into wsd with
   `{ url: "http://workspace.internal" }`. wsd polls
   `workspace.internal/health`, then dials
   `ws://workspace.internal/ws`.
4. The outbound handler forwards the upgrade to the DO's `fetch()`;
   the DO accepts the WebSocket and runs a **capnweb client
   session** over it, getting a typed `WorkspaceRPC` stub.
5. The DO wraps the stub in a `Workspace` instance from
   `@cloudflare/workspace`. The Worker calls into the DO via RPC
   methods; the DO drives the stub.

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
  src/index.ts              Worker handler, DO, StubBackend
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
- **One-shot session.** If wsd's WebSocket drops, the DO has to be
  re-entered for the next `onStart` to drive a new `/connect`. A
  health-monitor / re-dial loop is the natural follow-up.
