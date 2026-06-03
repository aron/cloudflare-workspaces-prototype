// Public surface of @cloudflare/workspace.
//
// The package runs inside a Cloudflare Worker / Durable
// Object. It picks a backend, holds a SyncRPC connection to
// wsd, and exposes a file-shaped facade. Backends are
// pluggable; today TestBackend (point at a URL) and
// CloudflareContainerBackend (Container DO binding) ship.

export type { DurableObjectStorageLike, SQLiteWorkspaceProviderOptions } from "@cloudflare/dofs";
export { SQLiteWorkspaceProvider } from "@cloudflare/dofs";
export type { BackendHandle, WorkspaceBackend } from "./backend.js";
export {
  CloudflareContainerBackend,
  type CloudflareContainerBackendOptions,
} from "./backends/cloudflare-container.js";
export { TestBackend, type TestBackendOptions } from "./backends/test.js";
export { WorkspaceProxy, type WorkspaceProxyProps } from "./proxy.js";
export type {
  ExecEncoding,
  ExecHandle,
  ExecOptions,
  ExecResult,
  GetExecOptions,
  KillSignal,
  WorkspaceExecEvent,
} from "./shell.js";
export { WorkspaceShell } from "./shell.js";
export {
  WorkspaceExecHandleStub,
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
  WorkspaceFilesystemStub,
  WorkspaceShellStub,
  WorkspaceStub,
} from "./stub.js";
export { Workspace, type WorkspaceOptions } from "./workspace.js";
