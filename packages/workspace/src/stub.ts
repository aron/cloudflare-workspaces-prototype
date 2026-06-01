// WorkspaceStub — wraps a host-side Workspace as an RpcTarget so it
// can be handed across the Workers RPC boundary.
//
// Construct it via `workspace.stub()` — the Workspace class owns
// the lifecycle and the WorkspaceStub just delegates.
//
// Usage shape:
//
//   // Inside a DO that owns the live wsd connection:
//   class WsdContainer extends DurableObject {
//     #workspace = new Workspace({ backends: [...] });
//     async getWorkspace(): Promise<WorkspaceStub> {
//       await this.#workspace.ready();
//       return this.#workspace.stub();
//     }
//   }
//
//   // From a Worker (or another DO):
//   const ws = await env.WSD.get(id).getWorkspace();
//   await ws.fs.writeFile("/foo", bytes);
//   const handle = await ws.shell.exec("ls /workspace");
//   const { exitCode, stdout, stderr } = await handle.result();
//
// All the SyncRPC streaming (push / pushObjects / fetchObjects /
// fetchChanges) happens on the capnweb wire inside the DO. What
// crosses the Workers-RPC boundary here is only the high-level
// value-shaped facade — writeFile / readFile / stat / exec —
// because Workers RPC doesn't carry non-byte ReadableStreams or
// capnweb stubs.
//
// Streaming exec is intentionally absent from this surface for
// now. Workers RPC only carries ReadableStream<Uint8Array>, so a
// streamed exec would have to frame events as bytes (SSE, length-
// prefixed JSON, etc.) — punted until we have a concrete caller
// that needs it. Today exec() returns a handle whose only method
// is result(), matching the run-and-wait half of WorkspaceShell.
//
// RpcTarget comes from capnweb rather than `cloudflare:workers`.
// Per capnweb's docs, that import is an alias for the workerd
// builtin when running under workerd, so the runtime behaviour is
// identical; the difference is that capnweb's export resolves
// under both workerd and node (tests, type-only consumers), while
// `cloudflare:workers` only resolves under workerd.

import type {
  GrepOptions,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  WorkspaceDirentResult,
  WorkspaceFoundEntry,
  WorkspaceGrepMatch,
  WorkspaceStatResult,
  WriteFileContent,
  WriteFileOptions,
} from "@cloudflare/workspace-fs";
import { RpcTarget } from "capnweb";

import type { ExecResult } from "./shell.js";
import type { Workspace } from "./workspace.js";

export interface WorkspaceExecOptions {
  cwd?: string;
  // "utf8" decodes stdout/stderr chunks through a streaming
  // TextDecoder so multi-byte boundaries survive. Default leaves
  // bytes as Uint8Array.
  encoding?: "utf8";
}

export interface WorkspaceExecResult<E extends "utf8" | undefined = undefined> {
  exitCode: number;
  stdout: E extends "utf8" ? string : Uint8Array;
  stderr: E extends "utf8" ? string : Uint8Array;
}

// Filesystem half. A direct proxy onto Workspace.fs — every
// public WorkspaceFilesystem method is mirrored verbatim so the
// remote surface matches the in-process surface one-for-one.
//
// All argument and return types are already JSRPC-compatible:
// strings, plain objects, Uint8Array, and a single byte-shaped
// ReadableStream<Uint8Array> on readFile. writeFile's
// WriteFileContent union includes ReadableStream<Uint8Array> for
// the same reason.
export class WorkspaceFilesystemStub extends RpcTarget {
  readonly #ws: Workspace;

  constructor(ws: Workspace) {
    super();
    this.#ws = ws;
  }

  // --- Reads -------------------------------------------------------

  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(path: string, options: ReadFileOptions): Promise<string | ReadableStream<Uint8Array>>;
  readFile(
    path: string,
    optionsOrEncoding?: "utf8" | ReadFileOptions,
  ): Promise<string | ReadableStream<Uint8Array>> {
    return this.#ws.fs.readFile(path, optionsOrEncoding as ReadFileOptions);
  }

  stat(path: string): Promise<WorkspaceStatResult> {
    return this.#ws.fs.stat(path);
  }

  readdir(path: string): Promise<WorkspaceDirentResult[]> {
    return this.#ws.fs.readdir(path);
  }

  find(directory: string, pattern?: string): Promise<WorkspaceFoundEntry[]> {
    return this.#ws.fs.find(directory, pattern);
  }

  ls(prefix: string): Promise<string[]> {
    return this.#ws.fs.ls(prefix);
  }

  grep(pattern: string, path: string, options: GrepOptions = {}): Promise<WorkspaceGrepMatch[]> {
    return this.#ws.fs.grep(pattern, path, options);
  }

  // --- Mutations ---------------------------------------------------

  writeFile(
    path: string,
    content: WriteFileContent,
    options: WriteFileOptions = {},
  ): Promise<void> {
    return this.#ws.fs.writeFile(path, content, options);
  }

  mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    return this.#ws.fs.mkdir(path, options);
  }

  rm(path: string, options: RmOptions = {}): Promise<void> {
    return this.#ws.fs.rm(path, options);
  }
}

// Exec handle returned from WorkspaceShellStub.exec. Holds the
// underlying ExecHandle on the DO side and exposes only the
// run-and-wait half of its API — result() — because Workers RPC
// can't carry the non-byte event stream that ExecHandle is.
//
// kill() and event streaming are deliberately omitted for now;
// they'd need a byte-framed transport (SSE, length-prefixed
// JSON) and we don't have a caller for that yet. When that lands
// it goes here as a new method, not as a replacement for this
// one.
export class WorkspaceExecHandleStub<E extends "utf8" | undefined = undefined> extends RpcTarget {
  readonly #pending: Promise<ExecResult<E>>;

  constructor(pending: Promise<ExecResult<E>>) {
    super();
    this.#pending = pending;
  }

  async result(): Promise<WorkspaceExecResult<E>> {
    const result = await this.#pending;
    return {
      exitCode: result.exitCode,
      // joinParts in shell.ts returns string for "utf8",
      // Uint8Array otherwise — exactly the
      // WorkspaceExecResult shape.
      stdout: result.stdout as WorkspaceExecResult<E>["stdout"],
      stderr: result.stderr as WorkspaceExecResult<E>["stderr"],
    };
  }
}

// Shell half. exec() returns an RpcTarget handle whose only
// method today is result(). Streaming exec lands as a separate
// method when a concrete caller needs it; see the note at the
// top of this file.
export class WorkspaceShellStub extends RpcTarget {
  readonly #ws: Workspace;

  constructor(ws: Workspace) {
    super();
    this.#ws = ws;
  }

  exec(command: string): Promise<WorkspaceExecHandleStub<undefined>>;
  exec(
    command: string,
    options: WorkspaceExecOptions & { encoding: "utf8" },
  ): Promise<WorkspaceExecHandleStub<"utf8">>;
  exec(command: string, options: WorkspaceExecOptions): Promise<WorkspaceExecHandleStub<undefined>>;
  async exec(
    command: string,
    options: WorkspaceExecOptions = {},
  ): Promise<WorkspaceExecHandleStub<"utf8" | undefined>> {
    // Kick off the exec eagerly so the caller's first round trip
    // (the one that built this stub) already has the spawn in
    // flight. result() awaits the handle's own result() when the
    // caller asks.
    const pending: Promise<ExecResult<"utf8" | undefined>> =
      options.encoding === "utf8"
        ? this.#ws.shell
            .exec(command, { cwd: options.cwd, encoding: "utf8" })
            .then((handle) => handle.result())
        : this.#ws.shell.exec(command, { cwd: options.cwd }).then((handle) => handle.result());
    return new WorkspaceExecHandleStub<"utf8" | undefined>(pending);
  }
}

// Top-level wrapper. Two sub-RpcTargets let callers use promise
// pipelining: `stub.fs.writeFile(...)` is one round trip, not two.
//
// Construct via `workspace.stub()` rather than directly — the
// Workspace owns the lifecycle and the stub just delegates.
//
// Note the name collision: the *type* `WorkspaceRPC` is also
// exported by @cloudflare/workspace-rpc as the wire contract
// between wsd and the DO. WorkspaceStub here is a different thing
// (the Workers-RPC value carried between the DO and a Worker), so
// the name doesn't clash.
export class WorkspaceStub extends RpcTarget {
  // Getters rather than instance properties so Workers RPC
  // exposes them through the stub proxy. Plain readonly fields
  // set in the constructor land as private isolate state and the
  // proxy reports "method not implemented".
  readonly #fs: WorkspaceFilesystemStub;
  readonly #shell: WorkspaceShellStub;

  constructor(ws: Workspace) {
    super();
    this.#fs = new WorkspaceFilesystemStub(ws);
    this.#shell = new WorkspaceShellStub(ws);
  }

  get fs(): WorkspaceFilesystemStub {
    return this.#fs;
  }

  get shell(): WorkspaceShellStub {
    return this.#shell;
  }
}
