# 02. Sync Protocol — Suggestions

> **Status (post-review).** Items marked ~~struck~~ have been folded
> into `02_sync_protocol.md`. Items tagged “appendix” landed in the
> doc's “Future considerations” section. Remaining items stay as live
> proposals.

Proposals against `02_sync_protocol.md`. Ordered by leverage.

## ~~1. Echo `appliedPushRev` from the container~~ — integrated

~~**Problem.** The DO and container each carry a `currentRev`, but
nothing on the wire ties them together. The "container suppresses
dirty-tracking while applying" rule is load-bearing for correctness
and entirely invisible to the DO. A bug there would manifest as
silent data loss days later.~~

~~**Proposal.** Every `pullDirty` response includes the largest DO `rev`
the container has fully applied:~~

~~```ts
type PullDirty = {
  rev: number;              // container's currentRev
  appliedPushRev: number;   // largest DO rev fully applied
  records: ManifestRecord[];
};
```~~

~~The DO asserts `appliedPushRev >= pushRev` on every pull. Cheap,
makes the cross-side invariant inspectable, catches future bugs at
the boundary instead of in the data.~~

Folded into `02_sync_protocol.md` “Watermarks → Cross-side invariant”.
`appliedPushRev` is now in the watermark table and echoed on both
`applyChanges` and `pullDirty` responses.

## ~~2. Coalesce push by path~~ — integrated

~~**Problem.** The doc is silent on whether five rewrites of the same
path between execs produce five `applyChanges` records or one. For
mirror semantics only the latest state matters.~~

~~**Proposal.** Specify (and implement) "push sends at most one record
per path per batch, carrying the latest state." Concretely: select
`cf_nodes` rows with `rev > pushRev` plus `cf_changes` rows with
`rev > pushRev`, then collapse so a path's latest event wins. Same
correctness, dramatically less wire on burst writes.~~

Folded into `02_sync_protocol.md` Lifecycle step 1.

## ~~3. Stream the pull~~ — integrated

~~**Problem.** `pullDirty` returns a single `ManifestBulk`. A user who
clears `pullIgnore` and runs `npm install` produces a multi-hundred-MB
response, parsed and held in memory all at once on both sides.~~

~~**Proposal.** Make the response a stream of records.~~

Folded into `02_sync_protocol.md` (Lifecycle step 4, Wire shape).
`pullDirty` returns `ReadableStream<ManifestRecord>`; `getBlobs`
returns `ReadableStream<{ hash, bytes }>`. The capnweb-side change
is tracked in `08_capnweb_interface.md`.

## ~~4. Bounded apply batches~~ — integrated

~~**Problem.** A pathological exec can produce hundreds of MB of
changes in one transaction on the DO side.~~

~~**Proposal.** The DO commits manifest+blob application in bounded
transactions (e.g. 64 MiB or 1024 paths, whichever first). `pullRev`
advances per committed batch, so a crash mid-pull resumes cleanly via
`sinceRev = pullRev`.~~

Folded into `02_sync_protocol.md` Lifecycle step 6 and Failure
handling (“DO restart mid-pull”).

## ~~5. Bloom/cuckoo filter over `cf_blobs.hash`~~ — moved to appendix

**Problem.** Every pull does a `hasBlobs` probe round-trip. With
tens of thousands of chunks per pull this is small bytes but real
latency.

**Proposal.** The DO maintains an in-memory probabilistic filter
(rebuilt lazily from `cf_blobs`). For every chunk hash in a
manifest:

- Filter says "definitely not present" → request bytes directly,
  skip the probe.
- Filter says "maybe present" → fall back to `hasBlobs` for that
  subset.

Removes the probe entirely for the common case on warm sessions.

Promoted to “Future considerations → Bloom/cuckoo filter over
`cf_blobs.hash`” in `02_sync_protocol.md`. Pure DO-side optimisation;
no protocol change needed, so revisit when probe latency shows up in
real workloads.

## ~~6. Specify container crash-atomicity~~ — integrated

~~**Problem.** The doc says container restart → "next push is
authoritative baseline." It does not say what guarantees `applyChanges`
gives if the container crashes mid-apply.~~

~~**Proposal.** Document: "`applyChanges` is atomic from the DO's
perspective. The container is permitted to lose all state on crash;
the next push treats the container as empty. Partial application
must not survive a crash." A future on-disk mirror gets a WAL or a
staging directory swap.~~

Folded into `02_sync_protocol.md` Failure handling (“Container crash
mid-apply”).

## 7. Drop `EIGNORED`; defer ignored-entry representation — partially integrated

**Status from review.** For the initial release, ignored entries are
**invisible to `Workspace.fs`** — no stubs, no `EIGNORED`, no
`ignored` flag on `stat()`. `readdir` skips them and `stat`/`readFile`
return `ENOENT`. The bytes still live container-side and `exec` still
uses them; only the DO-side surface is affected.

The broader question — *should* ignored entries be representable to
the DO at all, and if so how (stub flag vs. shell-only namespace) —
is moved to `02_sync_protocol.md` “Future considerations →
Representing ignored entries to the DO”.

~~**Problem.** Ignored entries surface in `cf_nodes` as stubs with
`ignored=1`, throw `EIGNORED` on read, and carry container-reported
sizes. Three places in the API have to know about this and any tool
that walks the tree (a `tar` exporter, a code search) will silently
produce incorrect output unless it checks `stat().ignored`.~~

~~**Proposal.** Drop ignored entries from `cf_nodes` entirely. Expose
them as a separate namespace:~~

~~```ts
workspace.fs.readdir("/workspace/node_modules");        // throws ENOENT on DO side
workspace.shell.readdir("/workspace/node_modules");     // works, queries container
```~~

~~`readdir` of a parent that has both DO entries and container-only
entries merges at read time and tags the container-only ones.~~

## 8. Version handshake on connect — adopted, with refinement

**Status from review.** Adopted. Open refinement: **do the handshake
on the initial HTTP request that upgrades to the WebSocket**, rather
than as the first WS frame after upgrade.

Concretely:

- DO sends `X-Workspace-Protocol: <version>` and
  `X-Workspace-Compat-Date: <date>` headers on the upgrade `GET /rpc`.
- The server validates **before** completing the upgrade. Version /
  date mismatch responds `426 Upgrade Required` (or `400`) with a
  structured JSON body — no WebSocket is ever opened.
- The server's response headers (or `101` accept headers) carry
  `X-Workspace-Build` and `X-Workspace-Supported-Dates` so the DO can
  log them.

Why this is better than a first-frame handshake:

- Mismatches close the connection at the HTTP layer with a real status
  code, not a WS close. Easier to debug from logs and from
  `containerFetch` callers.
- No half-open state where the WS is up but the bootstrap stub is
  contractually invalid until a hello frame lands.
- Plays nicely with proxies and load balancers that already inspect
  HTTP headers but treat WS frames as opaque.
- The capnweb bootstrap stays unchanged — no special pre-bootstrap
  frame to design around.

Auth (the shared-secret token from `07_suggestions.md` item 5) rides
the same headers: `Authorization: Bearer <token>`. Single
handshake, single failure mode.

~~**Proposal.** Add a hello frame to the capnweb bootstrap: the
container advertises `{ protocolVersion, build }`, the DO refuses
the session on mismatch with a clear error.~~

Cross-references: `08_capnweb_interface_suggestions.md` item 1
should be updated to point at the HTTP-header path instead of a WS
hello frame; `07_suggestions.md` items 5 and 8 likewise.

## ~~9. Push backpressure~~ — moved to appendix

~~**Problem.** A long-running exec can produce dirty entries faster
than the DO pulls. Today the in-memory VFS caps this by OOMing,
which is a bad answer.~~

~~**Proposal.** The container maintains a soft cap on the dirty set
(say, 256 MiB of pending bytes or 100k paths). Above the cap, FUSE
write replies are delayed (real backpressure), or the container
proactively initiates a push to the DO out-of-band.~~

Promoted to “Future considerations → Push backpressure” in
`02_sync_protocol.md`. Naturally pairs with the disk-backed
container mirror from `07_suggestions.md` item 1.

## Suggested ordering (remaining items)

1. (8) Version handshake — do it on the HTTP upgrade, not in WS.
   Close the version-skew gap before anything else ships.
2. (7) Decide whether ignored entries get any DO-side representation
   before promising the future shape to callers.

Items 1, 2, 3, 4, and 6 have been folded into `02_sync_protocol.md`.
Items 5 and 9 live in that doc's “Future considerations” appendix.
