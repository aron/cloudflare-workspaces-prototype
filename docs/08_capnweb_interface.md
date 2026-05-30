# 08. Capnweb Interface

> [!IMPORTANT]
> This document describes the **intended design** of the capnweb wire
> interface and has **diverged from the current implementation** in
> the repository. RPC names, type names (`ChangeEntry`, `hasObjects`,
> `fetchObjects`, `pushObjects`, `push`, `fetchChanges`), and the
> unification of push/fetch on a single `ChangeEntry` type are
> targets, not what `main` ships today. When in doubt, treat the code
> as authoritative for what runs and this doc as authoritative for
> what we're moving toward.

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

  // DO → container. Stream a coalesced batch of changes. Bytes are
  // not inline: the DO sends ChangeEntry records with chunk hashes,
  // the container calls back via hasObjects / asks for the missing
  // bytes through pushObjects. Returns the container's new rev and
  // its appliedPushRev once the batch is durably applied.
  push(changes: ReadableStream<ChangeEntry>):
    Promise<{ rev: number; appliedPushRev: number }>;

  // Container → DO. Stream every ChangeEntry with rev > sinceRev.
  // Per-file entries carry (hash, size) chunk lists; no bytes inline.
  // Caller follows up with hasObjects / fetchObjects for the chunks
  // it doesn't already have. Each entry carries the container's
  // current appliedPushRev.
  fetchChanges(sinceRev?: number, ignore?: string[]):
    ReadableStream<ChangeEntry>;

  // Probe which object hashes the receiver has. Same semantics in
  // both directions: git's `have` line, batched. Returns the subset
  // of the input the receiver already holds.
  hasObjects(hashes: Uint8Array[]): Promise<Uint8Array[]>;

  // Container → DO direction of object transfer. Stream bytes for
  // a set of chunk hashes in request order. Throws EUNKNOWN_HASH if
  // any hash is unknown — callers must dedupe and probe first.
  fetchObjects(hashes: Uint8Array[]):
    ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>;

  // DO → container direction of object transfer. The DO streams the
  // bytes the container reported missing (via hasObjects) during a
  // push. Pushed objects are addressable immediately by hash.
  pushObjects(objects: ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>):
    Promise<void>;

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

`VFSEntry` and `ChangeEntry` are defined in
`src/shared/index.ts`. The schema column references match
[03. Filesystem Schema](./03_filesystem_schema.md).

## Push and fetch semantics

Push and fetch are symmetric. The same `ChangeEntry` shape moves in
both directions, and the same `hasObjects` probe runs against both
ends:

- **Push (DO → container).** The DO streams `ChangeEntry` records,
  the container calls `hasObjects` on the chunk hashes referenced,
  the DO follows up with `pushObjects` for the missing subset, the
  container applies the batch and returns `{ rev, appliedPushRev }`.
- **Fetch (container → DO).** The container streams `ChangeEntry`
  records, the DO accumulates chunk hashes, calls `hasObjects` on
  itself (cheap, local) to find what it already has, then calls
  `fetchObjects` for the rest.

| Aspect | Value |
| --- | --- |
| Round-trips per fetch | 1 streaming `fetchChanges` + 1 `hasObjects` + 1 streaming `fetchObjects` (only if any hashes are missing) |
| Round-trips per push | 1 streaming `push` + 1 `hasObjects` (server-driven) + 1 streaming `pushObjects` (only if any hashes are missing) |
| Bytes inline in `ChangeEntry` | None — entries carry chunk hashes only |
| Dedup | Global, content-addressed by `sha256(chunk)`. Applies in both directions. |

Identical content at multiple paths costs exactly one entry on the
wire and zero object-fetch round-trips if the receiver already has
the blob from a previous push or fetch. Streaming both the change
list and the object transfer keeps peak memory bounded on both sides
regardless of how much was touched. See
[02. Sync Protocol](./02_sync_protocol.md) for how this composes into
the push/fetch cycle.

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
| `EUNKNOWN_HASH` | `fetchObjects` or `pushObjects` referenced a hash the receiver has no record of. |
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
  bound on single-frame size, in-flight RPC count, or
  `hasObjects` / `fetchObjects` / `pushObjects` batch size. A
  pathological caller can ask for 100k hashes in one call and pin
  both sides on a single oversized frame. Working defaults are
  likely 16 MiB per frame, 256 concurrent RPCs per session, and
  1024 hashes per object-transfer batch — but they need measurement
  and an enforcement story (reject loudly? split silently?) before
  they go in the contract.

See [02. Sync Protocol](./02_sync_protocol.md) for how these RPCs
compose into a push/pull cycle, and
[07. Injected Service](./07_injected_service.md) for the server that
hosts them.
