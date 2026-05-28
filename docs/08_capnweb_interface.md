# 08. Capnweb Interface

[capnweb](https://github.com/cloudflare/capnweb) is the RPC framing used
between the Durable Object and the in-container workspace-server. The
wire format is text JSON over a single WebSocket. The interface served
is `ContainerRPC`, defined in `src/shared/index.ts` and consumed by both
sides.

## Transport

- **Carrier.** One long-lived WebSocket per Workspace. The DO opens it
  with an HTTP request to the workspace-server's `/rpc` endpoint
  (default port 4567) carrying a `Connection: Upgrade` header. See
  [07. Injected Service](./07_injected_service.md) for the boot
  sequence.
- **Framing.** capnweb text frames. Binary frames are rejected — the
  server fails the session loudly on the first binary message.
- **Streams.** `ReadableStream<Uint8Array>` is a first-class capnweb
  value, used for the bulk-pull blob and the `exec` event stream.
- **Reconnect.** On close or error the DO-side connection
  self-destructs synchronously from the event handler. The next RPC
  call transparently rebuilds against the still-running
  workspace-server.

The DO uses a deferred transport so the RPC stub can be created before
the WebSocket upgrade completes — queued sends flush as soon as the
socket is ready. Mirrors the pattern from `@cloudflare/sandbox`'s
`ContainerControlConnection`.

## `ContainerRPC`

```ts
interface ContainerRPC {
  // Full snapshot of the container's tree. Used as a baseline only when
  // the DO has no watermark (e.g. fresh sandbox).
  snapshot(): Promise<{ entries: VFSEntry[]; rev: number }>;

  // DO → container. Apply the listed changes to the in-container mirror.
  applyChanges(changes: VFSChange[]): Promise<{ rev: number }>;

  // Container → DO. Manifest pull. Per-file (hash, size) chunk lists;
  // no inline bytes. Caller follows up with hasBlobs / getBlobs for
  // the subset it doesn't already have.
  pullDirty(sinceRev?: number, ignore?: string[]): Promise<ManifestBulk>;

  // Probe which chunk hashes the container has. Used by the manifest
  // pull and by the chunk-mode push.
  hasBlobs(hashes: Uint8Array[]): Promise<Uint8Array[]>;

  // Fetch raw bytes for a set of chunk hashes, in request order.
  // Throws if any hash is unknown — callers must dedupe and probe first.
  getBlobs(hashes: Uint8Array[]): Promise<Uint8Array[]>;

  // Start a command. Returns a handle whose `events` stream yields
  // stdout / stderr / exit frames as they happen. The stream is the
  // single source of truth — there is no buffered-return variant.
  // The handle's id can be passed to `getExec` to reattach to the same
  // run after a reconnect. See 05_shell_interface.md for the host-side
  // shape.
  exec(input: {
    command:   string;
    cwd?:      string;
    id?:       string;
  }): Promise<{
    id:     string;
    events: ReadableStream<ExecEvent>;
  }>;

  // Reattach to an in-flight or recently-completed exec by id. `resume`
  // controls whether the returned stream starts from the tail (live
  // events only) or replays the full event log from the beginning.
  getExec(input: {
    id:      string;
    resume?: "tail" | "full";
  }): Promise<{
    id:     string;
    events: ReadableStream<ExecEvent>;
  }>;

  // Signal a running exec. No-op once the process has exited.
  killExec(input: {
    id:      string;
    signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";
  }): Promise<void>;
}

// All payloads on the wire are binary. The host-side `Workspace.shell`
// converts to `string` when the caller passes `encoding: "utf8"`.
type ExecEvent =
  | { id: string; name: "stdout"; value: Uint8Array }
  | { id: string; name: "stderr"; value: Uint8Array }
  | { id: string; name: "exit";   value: number };
```

`VFSEntry`, `VFSChange`, and `ManifestBulk` are defined in
`src/shared/index.ts`. The schema column references match
[03. Filesystem Schema](./03_filesystem_schema.md).

## Pull semantics

The single pull RPC, `pullDirty`, returns a `ManifestBulk`:

| Aspect | Value |
| --- | --- |
| Round-trips per pull | 1 RPC + 1 `hasBlobs` + 1 `getBlobs` (only if any hashes are missing) |
| Bytes inline | None — manifests carry chunk hashes only |
| Dedup | Global, content-addressed by `sha256(chunk)` |

Identical content at multiple paths costs exactly one entry on the wire
and zero `getBlobs` round-trips if the DO already has the blob from a
previous pull. See [02. Sync Protocol](./02_sync_protocol.md) for how
this composes into the push/pull cycle.

## Open questions

These behaviours aren't fully specified yet. File an issue if your use
case depends on a particular resolution.

- **Compatibility dates.** The DO and the workspace-server are
  versioned independently — the DO ships with its host Worker, the
  server ships in the sandbox image. They can drift. The intent is to
  follow Workers' compatibility-date model: the DO declares a
  `compatibilityDate` on construction, the server reports its supported
  date range on the handshake, and a mismatch outside the supported
  window fails the connection hard with a clear error rather than
  attempting a graceful fallback. Open: where the date is declared
  (constructor option, env var, both), the wire shape of the
  handshake, and which categories of change require a date bump
  (additive vs. breaking).
- **Connection auth.** The handshake currently trusts anything that
  can reach the port. See the same item in
  [07. Injected Service](./07_injected_service.md#open-questions); the
  capnweb side will likely grow a pre-bootstrap auth phase to match
  whatever scheme the injected service settles on.
- **Backpressure on the exec stream.** `events` is a
  `ReadableStream<ExecEvent>`, but the wire doesn't currently
  propagate backpressure back to the spawned process. A chatty
  command with a slow consumer buffers in the container. We need
  either an explicit "the consumer is behind, throttle the producer"
  signal or a documented bound on in-memory event buffering.
- **Stream replay durability.** `getExec({ resume: "full" })` implies
  the server keeps the event log for some window. How long? Spillable
  to disk? Per-exec cap? Today it's "best effort, until the process is
  reaped"; the contract needs to be tightened before agents can rely
  on it for long-running execs.

See [02. Sync Protocol](./02_sync_protocol.md) for how these RPCs
compose into a push/pull cycle, and
[07. Injected Service](./07_injected_service.md) for the server that
hosts them.
