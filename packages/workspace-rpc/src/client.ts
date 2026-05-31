// Client-side adapter: turn a WebSocket URL into a typed SyncRPC
// stub. Capnweb's newWebSocketRpcSession does the actual dial; we
// own the connection lifecycle and expose a close() for clean
// teardown.

import { newWebSocketRpcSession, type RpcStub } from "capnweb";

import type { SyncRPC, WorkspaceRPC } from "./interface.js";

export interface RpcEvent {
  rpc: keyof SyncRPC;
  durationMs: number;
  ok: boolean;
  code?: string;
}

export interface ClientOptions {
  // WebSocket URL. Typically ws://container-host:4567/rpc.
  url: string;
  // Optional WebSocket constructor. Defaults to the global
  // WebSocket (node 22+ ships one; older runtimes can pass the
  // `ws` package's WebSocket here).
  WebSocketImpl?: typeof WebSocket;
  // Fired once per RPC with timing + outcome. Hook into whatever
  // observability surface the host already uses. bytesIn /
  // bytesOut aren't exposed yet — capnweb doesn't surface
  // per-call frame sizes through the stub API.
  onRpcEvent?: (event: RpcEvent) => void;
}

export interface SyncClient extends SyncRPC {
  // Close the WebSocket and tear down the stub. Idempotent.
  close(): Promise<void>;
}

// Open a SyncRPC session against `url`. The first call to any
// method on the returned stub queues until the WebSocket reaches
// readyState OPEN; capnweb's transport handles that.
export function createSyncClient(options: ClientOptions): SyncClient {
  const WS = options.WebSocketImpl ?? WebSocket;
  const ws = new WS(options.url);
  const stub = newWebSocketRpcSession(ws as unknown as globalThis.WebSocket) as RpcStub<SyncRPC>;
  // capnweb's RpcStub is a Proxy that exposes the remote interface
  // as if it were local. We wrap it so callers see SyncClient
  // (= SyncRPC + close).
  const onEvent = options.onRpcEvent;
  return new Proxy(stub, {
    get(target, prop, receiver) {
      if (prop === "close") {
        return async () => {
          await new Promise<void>((resolve) => {
            const w = ws as unknown as { readyState: number; close: () => void };
            if (w.readyState >= 2) {
              resolve();
              return;
            }
            (ws as unknown as EventTarget).addEventListener("close", () => resolve(), {
              once: true,
            });
            w.close();
            // Belt-and-braces: if `close` never fires (the socket
            // was already torn down) the timeout breaks the await.
            setTimeout(resolve, 200);
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (onEvent === undefined || typeof prop !== "string") return value;
      // Capnweb's Proxy returns a callable RpcPromise/RpcStub for
      // every string property. Wrap the call to time it and fire
      // onRpcEvent. The wrapped value still behaves like an
      // RpcPromise (thenable + property-access for pipelining) for
      // calls that return synchronously-pipelined values; we only
      // measure the awaited terminal call.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (...args: unknown[]) => {
        const start = Date.now();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (value as any)(...args);
        // For non-thenable returns (streams), fire the event
        // immediately with ok=true. The caller may still throw
        // while reading the stream; observability for that path
        // belongs to the caller.
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
  }) as unknown as SyncClient;
}

export interface WorkspaceClient extends WorkspaceRPC {
  close(): Promise<void>;
}

// Open a WorkspaceRPC session. Same transport as createSyncClient,
// different stub shape: callers reach the sync half via `.sync`
// and the shell half via `.shell`.
//
// onRpcEvent isn't wired here yet — the composite stub's
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
  const stub = newWebSocketRpcSession(
    ws as unknown as globalThis.WebSocket,
  ) as RpcStub<WorkspaceRPC>;
  return new Proxy(stub, {
    get(target, prop, receiver) {
      if (prop === "close") {
        return async () => {
          await new Promise<void>((resolve) => {
            const w = ws as unknown as { readyState: number; close: () => void };
            if (w.readyState >= 2) {
              resolve();
              return;
            }
            (ws as unknown as EventTarget).addEventListener("close", () => resolve(), {
              once: true,
            });
            w.close();
            setTimeout(resolve, 200);
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as WorkspaceClient;
}
