import { SQLiteWorkspaceFilesystem } from "./filesystem.js";
import type {
  DurableObjectStorageLike,
  WorkspaceFilesystem,
  WorkspaceFilesystemOptions,
} from "./types.js";

export type { WorkspaceErrorCode, WorkspaceFsError } from "./errors.js";
export { createWorkspaceError } from "./errors.js";
export type {
  DurableObjectStorageLike,
  SqlCursorLike,
  SqlStorageLike,
  WorkspaceDirent,
  WorkspaceFilesystem,
  WorkspaceFilesystemOptions,
  WorkspaceFoundEntry,
  WorkspaceGrepMatch,
  WorkspaceStat,
} from "./types.js";

/**
 * Create a Workspace filesystem backed by Durable Object SQLite storage.
 *
 * The returned object implements the package-level filesystem API and lazily
 * initializes the documented `vfs_*` schema on first use.
 */
export function createWorkspaceFilesystem(
  storage: DurableObjectStorageLike,
  options?: WorkspaceFilesystemOptions,
): WorkspaceFilesystem {
  return new SQLiteWorkspaceFilesystem(storage, options);
}

export type { SQLiteWorkspaceProviderOptions } from "./provider.js";
export { SQLiteWorkspaceProvider } from "./provider.js";
export { initializeSchema, ROOT_INODE, SCHEMA_VERSION } from "./schema/index.js";
export { Database } from "./storage.js";
export type { ApplyOptions } from "./sync/apply.js";

// Sync protocol building blocks. The wire wiring lives in
// @cloudflare/workspace-rpc; these are the helpers that wiring binds
// to a Database.
export { applyChanges } from "./sync/apply.js";
export type { ChangeEntry } from "./sync/changes.js";
export { materialiseChange } from "./sync/changes.js";
export type { CoalesceOptions } from "./sync/coalesce.js";
export { coalesceChanges } from "./sync/coalesce.js";
export { fetchChanges, fetchObjects, hasObjects } from "./sync/fetch.js";
export { DEFAULT_IGNORE, isIgnored } from "./sync/ignore.js";
export { assertAppliedPushRev } from "./sync/invariant.js";
export type { ManifestChunk } from "./sync/manifests.js";
export { buildManifest, MANIFEST_VERSION } from "./sync/manifests.js";
export { pushObjects } from "./sync/push.js";
export type { WatermarkKey } from "./sync/watermarks.js";
export { currentRev, readWatermark, writeWatermark } from "./sync/watermarks.js";
export { RecordingStorage, SQLiteTestStorage } from "./testing.js";
