> **Status (post-review).** Items marked ~~struck~~ have been folded
> into `08_capnweb_interface.md` and no longer need separate
> tracking. Remaining items stay as live proposals.

# 08. Capnweb Interface — Suggestions

Proposals against `08_capnweb_interface.md`. Ordered by leverage.

## 1. Hello frame: version + auth + compatibility date

**Problem.** Three of the four open questions on this page
(compatibility dates, connection auth, and "what does the server even
support") all need the same thing — a pre-bootstrap handshake. Today
the WebSocket upgrade immediately exposes the `ContainerRPC`
bootstrap stub.

**Proposal.** A single mandatory hello frame, server-first, before
the capnweb bootstrap:

```ts
// Server → client, first frame after WS upgrade.
type ServerHello = {
  protocolVersion: number;          // wire shape; bumped on breaking changes
  build:           string;           // e.g. "ws-2026.04.17"
  supportedDates:  [string, string]; // inclusive range, ISO dates
  capabilities:    string[];         // e.g. ["streamingPull", "execResume"]
  fuseActive:      boolean;
  authChallenge?:  string;           // 32-byte hex; present if auth required
};

// Client → server, immediately after.
type ClientHello = {
  compatibilityDate: string;         // chosen by the DO
  clientBuild:       string;
  authResponse?:     string;         // HMAC(token, challenge) or token
};
```

Mismatch (date outside `supportedDates`, version skew, bad auth)
closes the socket with a structured close code (see proposal 3)
rather than failing on the first real RPC. Cheap, closes both open
questions in one move.

Combine with `07_suggestions.md` items 5 and 8 — same hello, same
auth token sourced from `WORKSPACE_AUTH_TOKEN`.

## 2. Resolve compatibility dates concretely

**Problem.** The doc punts on where the date is declared and what
counts as a date-gated change.

**Proposal.**

- **Declared on the DO side**, via `WorkspaceOptions.compatibilityDate`.
  Falls back to the package's built-in default if omitted.
- **Three categories of change:**
  - *Additive* — new RPC, new optional field. No date bump.
  - *Behavioural* — same RPC, different default (e.g. `pullDirty`
    starts streaming). Date bump.
  - *Breaking* — removed field, changed type. Major
    `protocolVersion` bump; date-gating doesn't help.
- **The server enumerates supported dates** as a closed range, not
  a list. Easy to reason about, easy to test.
- **Per-RPC feature flags via `capabilities`** for additive changes
  the client wants to detect without bumping the date.

Document the policy here so future contributors don't have to
re-derive it.

## 3. Structured close codes

**Problem.** Today reconnect logic relies on "the socket closed,
rebuild." Reason for close is opaque, so the DO can't distinguish
"server crashed, retry" from "auth failed, do not retry" from
"version mismatch, surface to user."

**Proposal.** Reserve a block of WS close codes (4000–4099 is
application-defined):

| Code | Meaning | Retry? |
| --- | --- | --- |
| 4001 | Auth failed | No |
| 4002 | Protocol version mismatch | No |
| 4003 | Compatibility date out of range | No |
| 4010 | Server shutting down (planned) | Yes, with backoff |
| 4011 | Server overloaded | Yes, with backoff |
| 4020 | Internal error | Yes |

The DO surfaces non-retryable codes to the caller as
`WorkspaceError` with `code` and `reason`, instead of silently
looping.

## ~~4. Backpressure on the exec stream~~ — integrated

~~**Problem.** Open question on the page. `events:
ReadableStream<ExecEvent>` is backpressure-shaped on the consumer
side, but capnweb today doesn't push the signal back to the
spawned process.~~

~~**Proposal.** Two layers:~~

1. ~~**In-container bound.** The exec runner maintains a fixed-size
   ring buffer per stream (default 4 MiB stdout, 4 MiB stderr).
   When the consumer is behind and the buffer is full, the runner
   stops `read()`ing the child's pipes — kernel pipe pressure
   propagates to the child. Document the bound explicitly.~~
2. ~~**Optional explicit signal.** A `pause()`/`resume()` method on
   the exec handle for callers that want to throttle without
   relying on stream backpressure semantics.~~

~~If a consumer reads slower than the ring buffer drains, the child
blocks on `write` and chatty commands self-regulate. This is the
contract `tee` / `less` rely on; mirroring it removes a class of
mystery OOMs.~~

Folded into `08_capnweb_interface.md` “Backpressure on the exec
stream”.

## ~~5. Specify stream replay durability~~ — integrated (with correction)

**Correction from review.** `getExec` resume takes an event `seq`
(the monotonic id carried on every `ExecEvent`), not a `"full"` /
`"tail"` mode. Callers pass the last `seq` they observed (or
`"tail"` to receive only future events, or omit to replay from the
start). The original doc has been updated to reflect this.

~~**Problem.** Open question on the page. `getExec({ resume:
"full" })` implies a replayable log with no stated retention.~~

~~**Proposal.** Document a small, predictable contract:~~

- ~~The server keeps the **full event log** for any exec until either:
  1. The process has exited *and* the DO has acknowledged the exit
     event (via a new `ackExec(id)` RPC), **or**
  2. A configurable TTL after exit (default 5 minutes), **or**
  3. The total log size for one exec exceeds a cap (default 16 MiB,
     after which older events are evicted and `getExec({ resume:
     "full" })` returns `ELOG_TRUNCATED`).~~
- ~~For long-running execs, the server spills the log to a local file
  once it crosses a smaller in-memory cap (e.g. 1 MiB), so
  reattaching after a long disconnect is supported within the size
  cap.~~

~~Add `ackExec(id)` so the DO can promptly release log memory once
it has durably consumed the events.~~

Folded into `08_capnweb_interface.md` “Stream replay and
durability.”

## 6. Streaming pulls and chunked blob transfer — adopted

**Status.** Review confirmed this is greenfield — no back-compat
burden. `pullDirty` and `getBlobs` are now streaming by default in
`08_capnweb_interface.md`. No separate `pullDirtyStream` /
`getBlobsStream` variants and no capability flag needed.

~~**Problem.** `pullDirty` returns one `ManifestBulk`. `getBlobs`
returns `Uint8Array[]` — both fully buffered.~~

~~**Proposal.** Add streaming variants without breaking the existing
RPCs:~~

~~```ts
pullDirtyStream(sinceRev?: number, ignore?: string[]):
  ReadableStream<ManifestRecord>;

getBlobsStream(hashes: Uint8Array[]):
  ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>;
```~~

~~Gate behind a `capabilities` flag from the hello so the DO can
discover support. Existing `pullDirty` / `getBlobs` stay for
back-compat through one compatibility-date window, then deprecate.~~

## 7. RPC-level cancellation

**Problem.** Capnweb has stream cancellation, but RPC-level cancel
(e.g. "I no longer need this `pullDirty`") isn't documented.

**Proposal.** Specify: cancelling the returned promise (via
`AbortSignal` plumbed through the host-side `Workspace` API) closes
any associated stream and signals the server to stop work. For
`exec`, cancellation is equivalent to `killExec({ signal:
"SIGTERM" })`. Worth documenting explicitly so callers can rely
on it.

## ~~8. Error model~~ — integrated

~~**Problem.** Errors today are JS `Error` instances over capnweb. No
structured `code` on the wire, so host-side callers can't easily
branch on "the file was ignored" vs. "the chunk hash is unknown" vs.
"the container is shutting down."~~

~~**Proposal.** A small typed error envelope:~~

~~```ts
type WireError = {
  code:    string;       // e.g. "EIGNORED", "EUNKNOWN_HASH", "ESHUTDOWN"
  message: string;
  detail?: unknown;
};
```~~

~~Server throws `WorkspaceError` with `code`; host-side capnweb
adapter rethrows preserving `code`. Enumerate the codes in this
doc so they're discoverable.~~

Folded into `08_capnweb_interface.md` “Error model,” including the
code table.

## ~~9. Frame-size and message limits~~ — moved to open questions

~~**Problem.** Unspecified. A `getBlobs` for 10k hashes returning a
single buffered array can blow past sensible WebSocket frame sizes.~~

~~**Proposal.** Document and enforce:~~

- ~~Max single frame: 16 MiB (matches reasonable WS proxy defaults).~~
- ~~Max in-flight RPCs per session: 256 (then the server applies
  backpressure on new calls).~~
- ~~Max `getBlobs` request size: 1024 hashes per call; callers must
  batch.~~

~~Pair with the streaming variants from proposal 6 so large transfers
have a non-violating path.~~

Promoted to an open question in `08_capnweb_interface.md`; the
specific bounds still need measurement before they go in the
contract.

## ~~10. Observability hooks~~ — integrated

~~**Problem.** Today the only insight into the wire is "did the call
succeed." Diagnosing slow pulls or chatty pushes is forensic.~~

~~**Proposal.** Optional `onRpcEvent` callback on the host-side
`Workspace` that fires with `{ rpc, durationMs, bytesIn, bytesOut,
ok }` per call. Server-side: the existing `LOG_FILE` already gets
structured records; promote a subset to the DO via the log-forward
proposal in `07_suggestions.md` item 9.~~

~~Make it trivial to wire into OpenTelemetry / Workers Analytics
Engine without baking either in as a dependency.~~

Folded into `08_capnweb_interface.md` “Observability.”

## 11. Consider whether text-JSON capnweb is the right wire long-term

**Observation, not an immediate proposal.** Capnweb-text is JSON
over WS — readable, debuggable, but every chunk hash is hex-encoded
(2x size) and every binary payload is base64 (1.33x). For a wire
whose hottest traffic is "32-byte hashes and binary chunks," the
encoding tax is real.

**Worth measuring.** A binary capnweb variant (capnweb-binary, or a
straight-up Cap'n Proto envelope) for the bulk-pull / bulk-blob path
could cut wire bytes by ~40% on hash-heavy pulls. Keep text framing
for control RPCs where the debuggability is the win.

This is a "measure, then decide" item — file an issue with a
benchmark before committing.

## Suggested ordering (remaining items)

1. (1) Hello frame and (3) close codes — small, structural,
   unblocks (2) and the auth/version side of the contract.
2. (2) Compatibility-date policy — document it once.
3. (7) RPC-level cancellation — small, clarifies `AbortSignal`
   semantics end-to-end.
4. (11) Binary wire — only after a real benchmark.

Items 4, 5, 6, 8, and 10 have been folded into
`08_capnweb_interface.md`. Item 9 is now an open question in the
same doc.
