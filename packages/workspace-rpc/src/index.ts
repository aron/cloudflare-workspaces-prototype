// Public surface of @cloudflare/workspace-rpc.
//
// The package is split into three entry points:
//
//   - .          — the typed wire interface and error shape.
//   - ./server   — a Database-backed implementation of the interface.
//                  Imported by DO code and by the in-container
//                  workspace-server.
//   - ./client   — a typed stub over a WebSocket carrier. Imported
//                  by the DO to talk to the container, and (later)
//                  by the container to talk to the DO if the
//                  bidirectional flavour lands.
//
// The interface is the load-bearing surface. server.ts and
// client.ts both target it; either can be swapped for an
// alternative implementation (a queue-backed server for replay
// tests, a mock client for unit tests) without changing call sites.

export type {
  ExecEvent,
  ShellRPC,
  SyncRPC,
  WireError,
  WireErrorCode,
  WorkspaceRPC,
} from "./interface.js";
