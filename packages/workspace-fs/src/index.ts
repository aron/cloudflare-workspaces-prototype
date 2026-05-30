import { SqliteWorkspaceFilesystem } from "./filesystem.js";
import type {
  DurableObjectStorageLike,
  WorkspaceFilesystem,
  WorkspaceFilesystemOptions,
} from "./types.js";

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
export type { WorkspaceErrorCode, WorkspaceFsError } from "./errors.js";
export { createWorkspaceError } from "./errors.js";

/**
 * Create a Workspace filesystem backed by Durable Object SQLite storage.
 *
 * The returned object implements the package-level filesystem API and lazily
 * initializes the documented `cf_vfs_*` schema on first use.
 */
export function createWorkspaceFilesystem(
  storage: DurableObjectStorageLike,
  options?: WorkspaceFilesystemOptions,
): WorkspaceFilesystem {
  return new SqliteWorkspaceFilesystem(storage, options);
}
