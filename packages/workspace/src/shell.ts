// Host-side WorkspaceShell facade.
//
// Wraps the ShellRPC half of a WorkspaceRPC stub. The docs/05
// contract: one entry point — exec() — that returns a detached
// handle. Callers either await `result()` (run-and-wait) or
// consume the ReadableStream directly (run-and-stream), or drop
// the handle entirely (fire-and-forget).
//
// Every exec() call brackets the spawn with the docs/05 sync
// frames:
//   - pushOnce(db, rpc.sync) runs *before* the spawn so any
//     host-side writes since the last push are visible to the
//     command.
//   - pullOnce(db, rpc.sync) runs *after* the stream drains (i.e.
//     after the exit event), so anything the command produced is
//     visible to subsequent Workspace.fs reads.
// The pushed / pulled counts land in ExecResult.
//
// Pull only fires when the caller awaits handle.result(). A
// caller that consumes the stream directly gets the push but not
// the pull — docs/05 puts the pull after the exit event, which
// only result() observes. If you need the pull in that flow,
// drive the stream yourself then call Workspace.pull() explicitly.
//
// get() (reattach) is intentionally not bracketed. Reattaching
// to an already-running exec doesn't represent a new push frame.
// The result() of a reattached handle reports pushed = 0 and the
// pulled count from a pull that runs after its own drain — best-
// effort, can be 0 if nothing landed in wsd between reattach and
// drain.

import type { ExecEvent, ShellRPC } from "@cloudflare/workspace-rpc";

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
  //   pushed — entries shipped by the pre-exec pushOnce.
  //   pulled — entries applied by the post-drain pullOnce.
  // Both fields are populated only when handle.result() is
  // awaited. Consuming the stream directly leaves pulled at 0;
  // pushed is observed before the stream is returned, so it
  // reflects the real push count either way.
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

// Push/pull bracket plumbing. WorkspaceShell doesn't know about
// the local Database or the SyncRPC wire — the host wires both
// behind a Sync object that exposes the entry counts.
// Workspace itself satisfies this interface (push() / pull() are
// public methods); tests pass a plain { push, pull } object.
export interface Sync {
  push(): Promise<number>;
  pull(): Promise<number>;
}

export class WorkspaceShell {
  readonly #shell: ShellRPC;
  readonly #sync: Sync;

  constructor(shell: ShellRPC, sync: Sync) {
    this.#shell = shell;
    this.#sync = sync;
  }

  exec(command: string): Promise<ExecHandle<undefined>>;
  exec(command: string, options: ExecOptions<undefined>): Promise<ExecHandle<undefined>>;
  exec(command: string, options: ExecOptions<"utf8">): Promise<ExecHandle<"utf8">>;
  async exec<E extends ExecEncoding>(
    command: string,
    options: ExecOptions<E> = {},
  ): Promise<ExecHandle<E>> {
    // Pre-exec push: ship anything the host wrote since the last
    // push so the spawned command sees it. Failures non-fatal per
    // docs/05 — the command still runs; pushed reports 0.
    let pushed = 0;
    try {
      pushed = await this.#sync.push();
    } catch {
      // pushed stays 0
    }
    const { id, events } = await this.#shell.exec({
      command,
      id: options.id,
      cwd: options.cwd,
    });
    return wrapHandle<E>(this.#shell, this.#sync, id, events, options.encoding, pushed);
  }

  get(id: string): Promise<ExecHandle<undefined>>;
  get(id: string, options: GetExecOptions<undefined>): Promise<ExecHandle<undefined>>;
  get(id: string, options: GetExecOptions<"utf8">): Promise<ExecHandle<"utf8">>;
  async get<E extends ExecEncoding>(
    id: string,
    options: GetExecOptions<E> = {},
  ): Promise<ExecHandle<E>> {
    const after = resumeToAfter(options.resume);
    const { events } = await this.#shell.getExec({ id, after });
    // Reattach doesn't own the original push frame: pushed = 0.
    // The post-drain pull still fires, scoped to whatever lands
    // between reattach and the next drain.
    return wrapHandle<E>(this.#shell, this.#sync, id, events, options.encoding, 0);
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
  shell: ShellRPC,
  sync: Sync,
  id: string,
  wireEvents: ReadableStream<ExecEvent>,
  encoding: E | undefined,
  pushed: number,
): ExecHandle<E> {
  const stream = pipeEvents<E>(wireEvents, encoding);
  const handle = stream as ExecHandle<E>;
  Object.defineProperties(handle, {
    id: { value: id, enumerable: false, writable: false },
    result: {
      value: () => drainToResult<E>(stream, encoding, sync, pushed),
      enumerable: false,
      writable: false,
    },
    kill: {
      value: (signal?: KillSignal) => shell.killExec({ id, signal }),
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
  sync: Sync,
  pushed: number,
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
  // Post-drain pull: apply anything wsd produced during the exec.
  // Failures non-fatal per docs/05 ("failed pushes/pulls do not
  // abort the command"); pulled stays 0 in that case.
  let pulled = 0;
  try {
    pulled = await sync.pull();
  } catch {
    // pulled stays 0
  }
  return {
    exitCode,
    stdout: joinParts<E>(stdoutParts, encoding),
    stderr: joinParts<E>(stderrParts, encoding),
    pushed,
    pulled,
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
