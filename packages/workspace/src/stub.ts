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
//   using ws = await env.WSD.get(id).getWorkspace();
//   await ws.fs.writeFile("/foo", bytes);
//   const out = await ws.shell.exec("ls /workspace");
//
// All the SyncRPC streaming (push / pushObjects / fetchObjects /
// fetchChanges) happens on the capnweb wire inside the DO. What
// crosses the Workers-RPC boundary here is only the high-level
// value-shaped facade — writeFile / readFile / stat / exec —
// because Workers RPC doesn't carry non-byte ReadableStreams or
// capnweb stubs.
//
// RpcTarget comes from capnweb rather than `cloudflare:workers`.
// Per capnweb's docs, that import is an alias for the workerd
// builtin when running under workerd, so the runtime behaviour is
// identical; the difference is that capnweb's export resolves
// under both workerd and node (tests, type-only consumers), while
// `cloudflare:workers` only resolves under workerd.

import type { WorkspaceStatResult } from "@cloudflare/workspace-fs";
import { RpcTarget } from "capnweb";

import type { ExecResult, WorkspaceExecEvent } from "./shell.js";
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

// Filesystem half. Methods mirror WorkspaceFs but with the small
// adaptations Workers RPC needs: bodies as ArrayBuffer or Uint8Array
// only, no streams.
export class WorkspaceFsStub extends RpcTarget {
  readonly #ws: Workspace;

  constructor(ws: Workspace) {
    super();
    this.#ws = ws;
  }

  async writeFile(path: string, body: ArrayBuffer | Uint8Array): Promise<void> {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    await this.#ws.fs.writeFile(path, bytes);
  }

  async readFile(path: string): Promise<ReadableStream<Uint8Array>> {
    return await this.#ws.fs.readFile(path);
  }

  async stat(path: string): Promise<WorkspaceStatResult> {
    return await this.#ws.fs.stat(path);
  }
}

// Shell half. Run-and-collect only for v1. Streaming exec needs a
// byte-framed ReadableStream<Uint8Array> on the wire — slot in
// later as `execStream` without breaking this surface.
export class WorkspaceShellStub extends RpcTarget {
  readonly #ws: Workspace;

  constructor(ws: Workspace) {
    super();
    this.#ws = ws;
  }

  exec(command: string): Promise<WorkspaceExecResult<undefined>>;
  exec(
    command: string,
    options: WorkspaceExecOptions & { encoding: "utf8" },
  ): Promise<WorkspaceExecResult<"utf8">>;
  exec(command: string, options: WorkspaceExecOptions): Promise<WorkspaceExecResult<undefined>>;
  async exec(
    command: string,
    options: WorkspaceExecOptions = {},
  ): Promise<WorkspaceExecResult<"utf8" | undefined>> {
    const handle =
      options.encoding === "utf8"
        ? await this.#ws.shell.exec(command, { cwd: options.cwd, encoding: "utf8" })
        : await this.#ws.shell.exec(command, { cwd: options.cwd });
    const result: ExecResult<"utf8" | undefined> = await handle.result();
    return {
      exitCode: result.exitCode,
      // joinParts in shell.ts returns string for "utf8",
      // Uint8Array otherwise — exactly the
      // WorkspaceExecResult shape.
      stdout: result.stdout as WorkspaceExecResult<"utf8" | undefined>["stdout"],
      stderr: result.stderr as WorkspaceExecResult<"utf8" | undefined>["stderr"],
    };
  }

  // Streaming exec. Returns a byte stream of Server-Sent Events:
  // one `event: stdout|stderr|exit` frame per WorkspaceExecEvent,
  // payload is a JSON object with the event fields. The Worker
  // pipes the stream straight into a Response body — keeps the
  // exec back-pressure end-to-end (Workers RPC propagates
  // ReadableStream<Uint8Array>).
  //
  // Encoding-forced to utf8 so the JSON payload is string-shaped;
  // callers wanting raw bytes can use `exec()` for now.
  async execStream(
    command: string,
    options: { cwd?: string } = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const handle = await this.#ws.shell.exec(command, {
      cwd: options.cwd,
      encoding: "utf8",
    });
    const encoder = new TextEncoder();
    return handle.pipeThrough(
      new TransformStream<WorkspaceExecEvent<"utf8">, Uint8Array>({
        transform(event, controller) {
          const data = JSON.stringify({
            seq: event.seq,
            value: event.value,
          });
          controller.enqueue(encoder.encode(`event: ${event.name}\ndata: ${data}\n\n`));
        },
      }),
    );
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
  readonly #fs: WorkspaceFsStub;
  readonly #shell: WorkspaceShellStub;

  constructor(ws: Workspace) {
    super();
    this.#fs = new WorkspaceFsStub(ws);
    this.#shell = new WorkspaceShellStub(ws);
  }

  get fs(): WorkspaceFsStub {
    return this.#fs;
  }

  get shell(): WorkspaceShellStub {
    return this.#shell;
  }
}
