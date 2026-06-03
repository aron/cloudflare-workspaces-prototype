/**
 * Bridge from `@cloudflare/workspace.Workspace.provider()` to the
 * `@platformatic/vfs` `VirtualFileSystem`, so isomorphic-git (and any
 * other consumer that speaks `node:fs.promises`) can hit the same
 * Durable-Object-backed SQLite store the rest of the agent uses.
 *
 * The dofs `SQLiteWorkspaceProvider` already implements the full
 * `node:fs` surface that `@platformatic/vfs` needs (including
 * `symlink` and `readlink`), but it doesn't extend
 * `@platformatic/vfs.VirtualProvider`. `@platformatic/vfs.create()`
 * checks `provider instanceof VirtualProvider` and silently falls
 * back to an in-memory store if the check fails, so we need a thin
 * wrapper that extends the base class and forwards every method to
 * the dofs provider held inside.
 *
 * Same trick the wsd daemon uses internally
 * (`packages/wsd/src/fuse/vfs.ts`). When this stops being a copy-
 * paste of that file, the right move is to lift the glue into a
 * shared package (`@cloudflare/workspace/vfs` or similar) so callers
 * outside the example don't have to repeat the forwarding list.
 */

import type { SQLiteWorkspaceProvider } from "@cloudflare/workspace";
import { create, type VirtualFileSystem, VirtualProvider } from "@platformatic/vfs";

/**
 * Methods on `SQLiteWorkspaceProvider` we want exposed through the
 * `VirtualFileSystem`. Listed explicitly (rather than enumerated via
 * `Object.getOwnPropertyNames`) so the forwarding surface is stable
 * across dofs versions: a new method on the provider won't silently
 * widen the wrapper's contract.
 */
const FORWARDED_METHODS = [
  "open",
  "openSync",
  "stat",
  "statSync",
  "lstat",
  "lstatSync",
  "readdir",
  "readdirSync",
  "mkdir",
  "mkdirSync",
  "rmdir",
  "rmdirSync",
  "unlink",
  "unlinkSync",
  "rename",
  "renameSync",
  "readFile",
  "readFileSync",
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "exists",
  "existsSync",
  "copyFile",
  "copyFileSync",
  "internalModuleStat",
  "realpath",
  "realpathSync",
  "access",
  "accessSync",
  "readlink",
  "readlinkSync",
  "symlink",
  "symlinkSync",
  "watch",
  "watchAsync",
  "watchFile",
  "unwatchFile",
  // Provider-specific fd extensions the @platformatic/vfs router
  // pokes at on read / write paths that go through `open`.
  "closeSync",
  "readSync",
  "writeSync",
  "fstatSync",
  "truncateSync",
  "ftruncateSync",
] as const;

class SQLiteVirtualProvider extends VirtualProvider {
  readonly #inner: SQLiteWorkspaceProvider;

  constructor(inner: SQLiteWorkspaceProvider) {
    super();
    this.#inner = inner;
  }

  // VirtualProvider's static-style getters default to false. The
  // dofs provider declares the real values as instance properties,
  // so re-expose them here. (Forwarding via the prototype loop below
  // wouldn't pick up accessors.)
  override get readonly(): boolean {
    return this.#inner.readonly;
  }
  override get supportsSymlinks(): boolean {
    return this.#inner.supportsSymlinks;
  }
  override get supportsWatch(): boolean {
    return this.#inner.supportsWatch;
  }

  /** Internal — used by the forwarding loop below. */
  get inner(): SQLiteWorkspaceProvider {
    return this.#inner;
  }
}

for (const name of FORWARDED_METHODS) {
  Object.defineProperty(SQLiteVirtualProvider.prototype, name, {
    value(this: SQLiteVirtualProvider, ...args: unknown[]): unknown {
      // biome-ignore lint/suspicious/noExplicitAny: dispatch table
      const inner = this.inner as any;
      const fn = inner[name];
      if (typeof fn !== "function") {
        throw new Error(`SQLiteWorkspaceProvider.${String(name)} is not a function`);
      }
      return fn.apply(inner, args);
    },
    writable: true,
    configurable: true,
  });
}

/**
 * The minimum surface isomorphic-git needs from a `PromiseFsClient`.
 * `@platformatic/vfs.VirtualFileSystem` already implements every
 * method, but the live `vfs.promises` is a class getter, which means
 * isomorphic-git's `FileSystem` constructor (which checks
 * `Object.getOwnPropertyDescriptor(fs, 'promises').enumerable`) falls
 * through to the callback-style branch and tries to `.bind()` methods
 * that don't exist as own properties on the VFS instance.
 *
 * Re-exposing `promises` as an enumerable own property fixes the
 * detection without touching `@platformatic/vfs` itself.
 */
export interface WorkspaceGitFsHandle {
  promises: VirtualFileSystem["promises"];
}

/**
 * Wrap a dofs provider in a `@platformatic/vfs` `VirtualFileSystem`
 * and re-export `.promises` as an enumerable own property so that
 * isomorphic-git picks the promise-style branch on first contact.
 * The returned object is also a structural `PromiseFsClient`.
 */
export function createWorkspaceVfs(provider: SQLiteWorkspaceProvider): WorkspaceGitFsHandle {
  // `moduleHooks: false` keeps `@platformatic/vfs` from trying to
  // install Node module-resolution hooks (which depend on
  // `node:module` and are pointless inside workerd anyway).
  const vfs = create(new SQLiteVirtualProvider(provider), { moduleHooks: false });
  return { promises: vfs.promises };
}
