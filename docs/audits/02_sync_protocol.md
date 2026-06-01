# Audit: `docs/02_sync_protocol.md`

## Scope

Specifies the bidirectional sync protocol between the DO-side
SQLite-backed VFS and the container-side VFS: lifecycle
(push/pull/exec round-trip), chunking, watermarks, the cross-side
`appliedPushRev` invariant, wire RPCs, ignore lists, and failure
handling.

## Methodology

Read the doc end-to-end. Traced every normative claim into source:

- `packages/workspace-fs/src/sync/{apply,blobs,changes,coalesce,fetch,ignore,invariant,manifests,push,watermarks}.ts`
- `packages/workspace-fs/src/fs/writeFile.ts` (chunking)
- `packages/workspace-rpc/src/{interface,server,sync-driver}.ts`
- Relevant `*.test.ts` siblings (used as behavioural confirmation)
- `packages/workspace/src/shell.ts` (push/pull ordering around `exec`)

## Findings

### Lifecycle and chunking

| # | Claim (doc) | Status | Evidence | Notes |
| - | --- | --- | --- | --- |
| 1 | DO stamps every mutation with a fresh `rev` (L31–34, L98) | ✅ | `watermarks.ts:30 currentRev()`; `vfs_meta.rev` bumped in `fs/*` writers; verified by coalesce reading `vfs_nodes.rev > sinceRev` (`coalesce.ts:54`). | |
| 2 | Push coalesces to one entry per path, latest-wins (L42–46) | ✅ | `coalesce.ts:42–86` uses `emitted: Set<string>` to dedupe live + tombstone passes. | |
| 3 | Push entries carry chunk hashes only — no bytes inline (L46–48) | ✅ | `ChangeEntry` file variant carries `chunks: {hash, size}[]` only (`changes.ts:19–37`). Bytes ship via `pushObjects`/`fetchObjects`. | |
| 4 | Receiver probes via `hasObjects`, sender follows up with `pushObjects` for missing subset (L47–48) | ⚠️ | `sync-driver.ts:138–164` does this in *push* direction; but the prober is the **sender**, not the receiver — sender calls `remote.hasObjects(...)` then `remote.pushObjects(missing)`. Same effect; doc wording is wrong about *who* probes. | doc-fix |
| 5 | Container suppresses its own dirty-tracking while applying so deletes don't bounce back (L48–50) | ⚠️ | Implemented as **loopback suppression by advancing `pushRev`** post-apply (`apply.ts:151–174`), not by suppressing dirty-tracking at write time. The mechanism is fundamentally different (advance the watermark past entries we just generated) but the observable invariant is the same. | doc-fix |
| 6 | Lazy-mount stubs hydrated in same push batch (L51–53) | ❓ | No mount/hydration code visible in the sync layer; cross-doc reference to 06. Out of scope for this audit. | |
| 7 | `fetchChanges(sinceRev = fetchRev)` resumes from DO watermark (L56) | ✅ | `sync-driver.ts:39–49` reads `readWatermark(db, "fetchRev")`, passes as `sinceRev`. | |
| 8 | "The DO consumes entries as they arrive so peak memory stays bounded" (L59–60) | ❌ | `pullOnce` buffers the **entire** entry stream into `entries: ChangeEntry[]` before calling `applyChanges` (`sync-driver.ts:50–68`, `103`). Peak memory is O(total entries in batch), not bounded. The `applyChanges` helper itself accepts an `AsyncIterable`, but the driver pre-materialises. | doc-fix or code-fix — the doc target (streaming consumption) is genuinely valuable; flag. |
| 9 | DO unions chunk hashes from the entry stream, probes own `vfs_blobs`, calls `fetchObjects` for missing (L61–63) | ✅ | `sync-driver.ts:50–101`: collects `wantedHashes`, probes `remote.hasObjects`, then probes local `vfs_blobs`, then `fetchObjects(missing)`. | |
| 10 | "Entries + new objects land in the DO's SQLite **in bounded transactions** (default cap: 64 MiB of new bytes or 1024 paths)" (L64–66) | ❌ | `apply.ts:60–142` tracks `bytesInBatch`/`pathsInBatch` against `DEFAULT_MAX_BYTES=64 MiB`/`DEFAULT_MAX_PATHS=1024` but `flush()` only **resets the counters** — it does not begin/commit a transaction. Each `writeFile`/`mkdir`/`rm`/`symlink` wraps its own `transactionSync`, so the "batch" is purely a counter, not a transaction. Internal comment at `apply.ts:48–55` admits this. | doc-fix; describe what actually happens. |
| 11 | "`fetchRev` advances per committed batch so a crash mid-fetch resumes cleanly" (L66–68) | ❌ | `applyChanges` only advances `fetchRev` **after the stream drains** (`apply.ts:144–150`, single write). There are no per-batch commits of the watermark. A mid-stream crash re-fetches everything from `sinceRev`. The end state is still correct (idempotent apply), but the doc's "per batch" claim is false. | doc-fix — and the underlying intent (per-batch durability) is valuable; flag for code-fix consideration. |
| 12 | "After the final batch the DO advances `fetchRev` to the container's reported max revision" (L68–69) | ⚠️ | The driver advances to `remoteRev = await remote.currentRev()` captured **before** the stream begins (`sync-driver.ts:46`, passed as `advanceFetchRev` at `103–106`). That is the *sender's* `currentRev` at snapshot time, not a value carried inside `ChangeEntry`. Functionally equivalent for a single in-flight pull; doc wording implies the value is on the entry stream. | doc-fix |
| 13 | `writeFile`/`mkdir`/`rm` outside `exec()` follow same shape (L71–73) | ✅ | Fs mutators bump `vfs_meta.rev`; `pushOnce`/`pullOnce` make no distinction. | |
| 14 | `workspace.push()` runs step 1; `workspace.pull()` runs steps 4–6 (L72–73) | ✅ | `Workspace.shell` wraps an `exec` in `push() → run → pull()` (`packages/workspace/src/shell.ts:104+`, tests at `shell.test.ts:455`). | |
| 15 | Files split at fixed `CHUNK_SIZE = 512 KiB`, `chunkIdx = floor(byteOffset / CHUNK_SIZE)` (L77–80) | ✅ | `fs/writeFile.ts:12 CHUNK_SIZE = 512 * 1024`; `chunksOf()` slices at fixed offsets (`writeFile.ts:101–112`). | |
| 16 | Chunks content-addressed by `sha256(bytes)` (L80–81) | ✅ | `writeFile.ts:108 sha256(slice)`; `blobs.ts:16–28` stages by hash. | |
| 17 | Set difference is 32-byte hashes — no metadata round-trips (L85–86) | ✅ | `hasObjects` operates on `Uint8Array[]` of sha256 outputs (`fetch.ts:31–42`, `interface.ts:80`). | |

### Watermarks

| # | Claim | Status | Evidence | Notes |
| - | --- | --- | --- | --- |
| 18 | `pushRev` — last DO-side rev pushed (L96) | ✅ | `watermarks.ts:11`; `sync-driver.ts:183 writeWatermark("pushRev", localRev)`. | |
| 19 | `fetchRev` — last container-side rev fetched (L97) | ✅ | `watermarks.ts:11`, `apply.ts:144–150`. | |
| 20 | `currentRev` — latest local rev (L98–99) | ✅ | `watermarks.ts:30`. | |
| 21 | `appliedPushRev` is **echoed by the container on every push response and pull stream** (L100) | ❌ | Only the **push response** carries `appliedPushRev` (`interface.ts:31–34`, `server.ts:64,92–95`). `fetchChanges` returns a bare `ReadableStream<ChangeEntry>` (`interface.ts:38`); `ChangeEntry` has no `appliedPushRev` field (`changes.ts:19–37`). | doc-fix — and worth keeping target as a `code-fix` follow-up: the doc target ("inspectable on the wire on every response") is genuinely valuable. Flag. |
| 22 | Watermarks live in `_vfs_watermark` and survive DO restarts (L102–103) | ✅ | `watermarks.ts:14–24` `SELECT/INSERT ... ON CONFLICT(k)` against `_vfs_watermark`. | |
| 23 | Container revisions are in-memory only; next push after restart is authoritative baseline (L103–105) | ⚠️ | The container-side DB **is** the same `Database` abstraction (`workspace-rpc/src/sync-driver.ts` and `wire.test.ts:27–53`); whether it persists is a deployment choice. The "treat next push as baseline" pathway is `server.ts:87 isPeer = senderRev > 0` (with `senderRev === 0` meaning "external writer / fresh receiver"). The doc claim oversimplifies — see also #28. | doc-fix; clarify. |

### Cross-side invariant

| # | Claim | Status | Evidence | Notes |
| - | --- | --- | --- | --- |
| 24 | "Every `fetchChanges` and `push` response carries the container's current `appliedPushRev`. The DO asserts `appliedPushRev >= pushRev` on every response." (L109–110) | ❌ | Assertion is implemented and called only after `push` (`sync-driver.ts:179 assertAppliedPushRev(...)`; helper at `invariant.ts:21`). `fetchChanges` neither carries the value nor is asserted. See #21. | doc-fix; the invariant *check* on push is present and correct. The fetch-side echo is unimplemented. Flag the gap. |
| 25 | A regression in suppress-dirty-tracking trips the assertion immediately (L114–115) | ✅ | Tested at `workspace-rpc/src/sync-driver.test.ts:167–181` (rigged lower `appliedPushRev` causes throw). | |

### Wire shape

| # | Claim | Status | Evidence | Notes |
| - | --- | --- | --- | --- |
| 26 | `push` returns `{ rev, appliedPushRev }`, streams `ChangeEntry` (L126) | ✅ | `interface.ts:31–34`, `server.ts:61–96`. | |
| 27 | `fetchChanges(sinceRev?, ignore?)` returns `ReadableStream<ChangeEntry>` (L127) | ✅ | `interface.ts:38`, `server.ts:98–103`. | |
| 27a | "Each entry carries the container's `appliedPushRev`" (L127) | ❌ | Not on the type (`changes.ts:19–37`). See #21/#24. | doc-fix |
| 28 | `hasObjects(hashes[])` returns subset (L128) | ✅ | `fetch.ts:31–42`, `interface.ts:80`. | |
| 29 | `fetchObjects(hashes[])` streams `{hash, bytes}` (L129) | ✅ | `interface.ts:85`, `push.ts:11–27` (`pushObjects` is the same SQL re-exported as `fetchObjects` via `fetch.ts:22–25`). | |
| 30 | `pushObjects` symmetric mirror of `fetchObjects` (L130) | ✅ | Same generator (`fetch.ts:22–25` re-exports `pushObjects` from `push.ts`). On the wire, `pushObjects` accepts a `ReadableStream` (`interface.ts:90`, `server.ts:129–142` stages via `stageBlob`). | |
| 31 | Identical content at multiple paths or unchanged chunks ship once (L132–134) | ✅ | Sender dedups `wantedHashes` via `seenHash` (`sync-driver.ts:52,120`), then probes receiver. Content addressing by sha256 gives the rest. | |

### Failure handling

| # | Claim | Status | Evidence | Notes |
| - | --- | --- | --- | --- |
| 32 | Container restart mid-exec: DO self-destructs connection, rebuilds, incremental catch-up via watermarks (L138–141) | ❓ | Out of this module's scope (connection lifecycle lives in `workspace-rpc/src/{client,wire}.ts` and `workspace/src/backends/*`). Watermark-driven catch-up is correct in principle. Not verified here. | |
| 33 | Container crash mid-apply: push atomic from DO perspective; container can lose all state; next push treats container as empty (`appliedPushRev = 0`) (L142–148) | ⚠️ | Push is **not** atomic on the receiver: `server.ts:61–96` buffers entries then calls `applyChanges`, which does sub-mutation transactions (see #10/#11). The "in-memory VFS satisfies this trivially" caveat in the doc partially covers this. The `appliedPushRev = 0` on a fresh receiver is implicit — the receiver simply has no `pushRev` yet; the DO's first push goes with `senderRev = currentRev` and the receiver applies as `upstream`. | doc-fix; the spec target (push atomic from DO perspective) is worth keeping — flag. |
| 34 | DO restart mid-pull: `fetchRev` advances per committed apply batch, resumes from last commit (L149–151) | ❌ | See #11. `fetchRev` is single-write at end of stream. A DO restart mid-pull resumes from the prior `fetchRev`, re-fetching the whole stream. End state correct (idempotent), but doc's "per committed batch" is false. | doc-fix; the underlying durability target is worth keeping. |
| 35 | DO restart: watermarks persisted (L152–154) | ✅ | `_vfs_watermark` table; `watermarks.ts:14`. | |
| 36 | DO serializes mutating entry points through a per-Workspace FIFO queue; pure reads bypass (L155–157) | ❓ | No FIFO/queue plumbing visible in `packages/workspace-fs/src/sync/*` or `workspace-rpc/src/sync-driver.ts`. Probably belongs in the DO runtime (out of repo for this prototype) or in `packages/workspace/src/`. Not located. | needs-decision — confirm whether this is implemented elsewhere or still aspirational. |

### Ignore lists

| # | Claim | Status | Evidence | Notes |
| - | --- | --- | --- | --- |
| 37 | `ignore` hides path segments from the pull (L161–162) | ✅ | `ignore.ts:15–26` whole-segment match; `coalesce.ts:65,84` drops ignored. | |
| 38 | Default is `["node_modules"]`; `[]` disables; custom list extends (L169–170) | ⚠️ | `ignore.ts:13 DEFAULT_IGNORE = ["node_modules"]`. Default is applied **server-side** when `input.ignore` is omitted (`server.ts:100–102`). But "extends" is not implemented — a caller-supplied list **replaces** the default, it does not extend it. | doc-fix or code-fix; "extends" is not the implemented semantic. |
| 39 | Ignored paths invisible to `Workspace.fs`: `readdir` doesn't list them, `stat`/`readFile` return `ENOENT` (L174–179) | ❓ | Not verified in this audit (lives in `workspace-fs/src/fs/*` and the `Workspace.fs` proxy). Cross-check with doc 04. | |

## Drift summary

Material drifts (anything that isn't ✅):

- **F8** Pull buffers the whole entry stream before apply; doc claims streaming/bounded peak memory. Worth keeping the target.
- **F10** `applyChanges` "bounded transactions" are counter-only — there is no per-batch transaction commit. Doc must be corrected; staging-then-commit per batch is still worth pursuing for crash safety.
- **F11/F34** `fetchRev` advances once after stream drain, not per committed batch. Re-fetch is bounded but not minimal on crash. Doc should match; target is desirable.
- **F12** "Container's reported max revision" is in fact the remote's `currentRev` captured at pull start, not carried by entries.
- **F21/F24/F27a** `appliedPushRev` is only on the push response, not on `fetchChanges`/`ChangeEntry`. The cross-side invariant is only enforced post-push. Doc's "every response carries it" overstates the implementation. Doc target (wire-inspectable invariant on both directions) is worth keeping — `code-fix` candidate.
- **F4** Who probes `hasObjects` differs between doc and code (sender, not receiver). Pure doc wording bug.
- **F5** "Suppress dirty-tracking" is actually post-apply pushRev advancement (`apply.ts:151–174`). Different mechanism; same effect.
- **F23** Container watermarks are not "in-memory only" by design — they live in the same DB; behaviour depends on the container deployment.
- **F33** Push is not atomic on the receiver side (multiple sub-transactions inside `applyChanges`). Doc states atomicity from DO perspective; target valuable.
- **F36** FIFO mutation queue: no implementation found in scope; status unclear.
- **F38** Ignore list **replaces** rather than **extends** the default.

## Recommendations

Default stance: code is authoritative; most drifts → `doc-fix`. Items
where the doc target is still worth keeping are flagged below.

| # | Drift | Tag |
| - | --- | --- |
| F4 | "who probes hasObjects" wording | `doc-fix` |
| F5 | "suppress dirty-tracking" wording vs. pushRev-advance | `doc-fix` |
| F8 | streaming apply (peak memory bound) | `code-fix` candidate — doc target valuable; pullOnce should consume the entry stream as it arrives rather than buffering. |
| F10 | "bounded transactions" misstatement | `doc-fix` (describe per-mutation transactions); optional `code-fix` if real per-batch transactions are wanted. |
| F11/F34 | fetchRev per-batch advancement | `doc-fix` for current behaviour; `code-fix` candidate if mid-pull crash recovery is wanted to be minimal. |
| F12 | "container's reported max revision" | `doc-fix` |
| F21/F24/F27a | `appliedPushRev` on fetch stream + per-response invariant | `code-fix` candidate — doc target is valuable; consider attaching `appliedPushRev` to fetch results (e.g. via the planned `{ rev, stream }` collapse called out in `interface.ts:48–54`) and asserting the invariant on the pull path too. |
| F23 | container watermarks "in-memory only" | `doc-fix` |
| F33 | "push atomic from DO perspective" | `code-fix` candidate — wrap apply in a single transaction (or staging-then-rename equivalent) once the on-disk container mirror lands. |
| F36 | per-Workspace FIFO queue | `needs-decision` — confirm location or status. |
| F38 | ignore "extends" the default | `doc-fix` (cheapest) or `code-fix` if extension semantics are desired. |

Items the doc covers correctly and code implements faithfully:
chunking (size, deterministic boundaries, sha256 addressing), the
`push`/`fetchChanges`/`hasObjects`/`fetchObjects`/`pushObjects` RPC
surface, per-path coalescing, tombstone handling, DO-restart watermark
recovery, and the push-direction cross-side invariant assertion.
