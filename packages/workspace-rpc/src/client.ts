// Client-side adapter: turn a WebSocket carrier into a typed SyncRPC
// stub.
//
// The DO side typically constructs this against the container's
// /rpc endpoint after the workspace-server is up. The reconnect
// pattern from docs/08:
//
//   - On close/error the stub self-destructs synchronously.
//   - The next RPC call transparently rebuilds against the
//     still-running server.
//
// The factory captures enough state (URL, headers, fetch impl) to
// rebuild without the caller noticing. Phase 5 fills in the actual
// capnweb wiring; this sketch ships the surface and the lifecycle
// so the DO code can be written against it.

import { newWebSocketRpcSession } from "capnweb";

import type { SyncRPC } from "./interface.js";

export interface ClientOptions {
  // WebSocket URL. Typically ws://container-host:4567/rpc.
  url: string;
  // Optional fetch impl for the upgrade. Workers' global fetch is
  // the default; node-side callers pass undici or similar.
  fetch?: typeof fetch;
  // Called once per RPC with timing + size data. Hooks into the
  // host's observability surface; see docs/08.
  onRpcEvent?: (event: {
    rpc: keyof SyncRPC;
    durationMs: number;
    bytesIn: number;
    bytesOut: number;
    ok: boolean;
    code?: string;
  }) => void;
}

export interface SyncClient extends SyncRPC {
  // Close the WebSocket and tear down the stub. Idempotent. The
  // next RPC call after close() opens a fresh session.
  close(): Promise<void>;
}

// Create a deferred SyncRPC client. The actual WebSocket upgrade
// happens on the first RPC call \u2014 mirrors @cloudflare/sandbox's
// ContainerControlConnection lifecycle. Until then this object is
// a typed stub that queues calls.
export function createSyncClient(_options: ClientOptions): SyncClient {
  // Phase 5 fills this in. The shape lives here so DO code can be
  // written against a real typed surface before the wire is hot.
  // newWebSocketRpcSession() returns a Capnweb stub whose method
  // shapes match SyncRPC by construction.
  void newWebSocketRpcSession;
  throw new Error("createSyncClient: capnweb wiring lands in Phase 5");
}
