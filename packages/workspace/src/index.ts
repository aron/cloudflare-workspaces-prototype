// Public surface of @cloudflare/workspace.
//
// The package runs inside a Cloudflare Worker / Durable
// Object. It picks a backend, holds a SyncRPC connection to
// wsd, and exposes a file-shaped facade. Backends are
// pluggable; v1 ships TestBackend (point at a URL) and the
// two CloudflareSandboxBackend flavours land in Phase 7.5.

export type { BackendHandle, WorkspaceBackend } from "./backend.js";
export { TestBackend, type TestBackendOptions } from "./backends/test.js";
export { Workspace, WorkspaceFs, type WorkspaceOptions } from "./workspace.js";
