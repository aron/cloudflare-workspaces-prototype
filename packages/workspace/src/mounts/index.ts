/**
 * Read-only mounts for `Workspace`.
 *
 * A `Mount` is a lazy provider of files materialized into the VFS under a
 * configured root path. The index (directory tree + file metadata) is fetched
 * once via `list()`; file content is fetched per-file via `fetch(relPath)` the
 * first time something asks for it.
 *
 * v1 implementations:
 *   - `R2Bucket(binding, { prefix })` — see ./r2.ts
 */

export interface MountEntry {
  /** Path relative to the mount root. No leading slash. */
  relPath: string;
  type:    "file" | "dir";
  /** Optional size hint (used for `stat` before content is fetched). */
  size?:   number;
  /** Optional last-modified hint. Falls back to "now" at index time. */
  mtime?:  number;
}

export interface Mount {
  /** Stable kind tag, useful for debugging and reconciliation. */
  readonly kind: string;
  /** Enumerate every file and directory under the mount source. */
  list():  Promise<MountEntry[]>;
  /** Fetch the raw bytes for one file (relPath as returned from list()). */
  fetch(relPath: string): Promise<Uint8Array>;
}

export { R2Bucket } from "./r2.js";
export type { R2MountOptions } from "./r2.js";
