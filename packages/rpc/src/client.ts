// Client-side adapter: turn a WebSocket URL into a typed SyncRPC
// stub. Capnweb's newWebSocketRpcSession does the actual dial; we
// own the connection lifecycle and expose a close() for clean
// teardown.

import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import { wrapShellRpcResults } from "./client-shell-rpc.js";
import { wrapSyncRpcResults } from "./client-sync-rpc.js";
import type { ShellRPC, SyncRPC, WorkspaceRPC } from "./interface.js";
import { disposeRpcResult } from "./rpc-lifetime.js";

export interface RPCEvent {
  rpc: keyof SyncRPC;
  durationMs: number;
  ok: boolean;
  code?: string;
}

export interface ClientOptions {
  // WebSocket URL. Typically ws://container-host:45678/ws.
  url: string;
  // Optional WebSocket constructor. Defaults to the global
  // WebSocket (node 22+ ships one; older runtimes can pass the
  // `ws` package's WebSocket here).
  WebSocketImpl?: typeof WebSocket;
  // Fired once per RPC with timing + outcome. Hook into whatever
  // observability surface the host already uses. bytesIn /
  // bytesOut aren't exposed yet — capnweb doesn't surface
  // per-call frame sizes through the stub API.
  onRPCEvent?: (event: RPCEvent) => void;
}

export interface SyncClient extends SyncRPC {
  // Close the WebSocket and tear down the stub. Idempotent.
  close(): Promise<void>;
}

export interface ShellClient extends ShellRPC {
  // Close the WebSocket and tear down the stub. Idempotent.
  close(): Promise<void>;
}

interface RpcSession<T> {
  rpc: T;
  close(): Promise<void>;
}

export type WorkspaceRpcSession = RpcSession<WorkspaceRPC>;

function createRpcSession<TWire extends object, TClient>(
  ws: WebSocket,
  manage: (stub: TWire) => TClient,
): RpcSession<TClient> {
  // The WebSocket cast crosses two type boundaries: the runtime
  // ws (node `ws` package or global) is structurally compatible
  // with capnweb's expected globalThis.WebSocket but TS can't
  // bridge the nominal types. The RpcStub cast names the remote
  // interface so downstream code remains strongly typed.
  const stub = newWebSocketRpcSession(ws as unknown as globalThis.WebSocket) as RpcStub<TWire>;
  let closePromise: Promise<void> | undefined;
  let disposed = false;

  const disposeStub = () => {
    if (disposed) return;
    disposed = true;
    disposeRpcResult(stub);
  };

  return {
    rpc: manage(stub as unknown as TWire),
    close() {
      closePromise ??= new Promise<void>((resolve) => {
        disposeStub();
        const w = ws as unknown as { readyState: number; close: () => void };
        if (w.readyState >= 2) {
          resolve();
          return;
        }
        (ws as unknown as EventTarget).addEventListener("close", () => resolve(), {
          once: true,
        });
        w.close();
        // The fallback resolves close() when the runtime does not
        // emit a close event for an already-closed socket.
        setTimeout(resolve, 200);
      });
      return closePromise;
    },
  };
}

function wrapWorkspaceRpcResults(remote: WorkspaceRPC): WorkspaceRPC {
  let sync: SyncRPC | undefined;
  let shell: ShellRPC | undefined;
  return new Proxy(remote, {
    get(target, prop, receiver) {
      if (prop === "sync") {
        sync ??= wrapSyncRpcResults(Reflect.get(target, prop, receiver) as SyncRPC);
        return sync;
      }
      if (prop === "shell") {
        shell ??= wrapShellRpcResults(Reflect.get(target, prop, receiver) as ShellRPC);
        return shell;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function withRpcEvents(sync: SyncRPC, onEvent: (event: RPCEvent) => void): SyncRPC {
  return new Proxy(sync, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function") return value;
      // Wrap callable SyncRPC methods to time the awaited terminal
      // result. Stream-read failures are reported by the caller that
      // drains the stream, not by this per-call hook.
      return (...args: unknown[]) => {
        const start = Date.now();
        const result = (value as (...a: unknown[]) => unknown)(...args);
        // For non-thenable returns (streams), fire the event
        // immediately with ok=true.
        if (result && typeof (result as { then?: unknown }).then === "function") {
          return (result as Promise<unknown>).then(
            (v) => {
              onEvent({ rpc: prop as keyof SyncRPC, durationMs: Date.now() - start, ok: true });
              return v;
            },
            (err) => {
              onEvent({
                rpc: prop as keyof SyncRPC,
                durationMs: Date.now() - start,
                ok: false,
                code: (err as { code?: string })?.code,
              });
              throw err;
            },
          );
        }
        onEvent({ rpc: prop as keyof SyncRPC, durationMs: Date.now() - start, ok: true });
        return result;
      };
    },
  });
}

// Open a SyncRPC session against `url`. The first call to any
// method on the returned stub queues until the WebSocket reaches
// readyState OPEN; capnweb's transport handles that.
export function createSyncClient(options: ClientOptions): SyncClient {
  const WS = options.WebSocketImpl ?? WebSocket;
  const ws = new WS(options.url);
  const session = createRpcSession<SyncRPC, SyncRPC>(ws, wrapSyncRpcResults);
  const sync =
    options.onRPCEvent === undefined ? session.rpc : withRpcEvents(session.rpc, options.onRPCEvent);
  return new Proxy(sync, {
    get(target, prop, receiver) {
      if (prop === "close") return session.close;
      return Reflect.get(target, prop, receiver);
    },
    // The Proxy is structurally a SyncRPC stub + the close()
    // override; TS can't infer that from the get-handler shape,
    // so route through unknown to land on SyncClient.
  }) as unknown as SyncClient;
}

export function createShellClient(options: {
  url: string;
  WebSocketImpl?: typeof WebSocket;
}): ShellClient {
  const WS = options.WebSocketImpl ?? WebSocket;
  const ws = new WS(options.url);
  const session = createRpcSession<ShellRPC, ShellRPC>(ws, wrapShellRpcResults);
  return new Proxy(session.rpc, {
    get(target, prop, receiver) {
      if (prop === "close") return session.close;
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as ShellClient;
}

export interface WorkspaceClient extends WorkspaceRPC {
  close(): Promise<void>;
}

export function createWorkspaceRpcSession(ws: WebSocket): WorkspaceRpcSession {
  return createRpcSession<WorkspaceRPC, WorkspaceRPC>(ws, wrapWorkspaceRpcResults);
}

// Open a WorkspaceRPC session. Same transport as createSyncClient,
// different stub shape: callers reach the sync half via `.sync`
// and the shell half via `.shell`.
//
// onRPCEvent isn't wired here yet — the composite stub's
// property-access path is `stub.sync.push(...)` which capnweb
// surfaces as a two-step proxy traversal; the per-call timing
// shim from createSyncClient doesn't compose cleanly. Add when a
// caller actually needs it.
export function createWorkspaceClient(options: {
  url: string;
  WebSocketImpl?: typeof WebSocket;
}): WorkspaceClient {
  const WS = options.WebSocketImpl ?? WebSocket;
  const ws = new WS(options.url);
  const session = createWorkspaceRpcSession(ws);
  return new Proxy(session.rpc, {
    get(target, prop, receiver) {
      if (prop === "close") return session.close;
      return Reflect.get(target, prop, receiver);
    },
    // As in createSyncClient, the Proxy is structurally a
    // WorkspaceRPC stub + close(); route through unknown so TS
    // accepts the WorkspaceClient landing type.
  }) as unknown as WorkspaceClient;
}
