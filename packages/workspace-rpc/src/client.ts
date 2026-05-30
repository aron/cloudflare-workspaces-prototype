// Client-side adapter: turn a WebSocket URL into a typed SyncRPC
// stub. Capnweb's newWebSocketRpcSession does the actual dial; we
// own the connection lifecycle and expose a close() for clean
// teardown.

import { newWebSocketRpcSession, type RpcStub } from "capnweb";

import type { SyncRPC } from "./interface.js";

export interface ClientOptions {
  // WebSocket URL. Typically ws://container-host:4567/rpc.
  url: string;
  // Optional WebSocket constructor. Defaults to the global
  // WebSocket (node 22+ ships one; older runtimes can pass the
  // `ws` package's WebSocket here).
  WebSocketImpl?: typeof WebSocket;
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
            const closeHandler = () => resolve();
            (ws as unknown as EventTarget).addEventListener("close", closeHandler, {
              once: true,
            });
            w.close();
            // Belt-and-braces: if `close` never fires (the socket
            // was already torn down) the timeout breaks the await.
            setTimeout(resolve, 200);
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as SyncClient;
}
