# Ticket: durability + streaming gaps in `@cloudflare/computer/tools`

Filed from the hackspace migration to `@cloudflare/computer@0.1.0-alpha.1`.
Hackspace now takes `read` / `ls` / `write` / `edit` / `exec` / `publish` from
`createAITools()` and deleted its hand-rolled equivalents (`packages/fs-tools`,
`workspace-adapter.ts`, `exec-result.ts`, `streaming-tools.ts`, the local
`_execTool`). That was a ~3.4k line deletion and worth it, but a handful of
behaviours regressed, all of them in `exec`.

The low-level `WorkspaceShell` API already has everything needed; the gaps are
(a) the model-facing tool in `src/tools/exec.ts` throws the capability away, and
(b) the RPC stub / `getWorkspace` client surface doesn't carry the handle
identity, so anything reached through a stub (hackspace's sub-agents, the
`WorkerBackend` shell isolate) is strictly less capable than an in-DO caller.

Everything below is "please move this into the package" — hackspace can
re-implement each item locally, but then every consumer re-implements it too,
which is exactly what `createAITools` is meant to prevent.

---

## What the tool does today

`dist/tools/index.js`, `createExecTool`:

```ts
execute: async ({ command, cwd, backend }) => {
  const selectedBackend = backend ?? options.defaultBackend;
  try {
    const result = await (await options.workspace.shell.exec(command, {
      cwd, encoding: "utf8", backend: selectedBackend,
    })).result();
    return { command, cwd: cwd ?? null, backend: selectedBackend,
             exitCode: result.exitCode,
             stdout: truncate(result.stdout, maxBytes),
             stderr: truncate(result.stderr, maxBytes) };
  } catch (err) {
    return { command, cwd: cwd ?? null, backend: selectedBackend,
             error: err instanceof Error ? err.message : String(err) };
  }
}
```

The handle is created and immediately collapsed to `result()`. Its `id`,
its event stream, `kill()`, and `result().sync` / `pushed` / `pulled` /
`skipped` never leave the closure. `ExecOptions.id` and `ExecOptions.timeoutMs`
are never passed. `ToolExecutionOptions.abortSignal` is ignored.

---

## Gap 1 — `exec` cannot stream (the big one)

**Symptom.** A `npm install`, `npm test` or `wrangler deploy` shows the user
nothing at all until it exits, then dumps up to 64 KiB at once. For a
multi-minute command the UI is a spinner, and if the DO is evicted mid-command
*all* output is lost — nothing was ever persisted.

**Already available.** `ExecHandle` *is* a `ReadableStream<WorkspaceExecEvent>`,
and it survives the RPC boundary: `WorkspaceExecHandleStub.stream()` returns
framed bytes, `encodeExecEvents` / `decodeExecEvents` do the JSONL framing, and
`rebuildExecHandle` re-inflates a real handle on the client side. The transport
is done. Only the tool is blocking.

**Proposal.** Give `createExecTool` a streaming mode that yields partial results,
which the AI SDK already understands (an `AsyncIterable` from `execute` produces
`tool-output-available` chunks with `preliminary: true`):

```ts
createExecTool({
  workspace,
  defaultBackend,
  backends,
  stream: true,               // default false, so nothing changes for existing callers
  flushIntervalMs: 250,       // coalesce chunks; avoid one frame per write
  maxBytes: 64 * 1024,
})
```

with an `execute` that becomes an async generator folding the event stream into
the *same* output object it returns today, plus liveness fields:

```ts
async function* execute({ command, cwd, backend }, { abortSignal }) {
  const handle = await workspace.shell.exec(command, { cwd, backend, encoding: "utf8" });
  let stdout = "", stderr = "", exitCode: number | undefined;
  const base = { command, cwd: cwd ?? null, backend: selected, execId: handle.id };

  yield { ...base, running: true, stdout, stderr };
  for await (const event of handle) {            // stdout | stderr | exit
    if (event.name === "exit") exitCode = event.value;
    else if (event.name === "stdout") stdout = append(stdout, event.value);
    else stderr = append(stderr, event.value);
    if (shouldFlush()) yield { ...base, running: exitCode === undefined, stdout, stderr, exitCode };
  }
  yield { ...base, running: false, stdout, stderr, exitCode, sync: /* see Gap 4 */ };
}
```

Notes / constraints we hit:

- `result()` and iterating the handle are mutually exclusive (the handle throws
  `"exec handle already streaming"`). In streaming mode the tool has to derive
  `pushed` / `pulled` / `sync` from somewhere else, or the package needs the
  `exit` event to carry the sync summary — see Gap 4. **This is the one design
  decision this ticket can't make unilaterally.**
- Truncation has to become incremental: keep a byte budget, and once it's spent
  keep counting but stop appending, so the final `[truncated, N more bytes]`
  is still accurate.
- Frames must be coalesced. One `yield` per write turns a chatty build into
  thousands of persisted tool-part updates.
- **Think interaction — mostly solved, one sharp edge.** `@cloudflare/think`
  0.15's `_wrapToolsWithDecision` now branches on
  `originalExecute.constructor?.name === "AsyncGeneratorFunction"` and `yield*`s
  through it; only a *non-generator* `execute` that happens to return an async
  iterable is still drained to its last value. So the hackspace monkey-patch
  (`splitStreamingTools` in the deleted `streaming-tools.ts`) is no longer
  needed — **provided the package declares `execute` as a real async generator
  function**, not a plain function returning a generator. Worth an upstream test
  pinning that, because the difference is invisible at the type level.
  (Hackspace-side consequence: our generic `cancellable()` wrapper re-wraps
  `execute` in an async arrow and would flatten a streaming `exec` back to its
  last value. It needs the same generator-preserving branch once Gap 1 lands.)

---

## Gap 2 — the exec id never escapes, so nothing can reattach

**Symptom.** A DO eviction mid-`exec` leaves the persisted tool part in
`input-streaming` with no result row. `convertToModelMessages` then emits an
assistant tool call with no matching tool result, the provider rejects the
request, and the thread wedges permanently.

Hackspace papers over this in `beforeTurn` with
`resolveOrphanToolCalls(this.messages)` (`apps/agent/src/orphan-tools.ts`),
which rewrites orphans to `output-error: cancelled`. That unwedges the thread
but is a lie: the command is usually **still running** in the container, and its
output is discarded.

**Already available.** `WorkspaceShell.get(id, { resume: "tail" | "full" | seq })`
gives exactly-once resume, and `ExecOptions.id` lets the caller name the exec.

**Missing.**

1. The tool never passes `id`, and never reports `handle.id`, so there is
   nothing to persist next to the tool call.
2. `WorkspaceShellStub` has **no** `get()` at all, and its `WorkspaceExecOptions`
   omits `id` and `timeoutMs`:

   ```ts
   // dist/index.d.ts
   interface WorkspaceExecOptions { cwd?: string; encoding?: "utf8"; backend?: string }
   declare class WorkspaceShellStub extends RpcTarget {
     exec(command: string, options?: WorkspaceExecOptions): Promise<WorkspaceExecHandleStub>;
     // no get()
   }
   interface WorkspaceShellClient<…> { exec(…): …; /* no get() */ }
   ```

   So a caller holding a stub — every hackspace sub-agent, since they use
   `getWorkspace(await this.parentAgent(Agent))` — cannot name an exec, cannot
   reattach to one, and cannot set a timeout. In-DO callers can. That asymmetry
   is the thing to fix.

**Proposal.**

- Add `id` and `timeoutMs` to `WorkspaceExecOptions`, and
  `get(id, options?: GetExecOptions)` to `WorkspaceShellStub`,
  `WorkspaceShellClient`, and the `rebuildExecHandle` client wrapper.
- Have the tool accept a caller-supplied id and report it:

  ```ts
  createExecTool({
    execId: ({ toolCallId }) => `tool-${toolCallId}`,   // or default to this
    onStart: async ({ execId, command, backend }) => { /* persist */ },
    resume: async ({ execId }) => boolean,              // consulted before exec
  })
  ```

  Deriving the default id from `toolCallId` is enough on its own: the id becomes
  reconstructible after an eviction without any extra bookkeeping, and a
  `resume` hook lets the host say "this tool call was already started, attach
  instead of re-running".
- With that, hackspace deletes `orphan-tools.ts` and instead reattaches with
  `resume: "full"`, recovering the output of the command that kept running while
  the DO was gone.

---

## Gap 3 — cancellation doesn't kill the process

**Symptom.** Hackspace's per-call `cancelToolCall` RPC (and the turn-level Stop
button) aborts the model-side promise via `runCancellable`, so the loop unwinds —
but the command keeps running to completion in the container, holding CPU, disk
and the backend's mutation FIFO. A cancelled `npm install` is still installing.

**Already available.** `handle.kill(signal)`, exposed on both the local handle
and the stub.

**Proposal.** Honour the `abortSignal` the AI SDK already passes to `execute`:

```ts
const onAbort = () => { void handle.kill("SIGTERM"); };
abortSignal?.addEventListener("abort", onAbort, { once: true });
// …and after a grace period with no exit event, escalate to SIGKILL
```

Gate with `killOnAbort?: boolean | { signal?: KillSignal; graceMs?: number }`
if a caller ever wants detached semantics, but killing is the right default —
the caller has explicitly abandoned the call. This one is self-contained and
doesn't depend on Gap 1 or 2.

---

## Gap 4 — post-exec sync status is dropped on the floor

**Symptom.** `ExecResult.sync` can come back
`{ status: "pending", applied, skipped, error }`, meaning the pull that brings
container-side writes back into the authoritative VFS **did not finish**. The
tool discards it, so the model is told the command succeeded while some of its
file writes are not in the workspace yet, and nothing ever calls
`Workspace.retryPendingSync(id?)`. Silent data loss with a success-shaped
tool result is the worst failure mode in this list.

Hackspace's old exec output carried `pushed`, `pulled`, `synced` and surfaced
them in the UI (`exec-result.ts`, `buildExecToolOutput`); that visibility is
gone.

**Proposal.**

- Include the durability fields in the tool output:
  `{ pushed, pulled, skipped, sync }` — at minimum `sync.status`, and a
  human-readable warning line appended to the model-visible result when
  `status === "pending"` (the model should know that its writes may not be
  visible yet and that a retry is pending).
- Add an `onPendingSync` hook, or have the tool schedule
  `workspace.retryPendingSync(backendId)` itself, so a pending pull is retried
  rather than waiting for the next unrelated command to notice.
- In streaming mode the `exit` event needs to carry (or be followed by) the same
  summary, since `result()` is unavailable once the stream is consumed.

---

## Gap 5 — no per-call timeout

`ExecOptions.timeoutMs` exists but the tool never sets it and the stub type
doesn't accept it, so a hung command is bounded only by the DO invocation. A
`timeoutMs` option on `createExecTool` (plus a per-call `timeoutMs` input field,
capped by the factory value) would let a host bound `exec` without owning the
tool.

---

## Gap 6 — smaller parity losses from the migration

Not durability, but worth recording while the tool surface is being revisited:

- **Error shape.** The tool returns `error: string`; hackspace's wrapper and UI
  use `error: { details: string }`. `ExecToolView` now accepts both. A single
  structured shape (`{ error: { message, code? } }`) across the package's tools
  would let hosts stop normalising.
- **`requestedBackend` vs resolved backend.** The old output distinguished "the
  model asked for `container`" from "the default resolved to `shell`", which
  matters when debugging why a command ran where it did. Only the resolved
  backend survives.
- **`apply_patch`.** Hackspace used to swap `edit` for an OpenAI-style
  `apply_patch` tool when running on OpenAI models, which those models are
  heavily post-trained on. `createAITools` only offers `edit`. An
  `edit: { dialect: "apply_patch" }` variant would restore it for every consumer.
- **Retired fs tools.** `stat`, `mkdir`, `rm`, `find`, `grep` are gone; hackspace
  now tells the model to shell out to the `shell` backend for those, which is
  fine (just-bash in an isolate is cheap) but costs a round trip and prompt
  space versus a typed tool. Only worth adding if other consumers miss them.
- **Emptiness flags.** `stdoutEmpty` / `stderrEmpty` existed so the UI didn't
  have to distinguish "no output" from "not finished". With streaming (`running`)
  that distinction comes for free — noting it so it isn't lost twice.

---

## Suggested order

1. **Gap 3** (kill on abort) — smallest, no API surface change, stops orphaned
   container work today.
2. **Gap 4** (sync status in output + retry) — correctness bug, output-shape
   change only.
3. **Gap 2** (`id` / `timeoutMs` on the stub, `get()` on stub + client, exec id
   reported by the tool) — unlocks reattach and lets hackspace delete
   `orphan-tools.ts`.
4. **Gap 1** (streaming exec) — biggest, and needs the `@cloudflare/think`
   opt-out for tool-result draining to be agreed alongside it.
5. **Gap 5 / 6** — opportunistic.

## Acceptance tests worth having upstream

- Streaming: a command emitting 3 chunks over 3 ticks produces ≥3 preliminary
  tool outputs whose `stdout` grows monotonically, then one final output with
  `running: false` and the exit code.
- Truncation while streaming: total byte budget respected, final message reports
  the true dropped byte count.
- Abort: aborting the signal mid-command results in a killed process (exit
  event with a signal-derived code) and no further stdout events.
- Reattach: `exec` with a fixed id, drop the consumer, then `get(id, { resume:
  "full" })` from a *stub* client and observe the complete output including the
  events emitted while detached.
- Pending sync: a backend whose pull fails yields `sync.status === "pending"` in
  the tool output, and `retryPendingSync` is invoked (or reported).

## References

- Current tool: `packages/computer/src/tools/exec.ts` (`createExecTool`).
- Handle / options types: `ExecHandle`, `ExecOptions`, `GetExecOptions`,
  `ExecResult`, `WorkspaceExecEvent` in `packages/computer/src/shell.ts`.
- Stub surface to widen: `WorkspaceShellStub`, `WorkspaceExecOptions`,
  `WorkspaceExecHandleStub` in `packages/computer/src/stub.ts`; client side in
  `makeShellClient` / `rebuildExecHandle` (`with-workspace.ts`).
- Hackspace code this would delete: `apps/agent/src/orphan-tools.ts` and the
  legacy compatibility branches in
  `apps/frontend/src/components/ExecToolView.tsx`.
- Think's tool wrapper: `_wrapToolsWithDecision` in
  `@cloudflare/think@0.15.1` (`dist/think.js`).
- Prior hackspace implementations, for reference (deleted in commit `ff25075`):
  `apps/agent/src/exec-result.ts` (output shape incl. `pushed` / `pulled` /
  `synced`) and `apps/agent/src/streaming-tools.ts` (`splitStreamingTools`, the
  Think drain opt-out).
