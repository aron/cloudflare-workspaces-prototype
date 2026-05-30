import {
  Database,
  initializeSchema,
  SQLiteTestStorage,
  SQLiteWorkspaceProvider,
} from "@cloudflare/workspace-fs";
import { create, type VirtualFileSystem, VirtualProvider } from "@platformatic/vfs";

export type NodeVirtualFileSystem = VirtualFileSystem;

// @platformatic/vfs's create() guards on `provider instanceof
// VirtualProvider` and silently falls back to MemoryProvider when
// the check fails. workspace-fs's SQLiteWorkspaceProvider can't
// extend VirtualProvider directly without dragging the node-only
// @platformatic/vfs dependency into the workerd-targeted package,
// so we glue them together here.
//
// The subclass forwards every method to the workspace-fs provider
// instance held in its constructor. We can't use Object.assign or
// setPrototypeOf at the seam because @platformatic/vfs's
// VirtualFileSystem reads getters (readonly, supportsSymlinks,
// supportsWatch) off the provider that the workspace-fs class
// declares as instance properties; the wrapping pattern lets us
// pass those through cleanly without re-implementing the data
// model.

class SQLiteVirtualProvider extends VirtualProvider {
  private readonly inner: SQLiteWorkspaceProvider;

  constructor(db: Database) {
    super();
    this.inner = new SQLiteWorkspaceProvider(db);
  }

  // VirtualProvider's static getters return false by default; the
  // workspace-fs provider declares the real values as instance
  // properties. Re-expose them on this wrapper.
  override get readonly(): boolean {
    return this.inner.readonly;
  }
  override get supportsSymlinks(): boolean {
    return this.inner.supportsSymlinks;
  }
  override get supportsWatch(): boolean {
    return this.inner.supportsWatch;
  }
}

// Wire forwarding methods on the prototype. Doing this in a loop
// outside the class body keeps the (large) method list out of the
// readable surface. Every method on the workspace-fs provider that
// VirtualProvider declares is forwarded; the rest still throw the
// VirtualProvider default ENOSYS.
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
  // sometimes pokes at.
  "closeSync",
  "readSync",
  "writeSync",
  "fstatSync",
  "truncateSync",
  "ftruncateSync",
] as const;

for (const name of FORWARDED_METHODS) {
  Object.defineProperty(SQLiteVirtualProvider.prototype, name, {
    value: function (this: SQLiteVirtualProvider, ...args: unknown[]): unknown {
      // biome-ignore lint/suspicious/noExplicitAny: dispatch table
      const inner = (this as unknown as { inner: any }).inner;
      return inner[name](...args);
    },
    writable: true,
    configurable: true,
  });
}

export function createNodeVirtualFileSystem(): NodeVirtualFileSystem {
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, () => Date.now());
  return create(new SQLiteVirtualProvider(db), { moduleHooks: false });
}
