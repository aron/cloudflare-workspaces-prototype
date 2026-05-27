/**
 * Mounts for `Workspace`.
 *
 * A `Mount` is a provider of files materialized into the VFS under a
 * configured root path. There are two shapes:
 *
 *   - Lazy mounts (`MountKind.Lazy`) expose `list()` + `fetch(relPath)`.
 *     The workspace calls `list()` once to discover the directory tree
 *     and writes file stubs into the VFS. Content is fetched per-file via
 *     `fetch(relPath)` the first time something reads the file. Best when
 *     blob bytes are random-access and individually addressable (R2).
 *
 *   - Eager mounts (`MountKind.Eager`) expose `materialize(api)`. The
 *     workspace hands the mount a small write API into the VFS and lets
 *     the mount populate everything itself. Best when the backing store
 *     can only produce content as a single transaction (a git clone
 *     yields the whole working tree in one shot).
 *
 * Read-write mounts also expose `put` and `delete` so writes to the VFS
 * (whether from the host or pulled back from container-side execs) are
 * propagated to the backing store. Eager mounts may also implement these
 * if their backing store accepts writes.
 *
 * Every mount value passed in `WorkspaceOptions.mounts` is a *factory*:
 * a function `(ctx: MountContext) => Mount`. The factory is called
 * lazily on first index, with the workspace's session context. This
 * lets per-session mounts (per-session git fork, scoped R2 prefix, etc.)
 * derive their identity from the agent without the caller having to
 * repeat `sessionId` at every call site.
 *
 * v1 implementations:
 *   - `R2Bucket(binding, { prefix, mode })`       — lazy, see ./r2.ts
 *   - `GitHubRepo("owner/name", { ... })`         — eager, see ./github.ts
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

/**
 * Context passed to mount factories. Carries everything a mount might
 * need to scope itself to the current session without leaking the
 * Workspace surface area.
 */
export interface MountContext {
  /** The session id this workspace is wired to (usually the agent's DO name). */
  sessionId: string;
  /** Absolute VFS path this mount is rooted at, with no trailing slash. */
  root: string;
  /**
   * Direct handle to the workspace's Vfs. Most mounts don't need this —
   * use the `MountWriteApi` passed to `materialize()` for eager mounts and
   * the lazy `list()`/`fetch()` pattern for lazy ones. Provided here for
   * mounts that need to talk to fs-shaped consumers (isomorphic-git etc.)
   * during materialization without going through the api wrapper.
   */
  vfs: import("../vfs.js").Vfs;
}

/**
 * Write API handed to eager mounts during `materialize()`. Wraps the
 * Vfs without exposing the mutation seam used by container sync.
 *
 * `writeFile` and `mkdir` automatically tag rows with the mount root so
 * write-rejection and stub bookkeeping still work for these paths.
 */
export interface MountWriteApi {
  /** Absolute path inside the mount; must be `<root>/<relPath>` or `<root>`. */
  writeFile(absPath: string, bytes: Uint8Array, mode?: number): void;
  mkdir(absPath: string, mode?: number): void;
}

/** Discriminator for mount strategies. */
export type MountKind = "lazy" | "eager";

interface MountBase {
  /** Stable kind tag, useful for debugging and reconciliation. */
  readonly kind: string;
  /** Strategy. Defaults to `"lazy"` if absent (back-compat with v1 mounts). */
  readonly strategy?: MountKind;
  /** Whether the mount accepts writes. Read-only mounts throw EROFS on writes. */
  readonly writable: boolean;
  /** Upload bytes for one file. Required iff `writable` is true. */
  put?(relPath: string, bytes: Uint8Array): Promise<void>;
  /** Delete one file. Required iff `writable` is true. No-op for missing keys. */
  delete?(relPath: string): Promise<void>;
}

export interface LazyMount extends MountBase {
  readonly strategy?: "lazy";
  /** Enumerate every file and directory under the mount source. */
  list():  Promise<MountEntry[]>;
  /** Fetch the raw bytes for one file (relPath as returned from list()). */
  fetch(relPath: string): Promise<Uint8Array>;
}

export interface EagerMount extends MountBase {
  readonly strategy: "eager";
  /**
   * Populate the VFS with the mount's contents in one shot. Called once
   * per indexed mount per DO lifetime; subsequent reads come from the
   * VFS directly.
   *
   * Implementations should write through the supplied `api` rather than
   * touching the VFS directly — the api scopes writes to the mount root
   * and stamps rows with provenance for write-rejection.
   */
  materialize(api: MountWriteApi): Promise<void>;
}

export type Mount = LazyMount | EagerMount;

/**
 * A mount factory. The workspace calls this once per mount on first use,
 * passing the session context, and caches the returned instance for the
 * lifetime of the Workspace.
 *
 * Plain `Mount` objects are also accepted for back-compat, but new code
 * should always return from a factory so per-session state stays explicit.
 */
export type MountFactory = (ctx: MountContext) => Mount;

/**
 * Value accepted by `WorkspaceOptions.mounts`. Either a factory (preferred)
 * or a fully-constructed Mount.
 */
export type MountInput = Mount | MountFactory;

/** Internal helper — coerce a MountInput to a factory. */
export function asFactory(input: MountInput): MountFactory {
  return typeof input === "function" ? input : () => input;
}

export { R2Bucket } from "./r2.js";
export type { R2MountOptions } from "./r2.js";
export { GitHubRepo } from "./github.js";
export type { GitHubRepoOptions } from "./github.js";
