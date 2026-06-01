// Server-side adapter: a SQLite-backed Database becomes a SyncRPC.
//
// The DO uses this to expose its sync surface to the container, and
// the in-container workspace-server uses it to expose its mirror to
// the DO. Same code on both ends; what differs is who calls whom.

import {
  applyChanges,
  type ChangeEntry,
  coalesceChanges,
  currentRev,
  type Database,
  DEFAULT_IGNORE,
  fetchObjects,
  hasObjects,
  materialiseChange,
  readWatermark,
  stageBlob,
} from "@cloudflare/workspace-fs";
import { newWebSocketRpcSession, nodeHttpBatchRpcResponse, RpcTarget } from "capnweb";

import type { ExecEvent, ShellRPC, SyncRPC, WorkspaceRPC } from "./interface.js";

// Subset of wsd's Runner that the shell server needs. Defining
// the shape here (instead of importing the concrete class) keeps
// workspace-rpc free of a wsd dependency — the package builds and
// runs without wsd's process-supervision code on the path.
export interface RunnerLike {
  exec(
    command: string,
    options?: { id?: string; cwd?: string },
  ): {
    id: string;
    events: ReadableStream<ExecEvent>;
  };
  get(
    id: string,
    options?: { after?: number | "tail" },
  ): {
    id: string;
    events: ReadableStream<ExecEvent>;
  };
  kill(id: string, signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP"): void;
  dispose(id: string): void;
}

export interface ServerOptions {
  ignore?: string[];
  now?: () => number;
}

class SyncRPCServer extends RpcTarget implements SyncRPC {
  constructor(
    private readonly db: Database,
    private readonly options: Required<Pick<ServerOptions, "ignore">>,
  ) {
    super();
  }

  async push(input: {
    senderRev: number;
    changes: ReadableStream<ChangeEntry>;
  }): Promise<{ rev: number; appliedPushRev: number }> {
    const entries: ChangeEntry[] = [];
    const reader = input.changes.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        entries.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    // senderRev > 0 — the caller is a sync peer with its
    // own rev space; advance fetchRev to that point and let
    // loopback suppression silence the outbound push so we
    // don't ping-pong the same entries back.
    //
    // senderRev === 0 — the caller is an external writer
    // (an orchestrator using the wire as a transport, the
    // soak script, a manual curl). Treat the entries as
    // local writes: bump rev through the normal apply path,
    // leave pushRev untouched so the outbound sync loop
    // ships them upstream on the next tick.
    const isPeer = input.senderRev > 0;
    await applyChanges(this.db, entries, new Map(), {
      source: isPeer ? "upstream" : "local",
      ...(isPeer ? { advanceFetchRev: input.senderRev } : {}),
    });
    return {
      rev: currentRev(this.db),
      appliedPushRev: input.senderRev,
    };
  }

  fetchChanges(input: { sinceRev?: number; ignore?: string[] }): ReadableStream<ChangeEntry> {
    const sinceRev = input.sinceRev ?? 0;
    const ignore =
      input.ignore ?? (this.options.ignore.length > 0 ? this.options.ignore : DEFAULT_IGNORE);
    return iterableToReadableStream(coalesceChanges(this.db, sinceRev, { ignore }));
  }

  async readEntry(path: string): Promise<ChangeEntry | null> {
    return materialiseChange(this.db, path);
  }

  async currentRev(): Promise<number> {
    return currentRev(this.db);
  }

  async watermarks(): Promise<{ currentRev: number; pushRev: number; fetchRev: number }> {
    return {
      currentRev: currentRev(this.db),
      pushRev: readWatermark(this.db, "pushRev"),
      fetchRev: readWatermark(this.db, "fetchRev"),
    };
  }

  async hasObjects(hashes: Uint8Array[]): Promise<Uint8Array[]> {
    return hasObjects(this.db, hashes);
  }

  fetchObjects(hashes: Uint8Array[]): ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }> {
    return iterableToReadableStream(fetchObjects(this.db, hashes));
  }

  async pushObjects(
    objects: ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>,
  ): Promise<void> {
    const reader = objects.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        stageBlob(this.db, value.hash, value.bytes, Date.now());
      }
    } finally {
      reader.releaseLock();
    }
  }
}
class ShellRPCServer extends RpcTarget implements ShellRPC {
  constructor(private readonly runner: RunnerLike) {
    super();
  }

  async exec(input: { command: string; cwd?: string; id?: string }): Promise<{
    id: string;
    events: ReadableStream<ExecEvent>;
  }> {
    return this.runner.exec(input.command, { id: input.id, cwd: input.cwd });
  }

  async getExec(input: { id: string; after?: number | "tail" }): Promise<{
    id: string;
    events: ReadableStream<ExecEvent>;
  }> {
    return this.runner.get(input.id, { after: input.after });
  }

  async killExec(input: {
    id: string;
    signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";
  }): Promise<void> {
    this.runner.kill(input.id, input.signal);
  }

  async disposeExec(input: { id: string }): Promise<void> {
    this.runner.dispose(input.id);
  }
}

// Composite server: exposes both halves as named fields on one
// stub. Capnweb walks the property tree on demand, so callers
// only pay for the half they reach.
class WorkspaceRPCServer extends RpcTarget implements WorkspaceRPC {
  // sync / shell are exposed as getters — capnweb's RpcTarget
  // refuses to traverse plain instance properties (the readLoop
  // raises 'instance properties cannot be accessed over RPC').
  // Getters look like methods to the dispatch path.
  #sync: SyncRPC;
  #shell: ShellRPC;
  constructor(sync: SyncRPC, shell: ShellRPC) {
    super();
    this.#sync = sync;
    this.#shell = shell;
  }
  get sync(): SyncRPC {
    return this.#sync;
  }
  get shell(): ShellRPC {
    return this.#shell;
  }
}

// Construct a SyncRPC bound to `db`. The carrier (HTTP server +
// WebSocketServer) is the caller's responsibility; this just hands
// back the object to mount on each connection via
// acceptWebSocketSession().
export function createSyncServer(db: Database, options: ServerOptions = {}): SyncRPC {
  return new SyncRPCServer(db, { ignore: options.ignore ?? [] });
}

// Construct a ShellRPC bound to a Runner. wsd holds the only
// Runner today; tests can pass a fake that implements RunnerLike.
export function createShellServer(runner: RunnerLike): ShellRPC {
  return new ShellRPCServer(runner);
}

// Construct the composite WorkspaceRPC. The wire serves this on
// /ws so clients reach `.sync` and `.shell` through one session.
export function createWorkspaceServer(
  db: Database,
  runner: RunnerLike,
  options: ServerOptions = {},
): WorkspaceRPC {
  return new WorkspaceRPCServer(createSyncServer(db, options), createShellServer(runner));
}

// Attach a capnweb RPC session to a WHATWG-shaped WebSocket. The
// node `ws` package's server-side sockets implement the WHATWG
// surface (addEventListener / send / close), so this works for
// both browser-style sockets and ws-package sockets.
//
// The session is held alive by capnweb's internal event listeners
// until the socket closes; the caller can drop the return value.
// `ws` is typed loosely because we accept both browser-style WebSockets
// (WHATWG EventTarget) and node `ws` package server sockets, which
// share the addEventListener / send / close subset capnweb needs.
export function acceptWebSocketSession(
  ws: WebSocket | { addEventListener: WebSocket["addEventListener"] },
  rpc: SyncRPC | ShellRPC | WorkspaceRPC,
): void {
  newWebSocketRpcSession(ws as unknown as WebSocket, rpc as unknown as RpcTarget);
}

// Serve a single capnweb HTTP-batch session against a SyncRPC. Wraps
// capnweb's nodeHttpBatchRpcResponse so wsd never directly imports
// capnweb (which would split capnweb's module identity in mixed
// ESM/CJS contexts — the RpcTarget instanceof check then fails).
export function serveHTTPBatch(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  rpc: SyncRPC | ShellRPC | WorkspaceRPC,
): Promise<void> {
  return nodeHttpBatchRpcResponse(request, response, rpc as unknown as RpcTarget);
}

function iterableToReadableStream<T>(it: AsyncIterable<T>): ReadableStream<T> {
  const iterator = it[Symbol.asyncIterator]();
  return new ReadableStream<T>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      if (iterator.return) await iterator.return(reason as undefined);
    },
  });
}
