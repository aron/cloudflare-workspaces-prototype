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
  pullDirty(sinceRev?: number, ignore?: string[]): ReadableStream<ManifestRecord>;

  // Probe which chunk hashes the container has. Used by the manifest
  // pull and by the chunk-mode push.
  hasBlobs(hashes: Uint8Array[]): Promise<Uint8Array[]>;

  // Fetch raw bytes for a set of chunk hashes, in request order.
  // Throws if any hash is unknown — callers must dedupe and probe first.
  getBlobs(hashes: Uint8Array[]): ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>;

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

  // Reattach to an in-flight or recently-completed exec by id. Pass the
  // `seq` of the last event the caller already saw to resume from that
  // point; omit to receive every event from the start of the run; pass
  // `"tail"` to receive only events produced after the call.
  getExec(input: {
    id:      string;
    after?:  number | "tail";
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
// converts to `string` when the caller passes `encoding: "utf8"`. Every
// event carries a monotonic `seq` (per exec id) so callers can resume
// from a known point after a disconnect.
type ExecEvent =
  | { id: string; seq: number; name: "stdout"; value: Uint8Array }
  | { id: string; seq: number; name: "stderr"; value: Uint8Array }
  | { id: string; seq: number; name: "exit";   value: number };
```

`VFSEntry`, `VFSChange`, and `ManifestRecord` are defined in
`src/shared/index.ts`. The schema column references match
[03. Filesystem Schema](./03_filesystem_schema.md).

## Pull semantics

`pullDirty` returns a `ReadableStream<ManifestRecord>` — one record per
touched path with a `chunks: (hash, size)[]` array. No bytes inline.
Callers consume records as they arrive, accumulate the union of chunk
hashes they don't recognise, and follow up with `hasBlobs` /
`getBlobs` (the latter also returns a stream) for the missing subset.

| Aspect | Value |
| --- | --- |
| Round-trips per pull | 1 streaming RPC + 1 `hasBlobs` + 1 streaming `getBlobs` (only if any hashes are missing) |
| Bytes inline | None — manifests carry chunk hashes only |
| Dedup | Global, content-addressed by `sha256(chunk)` |

Identical content at multiple paths costs exactly one entry on the wire
and zero `getBlobs` round-trips if the DO already has the blob from a
previous pull. Streaming both the manifest and the blob fetch keeps
peak memory bounded on both sides regardless of how much the exec
touched. See [02. Sync Protocol](./02_sync_protocol.md) for how this
composes into the push/pull cycle.

## Backpressure on the exec stream

`exec` and `getExec` return a `ReadableStream<ExecEvent>` whose
consumer-side backpressure is propagated all the way to the spawned
process. The runner inside the container maintains a fixed-size ring
buffer per stream (default 4 MiB for stdout, 4 MiB for stderr). When
a consumer is behind and a buffer is full, the runner stops
`read()`ing the child's pipes; kernel pipe pressure then blocks the
child on `write`. Chatty commands self-regulate the same way they
would under a slow `tee` or `less` on a normal shell.

Callers that need to throttle without relying on the stream's pull
semantics can use `pause()` / `resume()` on the host-side exec handle
(see [05. Shell Interface](./05_shell_interface.md)).

## Stream replay and durability

The server keeps the full event log for each exec, keyed by `id`, so
`getExec({ id, after })` can resume from any `seq` the caller has
already observed. Retention is bounded:

- The log is kept until the DO acknowledges the `exit` event via
  `ackExec(id)`, **or** until a TTL after exit (default 5 minutes),
  **or** until the total log size for one exec exceeds the per-exec
  cap (default 16 MiB). Whichever comes first wins.
- Once the in-memory portion of the log crosses a smaller threshold
  (default 1 MiB), the server spills older events to a local file so
  long-running execs stay reattachable within the size cap.
- If the log has been evicted, `getExec` rejects with
  `ELOG_TRUNCATED` (see error codes below). Callers must be prepared
  for this and restart the exec if they need a clean replay.

```ts
interface ContainerRPC {
  // Release the event log for a completed exec. The DO is expected
  // to call this once it has durably consumed the events.
  ackExec(input: { id: string }): Promise<void>;
}
```

## Error model

Errors thrown over the wire carry a structured code so callers can
branch without string-matching:

```ts
type WireError = {
  code:    string;   // see table below
  message: string;
  detail?: unknown;
};
```

| Code | Meaning |
| --- | --- |
| `ENOENT` | Path does not exist on the DO side (covers ignored paths, which are invisible to `Workspace.fs`). |
| `EUNKNOWN_HASH` | `getBlobs` was called for a hash the container has no record of. |
| `ELOG_TRUNCATED` | `getExec` resume point is older than the retained log. |
| `ESHUTDOWN` | Server is shutting down; reconnect after the next boot. |
| `EAUTH` | Handshake auth failed (see [07. Injected Service](./07_injected_service.md)). |
| `EPROTOCOL` | Wire framing or version mismatch. |

The host-side capnweb adapter rethrows as `WorkspaceError` preserving
`code`, so application code can `if (err.code === "ENOENT")` rather
than parse messages.

## Observability

The host-side `Workspace` accepts an optional `onRpcEvent` callback
fired once per RPC with `{ rpc, durationMs, bytesIn, bytesOut, ok,
code? }`. Server-side, structured records land in `LOG_FILE` (see
[07. Injected Service](./07_injected_service.md)). Neither side bakes
in a tracing dependency — the callback is the integration point for
OpenTelemetry, Workers Analytics Engine, or whatever the host Worker
already uses.

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
- **Frame-size and message limits.** The wire has no documented
  bound on single-frame size, in-flight RPC count, or `getBlobs`
  batch size. A pathological caller can ask for 100k hashes in one
  call and pin both sides on a single oversized frame. Working
  defaults are likely 16 MiB per frame, 256 concurrent RPCs per
  session, and 1024 hashes per `getBlobs` batch — but they need
  measurement and an enforcement story (reject loudly? split
  silently?) before they go in the contract.

See [02. Sync Protocol](./02_sync_protocol.md) for how these RPCs
compose into a push/pull cycle, and
[07. Injected Service](./07_injected_service.md) for the server that
hosts them.
