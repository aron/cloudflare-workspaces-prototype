# 05. Shell Interface

`Workspace.shell` runs commands inside the sandbox container against the
same filesystem tree the DO writes to. Every `exec` is wrapped by an
incremental push (DO → container) before the command runs and an
incremental pull (container → DO) after it exits, so the VFS is always
the authoritative copy after the call returns.

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
    options?: { id?: string; cwd?: string; encoding?: E },
  ): Promise<ExecHandle<E extends "utf8" ? string : Uint8Array>>;

  get<E extends "utf8" | undefined = undefined>(
    id: string,
    options?: { encoding?: E; resume?: "tail" | "full" },
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
   * for an unconditional kill. Resolves once the container has reaped
   * the process. Safe to call after exit (no-op).
   */
  kill(signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP"): Promise<void>;
}

type ExecEvent<T extends string | Uint8Array = Uint8Array> =
  | { id: string; name: "stdout"; value: T }
  | { id: string; name: "stderr"; value: T }
  | { id: string; name: "exit";   value: number };

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
for await (const event of run) {
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
[01. Directory Structure](./01_directory_structure.md)). It must be an
absolute path inside the workspace; container-local paths (e.g. `/tmp`)
are rejected.

## Sync semantics

- **Before** the command runs, every DO-side change the container
  hasn't seen is pushed, and lazy-mount stubs the command might touch
  are hydrated. See [02. Sync Protocol](./02_sync_protocol.md).
- **After** the command exits (any exit code, including non-zero), the
  DO pulls every dirty change the command produced. Files matching
  `pullIgnore` (default `["node_modules"]`) stay in the container only.
- For read-write mounts, container-side writes under the mount root are
  mirrored back to the provider after the pull (provider first, then
  VFS).
- Failed pushes/pulls do not abort the command — `exec()` reports the
  command's own exit code. Sync errors surface as thrown rejections
  separately.

## Limits

- One execution per `id` at a time. Reusing an id while a previous run
  is still active throws.
- The streamed wire format is line-buffered. For sub-line latency, the
  container would need a different transport.
- Commands run as a single non-interactive process. No TTY allocation.
  Write inputs to a file with `fs.writeFile` first if a command needs
  stdin.

## Unknowns

The following behaviours are not fully specified yet and may change
before the API is stable. File an issue if your use case depends on a
particular resolution.

- **Long-running execs.** `exec` is detached, so there's nothing
  stopping you from kicking off a process that outlives the request
  that started it (a dev server, a file watcher, a `tail -f`). Open
  questions: what's the cap on concurrent live execs per workspace?
  How does the post-exec pull behave when "post-exec" is hours away?
  Do live processes count against the sandbox container's lifetime
  policy? Today the answer is "they keep running until the container
  is reaped"; a future revision will likely add an explicit
  `detach: true` opt-in plus a process registry.
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
