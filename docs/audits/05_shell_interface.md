# Audit: docs/05_shell_interface.md

Scope: spec-vs-implementation audit of the Shell interface. Code is
authoritative. Sources traced:

- `packages/workspace/src/shell.ts`
- `packages/workspace/src/shell.test.ts`
- `packages/workspace-rpc/src/interface.ts`
- `packages/workspace-rpc/src/server.ts`
- `packages/wsd/src/exec/{runner,types,schema,log,index}.ts`

The doc carries an explicit "intended design has diverged" banner, so a
fair amount of latitude is expected. Findings below focus on places
where the published shape is wrong vs. the implementation that actually
ships, plus a handful of design questions the divergence note leaves
open.

## Review

### Correct (verified against code)

- **`exec()` shape and overloading.** The doc's
  `exec<E extends "utf8" | undefined>(command, options?)` matches the
  three overloads in `shell.ts:120-126`. The generic chunk type
  `E extends "utf8" ? string : Uint8Array` is implemented exactly as
  `Chunk<E>` in `shell.ts:38`.
- **`ExecHandle` extends `ReadableStream<ExecEvent<T>>`.** Implemented
  as a wire stream with `id`/`result`/`kill` glued on via
  `Object.defineProperties` (`shell.ts:177-191`). The doc's rationale
  ("you can `for await` it") holds.
- **`ExecResult` fields `{ exitCode, stdout, stderr, pushed, pulled }`.**
  Matches `ExecResult<E>` in `shell.ts:45-58` and the bracket in
  `wrapHandle` / `drainToResult` (`shell.ts:130-141`, `260-272`).
- **`result()` drains the stream.** `drainToResult` reads to `done`
  and concatenates parts (`shell.ts:244-281`).
- **`kill()` default signal.** `runner.kill` defaults to `SIGTERM`
  when no signal is passed (`runner.ts:174`). Re-killing after exit is
  a no-op (`runner.ts:179`).
- **Re-using an id while active throws.** `runner.exec` raises
  `EEXEC_BUSY` (`runner.ts:96-97`), matching the doc's "One execution
  per `id` at a time".
- **Pre-exec push, post-exit pull bracket.** `exec()` calls
  `sync.push()` before spawning (`shell.ts:130-135`) and `sync.pull()`
  after the stream drains (`shell.ts:269-273`). Sync failures are
  swallowed and counts default to 0, matching "failed pushes/pulls do
  not abort the command".
- **utf8 decoding.** A `TransformStream` with two stateful
  `TextDecoder`s preserves multi-byte boundaries across chunks
  (`shell.ts:195-242`).
- **No stdin / no TTY.** Runner spawns with
  `stdio: ["ignore", "pipe", "pipe"]` (`runner.ts:106`).
- **Reattach via `get(id)`.** `shell.get()` calls `getExec({ id, after })`
  and returns a wrapped handle (`shell.ts:147-157`); `runner.get` seeds
  from the SQLite log when the record is gone (`runner.ts:158-172`).

### Drift — `doc-fix` (code wins, doc still useful)

- **`ExecEvent` is missing `seq`.** Doc (lines 62-65) defines events as
  `{ id, name, value }`. Code emits `{ id, seq, name, value }` on every
  wire and host event (`types.ts:9-12`, `shell.ts:40-43`). `seq` is
  load-bearing — it's the resume cursor for `get({ resume: <number> })`
  (`shell.ts:160-164`, `runner.ts:158-171`) — so hiding it from the
  public type erases a real capability. Add the field. Suggested:
  ```ts
  type ExecEvent<T extends string | Uint8Array = Uint8Array> =
    | { id: string; seq: number; name: "stdout"; value: T }
    | { id: string; seq: number; name: "stderr"; value: T }
    | { id: string; seq: number; name: "exit";   value: number };
  ```

- **`resume` accepts a numeric seq, not only `"tail" | "full"`.** Doc
  (line 36) types `resume?: "tail" | "full"`. Code accepts
  `"tail" | "full" | number` (`shell.ts:98`, `resumeToAfter` at
  `shell.ts:160-164`, runner consumes `after?: number | "tail"` at
  `runner.ts:158`). Either document the numeric variant or hide it
  behind a private extension. Today it's reachable and tested.

- **Pull only fires when `result()` is awaited.** Doc (lines 140-142)
  says "After the command exits ... the DO pulls every dirty change".
  Code attaches the pull to `drainToResult`, *not* to the stream's
  closing (`shell.ts:265-273`, and the long banner comment at
  `shell.ts:19-23`). Callers that consume the `ReadableStream`
  directly get the push but skip the pull. This is intentional per the
  source comments and is also why `pulled` is documented as observable
  only on `ExecResult`. Worth surfacing in 05 — current text implies an
  unconditional post-exec pull, which would surprise stream-only
  callers.

- **`get()` reattach skips the push frame.** Doc (lines 106-116) shows
  reattach via `get()` but doesn't mention that `pushed` reports 0 and
  the pull is best-effort. Documented in source as
  "Reattach doesn't own the original push frame" (`shell.ts:153-156`).
  Worth a one-liner in the doc's reattach example.

- **`cwd` validation isn't enforced.** Doc (lines 130-133) says
  container-local paths like `/tmp` are rejected and cwd "must be
  absolute". Code in the runner passes the value straight to
  `child_process.spawn` with no validation (`runner.ts:101-107`). If
  `cwd` is `undefined` the runner falls back to its configured default;
  if it's relative, `spawn` resolves it against the runner's cwd. See
  `needs-decision` below — either tighten the runner or relax the doc.

- **`kill()` does not wait for reaping.** Doc (lines 54-59) says
  `kill()` "resolves once the container has reaped the process". Code:
  `ShellRpcServer.killExec` calls `runner.kill`, which is synchronous
  `child.kill(signal)` (`runner.ts:174-181`); the awaited promise
  resolves as soon as the signal is delivered, not after the child
  exits. Real reaping is observed via the `exit` event on the stream /
  `result()`. Recommend: rewrite the doc to "Sends the signal;
  resolves once delivered. Observe `exit` for actual termination."

- **No "line-buffered" wire format.** Doc (line 154) says "The
  streamed wire format is line-buffered". Code emits each Node
  `Buffer` chunk as a `Uint8Array` with no line splitting
  (`runner.ts:121-125`). Sub-line latency is already there; the
  limitation is just whatever the kernel pipe + capnweb queue
  buffer. Either delete the bullet or rewrite it to describe the
  actual chunked-bytes shape.

- **`exit` value mapping isn't documented.** Code maps signal-only
  terminations to conventional codes (`mapExitCode`, `runner.ts:342-349`):
  SIGTERM→143, SIGKILL→137, SIGINT→130, SIGHUP→129, unknown→-1.
  Worth a sentence so callers know `exitCode === 137` means "killed"
  not "command's own 137".

- **Error codes aren't named.** Doc never names `EEXEC_BUSY`, `ENOENT`,
  or `ELOG_TRUNCATED`, all of which are exported from
  `@cloudflare/wsd` (`types.ts:46-55`) and reach the host as thrown
  errors. A short error-code section here would parallel docs/04's
  treatment of fs errors.

### `needs-decision`

- **`cwd` validation policy.** Either the runner should enforce that
  `cwd` is absolute and lives under the workspace root (matching the
  doc's promise of rejecting `/tmp`), or the doc should describe the
  actual permissive behaviour. The current state — "doc promises a
  guard, runner has none" — is the worst of both. Tag for product /
  security call.

- **`encoding: "utf8"` flush drop.** The TransformStream's `flush`
  decodes-with-stream-false but discards any returned tail bytes
  (`shell.ts:228-238`). The source already has a follow-up note
  ("dropped on the floor today"). Decide whether to (a) accept the
  loss (current), (b) emit a synthetic terminal chunk, or (c) raise.
  Either way, the doc should mention the chosen behaviour.

- **Detached / long-running execs.** Doc's own "Unknowns" section
  (lines 160-189) flags this. No code-side decision yet — the
  retention sweeper (`runner.ts:208-227`) reaps records 5 minutes
  after `exited_at`, but live execs are unbounded. Confirm this is
  the desired policy or add a cap.

### `code-fix` candidates (doc target worth keeping)

- **Hide `seq` from the public `ExecEvent`?** If the doc's flat event
  shape is the desired stable API, the host-side `WorkspaceExecEvent`
  could strip `seq` in `pipeEvents` (`shell.ts:195-242`) and expose it
  via a side channel (e.g., `handle.lastSeq`). I'd lean the other way
  (just document it), but it's a defensible code-side change.

- **Make `kill()` await exit.** If the doc's "resolves once reaped"
  semantics are desirable, `shell.ts`'s `kill` wrapper could attach to
  the runner's `child.once("exit", ...)` and resolve there. Today it's
  fire-and-forget. Small change, callers may already expect it.

- **Enforce absolute `cwd` in `Runner.exec`.** Cheap guard
  (`path.isAbsolute(cwd)` + workspace-root prefix check) would make
  the doc true and is consistent with the rest of workspace-fs's
  absolute-path-or-throw discipline.

### Notes

- Doc says `exec()` is "detached: it returns immediately with an
  `ExecHandle`" (lines 20-23). Verified: `shell.exec` awaits only the
  RPC round-trip plus the pre-exec push, then returns. The child runs
  independently of `result()`.
- Doc's encoding examples use `process.stdout.write(event.value)`
  with `encoding: "utf8"` — works because `event.value` is a string in
  that mode. With the default Uint8Array path, `process.stdout.write`
  also accepts the buffer. No correction needed.
- Doc says ignore-pattern default is `["node_modules"]`. That's a
  sync-layer concern, not the shell's, and is out of scope for this
  audit; flagged here only so 05 doesn't get a stray "wrong" tag
  during follow-up.
- `disposeExec` exists on the wire (`interface.ts:121-123`) but is
  not exposed on `WorkspaceShell`. The doc correctly stays silent;
  noted only because retention is otherwise driven entirely by the
  sweeper.
- The doc's claim that "Every `exec` is wrapped by an incremental
  push ... before the command runs and an incremental pull ... after
  it exits, so the VFS is always the authoritative copy after the call
  returns" needs the qualifier from the pull-on-result drift above —
  "after the call returns" is true for `await result()`, not for
  stream-only consumers.
