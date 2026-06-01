# 05. Shell Interface

> [!NOTE]
> Parts of this document describe **target behaviour** that the code
> doesn't fully ship yet — primarily `kill()` waiting for reap, the
> `timeoutMs` cap on live execs, `cwd` validation, and `pause()` /
> `resume()` on the host handle. Each one is called out inline as
> "planned" so callers know which guarantees to lean on today vs.
> wait for. Everything else has been reconciled with what `main`
> actually ships.

`Workspace.shell` runs commands inside the sandbox container against the
same filesystem tree the DO writes to. Every `exec` is wrapped by an
incremental push (DO → container) before the command runs and an
incremental pull (container → DO) after it exits, so the VFS is the
authoritative copy after the call returns. The "after" half of that
bracket is qualified — see [Sync semantics](#sync-semantics) below.

> [!NOTE]
> The package intentionally exposes **one** entry point — `exec()` — and
> not a separate `spawn` / `childProcess` surface. Every `exec` is
> detached: it returns immediately with an `ExecHandle`, and you await
> `result()` (or consume the event stream) to observe completion. If you
> want fire-and-forget, throw the handle away. If you want
> run-and-wait, `await handle.result()`. There is no third mode.

## API

```ts
interface WorkspaceShell {
  exec<E extends "utf8" | undefined = undefined>(
    command: string,
    options?: {
      id?: string;
      cwd?: string;
      encoding?: E;
      /**
       * Hard cap on how long the child may live before the runner
       * sends `SIGKILL`. Defaults to ~320_000 ms. Pass a larger value
       * for known long-running work; pass a smaller value to fail
       * fast. Planned — not yet enforced (see "Limits").
       */
      timeoutMs?: number;
    },
  ): Promise<ExecHandle<E extends "utf8" ? string : Uint8Array>>;

  get<E extends "utf8" | undefined = undefined>(
    id: string,
    options?: {
      encoding?: E;
      /**
       * `"tail"` — resume from the live tail (default).
       * `"full"` — replay every recorded event from `seq` 0.
       * `number` — resume strictly after the given `seq`. Used by
       *            clients that recorded the last `seq` they saw and
       *            want exactly-once delivery across a reconnect.
       */
      resume?: "tail" | "full" | number;
    },
  ): Promise<ExecHandle<E extends "utf8" ? string : Uint8Array>>;
}

/**
 * `T` is the payload type for stdout/stderr chunks:
 *   - `Uint8Array` for the default (binary) call signature.
 *   - `string`     when `encoding: "utf8"` was passed.
 */
interface ExecHandle<T extends string | Uint8Array = Uint8Array>
  extends ReadableStream<ExecEvent<T>>
{
  /** Stable id for this execution. Pass to `shell.get(id)` to reattach. */
  readonly id: string;

  /** Resolves when the command exits. Drains the stream internally. */
  result(): Promise<ExecResult<T>>;

  /**
   * Terminate the running command. Defaults to SIGTERM; pass `"SIGKILL"`
   * for an unconditional kill. Resolves once the child has exited —
   * equivalent to awaiting the `exit` event. Safe to call after exit
   * (no-op).
   *
   * Planned: today `kill()` is fire-and-forget after signal delivery
   * and resolves as soon as the signal is queued. The reap-await
   * semantics described above are the target.
   */
  kill(signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP"): Promise<void>;

  /**
   * Planned. Pause/resume the underlying child's stdout/stderr without
   * consuming the event stream. Useful for callers that want to gate a
   * command (e.g., wait for an external go-ahead) without holding the
   * stream open in a `for await`. Not yet shipped.
   */
  pause?(): Promise<void>;
  resume?(): Promise<void>;
}

type ExecEvent<T extends string | Uint8Array = Uint8Array> =
  | { id: string; seq: number; name: "stdout"; value: T }
  | { id: string; seq: number; name: "stderr"; value: T }
  | { id: string; seq: number; name: "exit";   value: number };

interface ExecResult<T extends string | Uint8Array = Uint8Array> {
  exitCode: number;
  stdout:   T;
  stderr:   T;
  pushed:   number;   // VFS changes uploaded before the command
  pulled:   number;   // VFS changes downloaded after the command
}
```

The generic `T` on `ExecHandle`, `ExecEvent`, and `ExecResult` is
inferred from the call signature: `exec(cmd)` returns
`ExecHandle<Uint8Array>`, and `exec(cmd, { encoding: "utf8" })` returns
`ExecHandle<string>`. There is no mixed mode — every chunk in a single
execution shares the same payload type.

### `seq` and resume

Every event carries a monotonically increasing `seq`. The runner
records events in its per-exec log, and `seq` is the cursor `get()`
uses to position a resume:

- `resume: "tail"` — start from the live tail, dropping anything that
  happened before reattach.
- `resume: "full"` — replay from `seq` 0. Useful for tooling that wants
  the complete transcript.
- `resume: <number>` — deliver only events strictly after the given
  `seq`. The usual pattern is "remember the last `seq` you saw, pass
  it back after the reconnect".

## Usage

Run-and-wait:

```ts
const run = await workspace.shell.exec("zig build", {
  cwd: "/workspace",
  encoding: "utf8",
});
const { exitCode, stdout, stderr } = await run.result();
if (exitCode !== 0) throw new Error(stderr);
```

Stream stdout as the command runs:

```ts
const run = await workspace.shell.exec("npm test", { encoding: "utf8" });
let lastSeq = -1;
for await (const event of run) {
  lastSeq = event.seq;
  if (event.name === "stdout") process.stdout.write(event.value);
  if (event.name === "stderr") process.stderr.write(event.value);
  if (event.name === "exit")   console.log(`exit ${event.value}`);
}
```

Reattach to a long-running execution after a reconnect:

```ts
const run = await workspace.shell.exec("npm ci", {
  id: "install-1",
  encoding: "utf8",
});
// ... DO restart ...
const same = await workspace.shell.get("install-1", { resume: "tail" });
const { exitCode } = await same.result();
```

Reattach via `get()` skips the original push frame: `pushed` reports
`0` on the resulting `ExecResult`, and the post-exit pull is
best-effort — the reattached handle didn't own the bracket, so it
doesn't promise it.

Cancel a running command:

```ts
const run = await workspace.shell.exec("./long-running.sh");
// ...elsewhere...
await run.kill();                  // SIGTERM
// or, after a grace period:
await run.kill("SIGKILL");
```

## Working directory

`cwd` is optional and defaults to the workspace root (see
[01. VFS](./01_vfs.md)). The target validation rejects any value that
isn't an absolute path under the workspace root — container-local
paths like `/tmp` will fail, as will relative paths that would
otherwise resolve against the runner's own cwd. **Planned**: the
runner currently passes `cwd` straight to `child_process.spawn` with
no validation. Don't rely on the guard until it lands.

## Sync semantics

- **Before** the command runs, every DO-side change the container
  hasn't seen is pushed, and lazy-mount stubs the command might touch
  are hydrated. See [02. Sync Protocol](./02_sync_protocol.md).
- **After** the command exits (any exit code, including non-zero), the
  DO pulls every dirty change the command produced — but only when
  the caller awaits `result()`. The pull is wired to `result()`, not
  to the stream closing, so callers that iterate the `ReadableStream`
  directly without ever calling `result()` get the push frame but
  skip the post-exit pull. This is intentional: `result()` is the
  contract for "I want the VFS reconciled before I move on".
  Equivalently, `pushed` / `pulled` counts on `ExecResult` are only
  observable through `result()`.
- For read-write mounts, container-side writes under the mount root
  are mirrored back to the provider after the pull (provider first,
  then VFS).
- Failed pushes/pulls do not abort the command — `exec()` reports the
  command's own exit code. Sync errors surface as thrown rejections
  separately.

## Wire format and backpressure

Stdout and stderr are emitted as **chunked bytes** — each Node
`Buffer` the kernel hands us becomes one `ExecEvent` whose `value` is
a `Uint8Array` (or the decoded `string` slice under
`encoding: "utf8"`). There is no line splitting and no in-process
buffer larger than the kernel pipe.

Backpressure is **pull-based**, end to end, via the WHATWG
`ReadableStream` contract:

1. The consumer (host iterator, or capnweb's flow controller for a
   remote consumer) stops pulling.
2. The runner's `ReadableStream` for the exec stops issuing `pull`
   callbacks.
3. The runner pauses the child's stdout/stderr Node `Readable`s.
4. The kernel pipe fills.
5. The child blocks on `write(2)`.

No ring buffer, no spill threshold, no in-process queue past what the
stream contract permits. (Earlier drafts of this doc described a 1 MiB
spill-to-log behaviour; that was never implemented and the design has
landed on pull-based flow control instead.)

## Exit-code mapping

`exit.value` is the child's own exit code when it exits normally. When
the child is terminated by a signal the runner maps the signal to a
conventional code so the wire stays a plain `number`:

| Signal    | `exitCode` |
| --------- | ---------- |
| SIGTERM   | 143        |
| SIGKILL   | 137        |
| SIGINT    | 130        |
| SIGHUP    | 129        |
| (unknown) | -1         |

So `exitCode === 137` means "killed by SIGKILL", not "the command's
own 137". Callers that need to distinguish "killed by us" from "killed
itself with that code" should track whether they called `kill()`.

## Encoding

`encoding: "utf8"` decodes each chunk through a stateful `TextDecoder`
so multi-byte boundaries are preserved across chunk edges.

**Known loss**: any tail bytes returned by the decoder's final flush
at end-of-stream are dropped today. In practice this only bites when
the child exits mid-codepoint, which well-behaved programs don't do,
but the silent-loss behaviour is on the revisit list.

## Limits

- One execution per `id` at a time. Reusing an id while a previous
  run is still active throws `EEXEC_BUSY`.
- Commands run as a single non-interactive process. No TTY allocation.
  Write inputs to a file with `fs.writeFile` first if a command needs
  stdin.
- Live execs are bounded by `timeoutMs` (default ~320_000 ms,
  per-call extensible). When the cap fires the runner sends `SIGKILL`
  and emits a normal `exit` event with code `137`. **Planned**: the
  current code has no cap; live execs run until the container is
  reaped. Don't rely on the cap until it lands.
- Per-exec log retention defaults: up to 16 MiB of recorded events
  per exec, kept for 5 minutes after exit. Both limits are
  extensible. When the byte cap is exceeded, the oldest events are
  evicted and subsequent `get({ resume: <number> })` calls below the
  retained window throw `ELOG_TRUNCATED`. After the TTL elapses the
  exec record is reaped and lookups throw `ENOENT`.

## Errors

| Code              | Thrown when                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `EEXEC_BUSY`      | `exec(..., { id })` is called while another exec with the same `id` is still active.                         |
| `ELOG_TRUNCATED`  | `get({ resume: <seq> })` requests a `seq` that's been evicted past the per-exec retention cap (default 16 MiB). |
| `ENOENT`          | `get(id)` is called for an `id` that was never recorded, or whose retention TTL (default 5 min) has elapsed. |

These errors propagate as thrown rejections from the host call. They
parallel the filesystem error surface in
[04. Filesystem Interface](./04_filesystem_interface.md).

## Unknowns

The following behaviours are not fully specified yet and may change
before the API is stable. File an issue if your use case depends on a
particular resolution.

- **File watchers.** Tools like `vitest --watch`, `next dev`, and
  `tsc --watch` produce a continuous stream of writes inside the
  container. The pull watermark advances on `exec()` boundaries, so a
  watcher's intermediate writes don't reach the DO until the next
  `exec()` or explicit `workspace.pull()`. Whether the workspace
  should grow a "live sync" mode that streams container revisions to
  the DO as they happen is an open design question.
- **Overlapping execs.** Two `exec` calls with different `id`s can be
  in flight at the same time. The push/pull cycles around them are
  not currently consolidated — each `exec` does its own push before
  starting and its own pull after exiting, which can mean redundant
  work and surprising interleavings of dirty state. We plan to add
  batch consolidation (one push covering every pending exec, one pull
  draining everything in flight) but the exact semantics aren't
  decided.
- **Stdin.** No streaming stdin today. The current workaround is to
  write the input to a file and `<` it in the command, but a proper
  stdin stream on the `ExecHandle` is on the table.

See [07. Injected Service](./07_injected_service.md) for how `exec()` is
served inside the container and
[08. Capnweb Interface](./08_capnweb_interface.md) for the RPC framing.
