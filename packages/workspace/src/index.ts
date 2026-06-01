// Public surface of @cloudflare/workspace.
//
// The package runs inside a Cloudflare Worker / Durable
// Object. It picks a backend, holds a SyncRPC connection to
// wsd, and exposes a file-shaped facade. Backends are
// pluggable; v1 ships TestBackend (point at a URL) and the
// two CloudflareSandboxBackend flavours land in Phase 7.5.

export type { DurableObjectStorageLike } from "@cloudflare/workspace-fs";
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
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
  WorkspaceFsStub,
  WorkspaceShellStub,
  WorkspaceStub,
} from "./stub.js";
export { Workspace, WorkspaceFs, type WorkspaceOptions } from "./workspace.js";
