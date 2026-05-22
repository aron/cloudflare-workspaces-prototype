/**
 * @cloudflare/workspace
 *
 * Worker-side facade: a SQLite-backed VFS plus a `@cloudflare/sandbox`
 * container with bidirectional incremental sync.
 *
 * Companion entrypoints:
 *   `@cloudflare/workspace/worker-sandbox`    — run agent-compiled WASM in a
 *                                                Dynamic Worker isolate
 *   `@cloudflare/workspace/container-sandbox` — the container-side server
 *                                                (FUSE + capnweb)
 *   `@cloudflare/workspace/shared`            — wire types & RPC interface
 */

export { Workspace } from "./workspace.js";
export type { WorkspaceOptions } from "./workspace.js";

// Re-export the shared types so consumers don't need a second import path
// for simple cases. Use `@cloudflare/workspace/shared` directly when both
// sides of the wire need them.
export type {
  VfsEntry,
  VfsChange,
  FileStat,
  GrepHit,
  ExecResult,
  ExecOptions,
  ContainerRpc,
} from "./shared/index.js";
