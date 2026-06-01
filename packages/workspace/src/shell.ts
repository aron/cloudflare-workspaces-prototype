// Host-side WorkspaceShell facade.
//
// Wraps the ShellRPC half of a WorkspaceRPC stub. The docs/05
// contract: one entry point — exec() — that returns a detached
// handle. Callers either await `result()` (run-and-wait) or
// consume the ReadableStream directly (run-and-stream), or drop
// the handle entirely (fire-and-forget).
//
// Phase 8.5 bracket. WorkspaceShell holds the composite
// WorkspaceRPC (not just ShellRPC) so it can sample wsd's
// `currentRev` via SyncRPC.watermarks() around each exec. The
// rev delta from pre-exec to post-exit becomes ExecResult.pulled.
// `pushed` stays 0 under the thin-client architecture — there is
// no host-side store to push from; Workspace.fs.writeFile ships
// bytes synchronously, so by the time exec() is called the
// container has already seen them. The field is preserved for the
// docs/05 contract and will start carrying a non-zero count when
// the host gains a local store or batched push surface.

import type { ExecEvent, ShellRPC, WorkspaceRPC } from "@cloudflare/workspace-rpc";

export type ExecEncoding = "utf8" | undefined;

// The payload type for stdout/stderr chunks: Uint8Array by
// default, string when the caller passes encoding: "utf8".
type Chunk<E extends ExecEncoding> = E extends "utf8" ? string : Uint8Array;

export type WorkspaceExecEvent<E extends ExecEncoding = undefined> =
  | { id: string; seq: number; name: "stdout"; value: Chunk<E> }
  | { id: string; seq: number; name: "stderr"; value: Chunk<E> }
  | { id: string; seq: number; name: "exit"; value: number };

export interface ExecResult<E extends ExecEncoding = undefined> {
  exitCode: number;
  stdout: Chunk<E>;
  stderr: Chunk<E>;
  // VFS sync stats from the docs/05 bracket.
  //   pushed — changes the host uploaded before the command ran.
  //            Always 0 under the thin-client architecture, where
  //            Workspace.fs.writeFile ships synchronously and the
  //            host holds no local store to push from.
  //   pulled — wsd revs observed between exec() and the exit
  //            event. Best-effort: includes the spawned command's
  //            own writes plus anything else that landed in wsd
  //            during the window. v1 makes no attempt to isolate
  //            the command's writes from concurrent host writers.
  pushed: number;
  pulled: number;
}

export type KillSignal = "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";

// ExecHandle is a ReadableStream<WorkspaceExecEvent> with three
// extras tacked on. Implemented as the wire stream + extra own
// properties (id / result / kill) rather than a subclass for two
// reasons:
//
//   1. The wire stream comes back from capnweb already built;
//      subclassing means a pump-through layer that copies every
//      chunk for no behavioural gain.
//   2. pipeThrough (used for the utf8 transform) returns a plain
//      ReadableStream, so the subclass identity gets lost on the
//      first transform anyway.
export interface ExecHandle<E extends ExecEncoding = undefined>
  extends ReadableStream<WorkspaceExecEvent<E>> {
  readonly id: string;
  result(): Promise<ExecResult<E>>;
  kill(signal?: KillSignal): Promise<void>;
}

export interface ExecOptions<E extends ExecEncoding = undefined> {
  // Stable id. If omitted the runner mints a UUID. Reusing an id
  // while a previous run is still active throws EEXEC_BUSY.
  id?: string;
  // Absolute path inside the container. Defaults to the
  // workspace root.
  cwd?: string;
  // Encoding for stdout/stderr value payloads. Default is
  // Uint8Array; "utf8" decodes per-chunk through a stream-mode
  // TextDecoder so multi-byte boundaries survive.
  encoding?: E;
}

export interface GetExecOptions<E extends ExecEncoding = undefined> {
  encoding?: E;
  // "tail" yields only events produced after this call. A
  // number resumes from that seq+1. Omit to receive every
  // event from the start of the run (replays the whole log).
  resume?: "tail" | "full" | number;
}

export class WorkspaceShell {
  readonly #rpc: WorkspaceRPC;
  readonly #shell: ShellRPC;

  constructor(rpc: WorkspaceRPC) {
    this.#rpc = rpc;
    this.#shell = rpc.shell;
  }

  exec(command: string): Promise<ExecHandle<undefined>>;
  exec(command: string, options: ExecOptions<undefined>): Promise<ExecHandle<undefined>>;
  exec(command: string, options: ExecOptions<"utf8">): Promise<ExecHandle<"utf8">>;
  async exec<E extends ExecEncoding>(
    command: string,
    options: ExecOptions<E> = {},
  ): Promise<ExecHandle<E>> {
    // Snapshot wsd's currentRev BEFORE handing the exec to the
    // runner. Any rev advance between this read and the child's
    // exit event lands in ExecResult.pulled. Concurrent host
    // writers can also bump currentRev during the window; v1
    // accepts that the count is "revs observed during the exec",
    // not "revs the command itself produced". A per-exec
    // attribution would need wsd-side rev ranges scoped to the
    // child's pid — deferred.
    const preRev = await this.#rpc.sync.currentRev();
    const { id, events } = await this.#shell.exec({
      command,
      id: options.id,
      cwd: options.cwd,
    });
    return wrapHandle<E>(this.#rpc, id, events, options.encoding, preRev);
  }

  get(id: string): Promise<ExecHandle<undefined>>;
  get(id: string, options: GetExecOptions<undefined>): Promise<ExecHandle<undefined>>;
  get(id: string, options: GetExecOptions<"utf8">): Promise<ExecHandle<"utf8">>;
  async get<E extends ExecEncoding>(
    id: string,
    options: GetExecOptions<E> = {},
  ): Promise<ExecHandle<E>> {
    const after = resumeToAfter(options.resume);
    // Reattach can't recover the original pre-exec rev. Sample
    // currentRev now and report only the delta the reattached
    // observer sees from this point forward. For "full" replays
    // of an already-exited child the delta will be 0; for a
    // still-running child it's the revs that land between now
    // and exit.
    const preRev = await this.#rpc.sync.currentRev();
    const { events } = await this.#shell.getExec({ id, after });
    return wrapHandle<E>(this.#rpc, id, events, options.encoding, preRev);
  }
}

function resumeToAfter(resume: "tail" | "full" | number | undefined): number | "tail" | undefined {
  if (resume === undefined || resume === "full") return undefined;
  if (resume === "tail") return "tail";
  return resume;
}

// Stitch the runtime extras (id, result, kill) onto a fresh
// ReadableStream that pipes from the wire stream and applies any
// encoding conversion in flight.
function wrapHandle<E extends ExecEncoding>(
  rpc: WorkspaceRPC,
  id: string,
  wireEvents: ReadableStream<ExecEvent>,
  encoding: E | undefined,
  preRev: number,
): ExecHandle<E> {
  const stream = pipeEvents<E>(wireEvents, encoding);
  const handle = stream as ExecHandle<E>;
  // id / result / kill are not enumerable so JSON.stringify
  // on the handle (rare but plausible) doesn't trip on them.
  Object.defineProperties(handle, {
    id: { value: id, enumerable: false, writable: false },
    result: {
      value: () => drainToResult<E>(stream, encoding, rpc, preRev),
      enumerable: false,
      writable: false,
    },
    kill: {
      value: (signal?: KillSignal) => rpc.shell.killExec({ id, signal }),
      enumerable: false,
      writable: false,
    },
  });
  return handle;
}

function pipeEvents<E extends ExecEncoding>(
  source: ReadableStream<ExecEvent>,
  encoding: E | undefined,
): ReadableStream<WorkspaceExecEvent<E>> {
  if (encoding !== "utf8") {
    // Identity pipe — the wire shape already matches.
    return source as unknown as ReadableStream<WorkspaceExecEvent<E>>;
  }
  // Per-stream TextDecoders preserve multi-byte boundaries
  // across chunk splits.
  const stdoutDec = new TextDecoder("utf-8", { fatal: false });
  const stderrDec = new TextDecoder("utf-8", { fatal: false });
  return source.pipeThrough(
    new TransformStream<ExecEvent, WorkspaceExecEvent<E>>({
      transform(event, controller) {
        if (event.name === "stdout") {
          controller.enqueue({
            id: event.id,
            seq: event.seq,
            name: "stdout",
            value: stdoutDec.decode(event.value, { stream: true }) as Chunk<E>,
          });
        } else if (event.name === "stderr") {
          controller.enqueue({
            id: event.id,
            seq: event.seq,
            name: "stderr",
            value: stderrDec.decode(event.value, { stream: true }) as Chunk<E>,
          });
        } else {
          controller.enqueue(event as WorkspaceExecEvent<E>);
        }
      },
      flush(controller) {
        // Flush any trailing bytes the streaming decoder
        // held back. These are dropped on the floor today
        // — they'd land in an event with no seq attached.
        // In practice the child terminates its output with
        // a newline; partial multi-byte sequences at EOF
        // are rare. Note for follow-up if real callers see
        // truncation.
        stdoutDec.decode();
        stderrDec.decode();
        void controller;
      },
    }),
  );
}

async function drainToResult<E extends ExecEncoding>(
  stream: ReadableStream<WorkspaceExecEvent<E>>,
  encoding: E | undefined,
  rpc: WorkspaceRPC,
  preRev: number,
): Promise<ExecResult<E>> {
  const reader = stream.getReader();
  const stdoutParts: Array<Chunk<E>> = [];
  const stderrParts: Array<Chunk<E>> = [];
  let exitCode = -1;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.name === "stdout") stdoutParts.push(value.value);
      else if (value.name === "stderr") stderrParts.push(value.value);
      else exitCode = value.value;
    }
  } finally {
    reader.releaseLock();
  }
  // Sample currentRev after the stream drains — i.e. after the
  // exit event was emitted upstream. Anything wsd's applyChanges
  // committed during the child's lifetime is visible to this
  // read; subtracting preRev gives the bracket's pulled count.
  // Failures on the wire here are non-fatal per docs/05 "failed
  // pushes/pulls do not abort the command" — fall back to 0.
  let postRev = preRev;
  try {
    postRev = await rpc.sync.currentRev();
  } catch {
    // Leave postRev = preRev so pulled is 0; the exec's own
    // exit code is the contract the caller cares about.
  }
  return {
    exitCode,
    stdout: joinParts<E>(stdoutParts, encoding),
    stderr: joinParts<E>(stderrParts, encoding),
    pushed: 0,
    pulled: Math.max(0, postRev - preRev),
  };
}

function joinParts<E extends ExecEncoding>(
  parts: Array<Chunk<E>>,
  encoding: E | undefined,
): Chunk<E> {
  if (parts.length === 0) {
    return (encoding === "utf8" ? "" : new Uint8Array(0)) as Chunk<E>;
  }
  if (typeof parts[0] === "string") {
    return (parts as string[]).join("") as Chunk<E>;
  }
  const arrays = parts as Uint8Array[];
  const total = arrays.reduce((acc, a) => acc + a.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.byteLength;
  }
  return out as Chunk<E>;
}
