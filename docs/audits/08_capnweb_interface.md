# Audit: docs/08_capnweb_interface.md

## Scope
Spec-vs-implementation audit of `docs/08_capnweb_interface.md` against
the code in `packages/workspace-rpc/`, `packages/workspace-fs/`,
`packages/wsd/`, and `packages/workspace/`. The doc already carries a
prominent banner declaring divergence; this audit enumerates the
specific drifts and tags each one. Code is authoritative.

## Methodology
- Read the doc end to end (`docs/08_capnweb_interface.md` lines 1-269).
- Traced every named symbol to source:
  - Interface surface: `packages/workspace-rpc/src/interface.ts`.
  - Server impl: `packages/workspace-rpc/src/server.ts`.
  - Client stub: `packages/workspace-rpc/src/client.ts`.
  - Error registry: `packages/workspace-rpc/src/errors.test.ts`,
    `packages/workspace-fs/src/errors.ts`.
  - Sync wire helpers: `packages/workspace-fs/src/sync/{changes,fetch,push,apply}.ts`.
  - Exec / log retention: `packages/wsd/src/exec/{runner,log,types}.ts`.
  - HTTP / WebSocket carrier: `packages/wsd/src/cli/wsd.ts`.
  - Wire tests: `packages/workspace-rpc/src/wire.test.ts`,
    `packages/workspace-rpc/src/errors.test.ts`.
- Cross-checked against the existing audit notes in
  `docs/audits/00_README.md` and `docs/audits/05_shell_interface.md`
  where they touch the same surface (port number, `disposeExec`).

## Findings

### Interface name / location
- **Doc says** the RPC interface is `ContainerRPC`, defined in
  `src/shared/index.ts`, and `VFSEntry` / `ChangeEntry` live there
  too (lines 16-17, 125-127).
- **Code says** the wire interface is split into `SyncRPC` + `ShellRPC`
  composed under `WorkspaceRPC`, defined in
  `packages/workspace-rpc/src/interface.ts:22-132`. There is no
  `ContainerRPC` symbol anywhere in `packages/`. `ChangeEntry` lives
  in `packages/workspace-fs/src/sync/changes.ts:19-36`; `VFSEntry`
  does not exist as a type. `src/shared/` does not exist.
- Tag: `doc-fix`. Rename `ContainerRPC` → `WorkspaceRPC` (with the
  `sync` / `shell` split called out), update the file path, and drop
  `VFSEntry`.

### `snapshot()` RPC
- **Doc says** `snapshot(): Promise<{ entries: VFSEntry[]; rev: number }>`
  is the baseline call for a fresh DO (lines 44-46).
- **Code says** there is no `snapshot()` on `SyncRPC`. Baselining is
  done by calling `fetchChanges({ sinceRev: 0 })`, which is the same
  shape as an incremental pull just starting at rev 0
  (`interface.ts:38`, `server.ts:98-103`,
  `sync-driver.ts:39-49`).
- Tag: `doc-fix`. Remove `snapshot()`; describe the rev-0 fetchChanges
  baseline.

### `push()` signature
- **Doc says** `push(changes: ReadableStream<ChangeEntry>): Promise<{ rev; appliedPushRev }>`
  (lines 53-54).
- **Code says** `push(input: { senderRev: number; changes: ReadableStream<ChangeEntry> })`
  (`interface.ts:31-34`, `server.ts:61-96`). The `senderRev` field is
  load-bearing: `senderRev > 0` flags a sync peer (advance fetchRev,
  silence loopback), `senderRev === 0` flags an external orchestrator
  (treat as local writes, leave pushRev untouched). The test in
  `wire.test.ts:341-447` covers both branches.
- Tag: `doc-fix`. The doc must show `{ senderRev, changes }` and
  describe the peer-vs-external semantics, otherwise callers cannot
  drive `push()` correctly.

### `fetchChanges()` signature
- **Doc says** `fetchChanges(sinceRev?: number, ignore?: string[]): ReadableStream<ChangeEntry>`
  (lines 61-62) — positional args.
- **Code says** `fetchChanges(input: { sinceRev?: number; ignore?: string[] })`
  (`interface.ts:38`, `server.ts:98-103`). All wire methods that take
  more than one argument use a single object parameter.
- Tag: `doc-fix`.

### Missing `currentRev()` / `watermarks()` / `readEntry()`
- **Doc says** the only sync surface is `snapshot`, `push`,
  `fetchChanges`, `hasObjects`, `fetchObjects`, `pushObjects`.
- **Code says** `SyncRPC` also ships:
  - `currentRev(): Promise<number>` — used by `pullOnce` to capture
    the puller's watermark target before draining the stream
    (`interface.ts:55`, `sync-driver.ts:46`).
  - `watermarks(): Promise<{ currentRev; pushRev; fetchRev }>` —
    diagnostic surface for soak tests and the agent (`interface.ts:69`,
    `server.ts:113-119`).
  - `readEntry(path): Promise<ChangeEntry | null>` — single-path
    materialisation used by interactive readers (`interface.ts:78`,
    `server.ts:105-107`).
- Tag: `doc-fix`. The doc has a TODO inside `interface.ts:48-54`
  about collapsing `currentRev` into `fetchChanges`. Until that
  refactor lands, the three extras are part of the wire and must be
  in the doc.

### `hasObjects` semantics
- **Doc says** `hasObjects(hashes: Uint8Array[]): Promise<Uint8Array[]>`
  (line 67). Correct.
- **Code agrees** (`interface.ts:80`, `server.ts:121-123`,
  `workspace-fs/src/sync/fetch.ts:35-43`).
- Tag: none.

### `fetchObjects` / `pushObjects`
- **Doc says** both stream `{ hash, bytes }`. `fetchObjects` throws
  `EUNKNOWN_HASH` on unknown hashes; `pushObjects` returns void
  (lines 69-79).
- **Code says** the streaming shapes match (`interface.ts:85-90`,
  `server.ts:125-142`). But the underlying impl in
  `workspace-fs/src/sync/push.ts:22` throws a plain
  `Error("pushObjects: missing blob for requested hash")` — no
  structured `code: "EUNKNOWN_HASH"`. The test in `wire.test.ts:187`
  asserts `(caught as Error).message).toMatch(/missing/i)` instead
  of `err.code === "EUNKNOWN_HASH"`. So the code reserves the symbol
  (it is in `WireErrorCode` at `interface.ts:147` and registered in
  `errors.test.ts:21`) but no call site actually raises it.
- Tag: `code-fix`. Doc target is correct: callers will branch on
  `err.code`, and the wire registry already commits to this code.
  Fix `pushObjects` to throw via `createWorkspaceError` (after adding
  `EUNKNOWN_HASH` to `WorkspaceErrorCode`) or a sibling helper.

### Exec / getExec / killExec
- **Doc says** `exec`, `getExec`, `killExec` shapes (lines 87-112).
- **Code matches** exactly: `ShellRPC` in
  `interface.ts:102-119`, `server.ts:149-168`.
- Tag: none.

### `ackExec` vs `disposeExec`
- **Doc says** the DO calls `ackExec(input: { id })` to release the
  event log once events are durably consumed (lines 180-181, 192-196).
- **Code says** the method is `disposeExec(input: { id }): Promise<void>`
  (`interface.ts:123`, `server.ts:170-172`,
  `wsd/src/exec/runner.ts` dispose path). `ackExec` does not exist.
- This is already flagged in `docs/audits/05_shell_interface.md:186`.
- Tag: `doc-fix`. Rename `ackExec` → `disposeExec` everywhere in the
  doc, including the trailing extension block at lines 191-197.

### `ExecEvent` shape
- **Doc says** `{ id, seq, name: "stdout"|"stderr"|"exit", value }`
  with `value: Uint8Array` for stdout/stderr and `value: number` for
  exit (lines 119-122).
- **Code matches** in `interface.ts:137-140`.
- Tag: none.

### Stream replay / retention defaults
- **Doc says**:
  - per-exec cap default **16 MiB** — ✅ matches
    `runner.ts:52` (`logMaxBytes: 16 * 1024 * 1024`).
  - TTL after exit default **5 minutes** — ✅ matches
    `retentionMs: 5 * 60 * 1000`.
  - per-stream **4 MiB ring buffer** (stdout 4 MiB, stderr 4 MiB,
    lines 163-164) — ❌ no ring buffer exists. The runner reads
    child pipes into a single SQLite-backed log; backpressure is
    pull-based via `child.stdout.pause()` / `.resume()` when the
    capnweb stream's `desiredSize ≤ 0`
    (`runner.ts:253, 279-286, 305-310`).
  - **1 MiB in-memory / spill-to-file threshold** (lines 184-186) —
    ❌ no such threshold. Every event is written straight to the
    `wsd_exec_events` SQLite table (`exec/log.ts`, schema in
    `exec/schema.ts`). There is no separate file-spill code path.
  - `ELOG_TRUNCATED` raised when the log is evicted past the cap —
    ✅ matches `log.ts:189` and `runner.test.ts:173`.
- Tag: `doc-fix` on the ring-buffer + spill description. The 16 MiB
  cap, 5-min TTL, and ELOG_TRUNCATED behaviour are correct.

### Backpressure shape
- **Doc says** "fixed-size ring buffer per stream" causes kernel pipe
  pressure (lines 163-168).
- **Code says** pull-based: capnweb's `desiredSize` drives
  `child.stdout?.pause()` directly. There is no in-process ring
  buffer; the child blocks on `write` once the kernel pipe fills
  (`runner.ts:251-310`). Functionally the end-state — chatty
  commands self-throttle — is the same, but the mechanism the doc
  describes is wrong.
- Tag: `doc-fix`. Rewrite as "pull-based; the runner pauses the child
  stream when the capnweb stream signals backpressure, kernel pipe
  pressure then blocks the child."

### `pause()` / `resume()` host handle
- **Doc says** the host-side exec handle exposes `pause()` / `resume()`
  (lines 170-172).
- **Code says** the host-side `Workspace.shell.exec` returns whatever
  shape `WorkspaceShell` defines. Quick scan of
  `packages/workspace/src/shell.ts` does not show explicit
  `pause()`/`resume()` methods on the returned handle; the consumer
  drives backpressure through the `events` ReadableStream's natural
  pull. Cross-reference with docs/05 audit recommended before
  asserting this is wrong.
- Tag: `needs-decision`. If the handle ships pause/resume later this
  is fine; today the doc oversells the surface.

### Error model
- **Doc says** errors carry `{ code, message, detail? }` and the host
  rethrows as `WorkspaceError` preserving `code` (lines 204-223).
- **Code says** the registry of codes is `WireErrorCode` in
  `interface.ts:145-152`:
  - `ENOENT`, `EUNKNOWN_HASH`, `ESHUTDOWN`, `EAUTH`, `EPROTOCOL`,
    `EEXEC_BUSY`, `ELOG_TRUNCATED`.
  - `ELOG_TRUNCATED` and `EEXEC_BUSY` are not in the doc table.
  - `ESHUTDOWN`, `EAUTH`, `EPROTOCOL` are still TBD per
    `errors.test.ts:50-60`; they are reserved but no call site
    raises them.
  - `EUNKNOWN_HASH` is reserved but no call site raises it (see
    `pushObjects` finding above).
  - The host adapter does **not** rethrow as a typed
    `WorkspaceError`; capnweb just forwards own enumerable error
    props, and the workspace-side error helper
    (`workspace-fs/src/errors.ts`) only enumerates filesystem codes
    (`ENOENT` … `EIO`), not the wire codes. The `WireError` interface
    type in `interface.ts:154-158` is descriptive metadata, not a
    runtime class.
- Tag: `doc-fix` on the table contents (add `EEXEC_BUSY`,
  `ELOG_TRUNCATED`; drop `ELOG_TRUNCATED` from doc-only since the
  audit shows it is implemented). Also `code-fix` candidate: lift the
  TBD codes into real throw sites, or remove them from the union.

### Carrier / transport
- **Doc says** `/rpc` is the WebSocket path, default port **4567**,
  binary frames rejected loudly (lines 21-33).
- **Code says** the WebSocket path is `/ws`
  (`wsd/src/cli/wsd.ts:170`), and the default port is **45678**
  (`wsd/src/cli/wsd.ts:23`). The wire test harness mounts `/rpc`
  but only because the test stands up its own WebSocketServer; the
  shipped daemon uses `/ws`. There is no code path that "fails the
  session loudly on the first binary message"; capnweb's session
  layer handles framing, and no explicit binary-rejection guard
  exists in `acceptWebSocketSession` (`server.ts:229-235`).
- Tag: `doc-fix` on both `/rpc → /ws` and the port number (`4567 →
  45678`). The port mismatch is already tracked in
  `docs/audits/00_README.md:42`. Binary-rejection claim is
  unsupported — either drop or `needs-decision` if we want it as a
  hard requirement.

### Reconnect / deferred transport
- **Doc says** the DO transport queues sends before the WebSocket
  reaches OPEN, then flushes when ready (lines 35-38).
- **Code says** `createSyncClient` and `createWorkspaceClient` both
  rely on capnweb's `newWebSocketRpcSession`, which does this
  transparently (`client.ts:39-45, 121-129`). The DO-side
  `CloudflareContainerBackend` (`packages/workspace/src/backends/cloudflare-container.ts`)
  builds a Worker-side carrier; the queueing behaviour comes from
  capnweb. Doc is functionally accurate but the file reference to
  `@cloudflare/sandbox`'s `ContainerControlConnection` is not in
  this repo.
- Tag: `note`. Wording fine; the comparison reference is unverifiable
  here.

### Observability hook
- **Doc says** `Workspace` accepts an `onRpcEvent` callback firing per
  RPC with `{ rpc, durationMs, bytesIn, bytesOut, ok, code? }`
  (lines 227-233).
- **Code says** `createSyncClient` accepts `onRpcEvent` with
  `{ rpc, durationMs, ok, code? }` — no `bytesIn` / `bytesOut`
  (`client.ts:10-15, 24-28`); the comment at `client.ts:25-27`
  explicitly notes capnweb does not surface per-call frame sizes.
  The `createWorkspaceClient` (the composite stub) does **not**
  accept `onRpcEvent` at all; comment at `client.ts:115-120`
  acknowledges this. The host `Workspace` class in
  `packages/workspace/src/workspace.ts` has no `onRpcEvent` option
  either (grep shows zero matches).
- Tag: `doc-fix` (drop `bytesIn` / `bytesOut`, qualify "host-side
  `Workspace`" — only the lower-level sync client has the hook
  today) **or** `code-fix` if we want the host surface to expose it.

### Push/fetch semantics table
- **Doc table** (lines 144-149) describes the choreography correctly
  in shape: streaming changes + hasObjects probe + streaming
  pushObjects/fetchObjects.
- **Code agrees** in `sync-driver.ts:39-198` and `server.ts:61-142`.
- The doc omits the `currentRev()` probe that `pullOnce` also makes
  before draining `fetchChanges` (`sync-driver.ts:46`); that is one
  extra round-trip the table does not account for.
- Tag: `doc-fix` (minor).

### Open questions section
- Compatibility dates, connection auth, frame-size limits — all
  genuinely unimplemented. The doc correctly marks these as open.
  `errors.test.ts:50-60` documents `EAUTH` and `EPROTOCOL` as TBD,
  which matches.
- Tag: none.

## Drift summary
| # | Surface | Doc | Code | Tag |
|---|---|---|---|---|
| 1 | Interface name / file | `ContainerRPC` in `src/shared/index.ts` | `WorkspaceRPC = { sync: SyncRPC; shell: ShellRPC }` in `workspace-rpc/src/interface.ts` | doc-fix |
| 2 | `snapshot()` | exists | does not exist; use `fetchChanges({sinceRev:0})` | doc-fix |
| 3 | `push()` arg shape | positional ReadableStream | `{ senderRev, changes }` with peer-vs-external semantics | doc-fix |
| 4 | `fetchChanges()` arg shape | positional | single object param | doc-fix |
| 5 | Missing methods | — | `currentRev`, `watermarks`, `readEntry` | doc-fix |
| 6 | `EUNKNOWN_HASH` | thrown by `fetchObjects` | reserved but never raised | code-fix |
| 7 | `ackExec` | exists | method is `disposeExec` | doc-fix |
| 8 | Ring buffers per stream | 4 MiB stdout / 4 MiB stderr | no ring buffer; pause/resume on child pipe | doc-fix |
| 9 | In-memory → file spill | 1 MiB threshold | not implemented; all events go to SQLite directly | doc-fix |
| 10 | Error code table | omits `EEXEC_BUSY`, `ELOG_TRUNCATED` | both in `WireErrorCode` | doc-fix |
| 11 | `WorkspaceError` rethrow | preserves `code` | `workspace-fs` error codes don't overlap wire codes; capnweb just round-trips props | code-fix / doc-fix |
| 12 | Transport path | `/rpc` | `/ws` | doc-fix |
| 13 | Default port | `4567` | `45678` | doc-fix |
| 14 | Binary-frame rejection | "fails loudly on first binary frame" | no explicit guard | doc-fix or code-fix |
| 15 | `onRpcEvent` shape | `bytesIn`/`bytesOut` included; on host `Workspace` | only on `createSyncClient`, no byte counts | doc-fix |
| 16 | `pullOnce` round-trips | not counted | extra `currentRev()` round-trip per pull | doc-fix |
| 17 | Host `exec` `pause()`/`resume()` | exposed | not in code today | needs-decision |

## Recommendations
1. Rename the doc target: `ContainerRPC` → `WorkspaceRPC` and split the
   description into `sync` / `shell` halves. Update the file reference
   to `packages/workspace-rpc/src/interface.ts`. (doc-fix #1)
2. Replace `snapshot()` with a paragraph on rev-0 `fetchChanges` as
   the baseline. (doc-fix #2)
3. Fix `push()` to `{ senderRev, changes }` and document the peer
   (`senderRev > 0`) vs external (`senderRev === 0`) branches. The
   behaviour is load-bearing for the soak harness and the sync
   driver. (doc-fix #3)
4. Add `currentRev`, `watermarks`, `readEntry` to the interface block,
   each with the same one-line intent the source comments give. Note
   the planned `currentRev` → `fetchChanges { rev, stream }` collapse
   per `interface.ts:48-54`. (doc-fix #5)
5. Rename `ackExec` → `disposeExec`. Already raised in the docs/05
   audit; do not let the two diverge again. (doc-fix #7)
6. Rewrite the backpressure section: drop ring buffers, describe the
   pull-based `pause()`/`resume()` plumbing. (doc-fix #8)
7. Drop the 1 MiB spill threshold; describe the SQLite-backed log
   with a single 16 MiB cap and 5 min TTL (these defaults are
   correct). (doc-fix #9)
8. Update the error table: add `EEXEC_BUSY`, `ELOG_TRUNCATED`. Either
   raise the TBD codes from real call sites (so the registry is not
   aspirational) or remove them from `WireErrorCode`. (doc-fix #10 +
   code-fix on reserved-but-unthrown codes).
9. Fix the carrier paragraph: WebSocket path is `/ws`, default port
   `45678`. Removing the binary-rejection claim is the cheap option;
   adding the guard in `acceptWebSocketSession` is the principled
   one. (doc-fix #12 + #13; #14 needs-decision).
10. Tighten the `onRpcEvent` paragraph: today it is a `SyncClient`
    option, not a host `Workspace` option, and there are no byte
    counts. If we want the host-level hook with byte counts, that is
    a code item, not a doc one. (doc-fix #15)

## Drifts where doc target still looks valuable
- **`EUNKNOWN_HASH` actually being thrown** (#6). The wire registry
  reserves the code, the test infrastructure expects it, and callers
  will want to branch on it without string-matching on "missing".
  Right call is to wire `pushObjects` / `fetchObjects` in
  `workspace-fs/src/sync/push.ts:22` to throw via
  `createWorkspaceError("EUNKNOWN_HASH", …)` — which means extending
  `WorkspaceErrorCode` (or splitting wire codes into their own
  factory). Doc stays; code catches up.
- **Host-side `WorkspaceError` carrying wire `code`** (#11). Same
  underlying issue: today `workspace-fs` only enumerates filesystem
  codes, so RPC-side codes (`ESHUTDOWN`, `EAUTH`, `EPROTOCOL`,
  `EUNKNOWN_HASH`, `EEXEC_BUSY`, `ELOG_TRUNCATED`) ride through capnweb
  as raw own-property `code` strings on a plain `Error`. The doc
  promises a typed rethrow; the contract is sensible, the gap is in
  the error factory.
- **Binary-frame rejection** (#14). Cheap defensive guard, useful for
  early failure when something speaks a different protocol. Keeping
  the doc claim and adding the guard is better than retreating.
- **Host `onRpcEvent` with byte counts** (#15). Observability surface
  is genuinely useful for the host Worker; the comment in
  `client.ts:25-27` already acknowledges capnweb does not expose byte
  counts today. Could be addressed by counting at the WebSocket
  carrier rather than the stub layer.
- **`pause()`/`resume()` on the host exec handle** (#17). The doc's
  promise is shaped right for callers that want to gate without
  driving the stream; whether to ship it is a small design call but
  the target reads well.
