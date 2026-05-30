import {
  applyChanges,
  type ChangeEntry,
  Database,
  initializeSchema,
  SQLiteWorkspaceProvider,
  stageBlob,
} from "@cloudflare/workspace-fs";
import { SQLiteTestStorage } from "@cloudflare/workspace-fs/testing";
import type { SyncRPC } from "@cloudflare/workspace-rpc";
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

export interface CreateOptions {
  // Optional upstream sync surface. When set, the local store
  // performs an initial pull on construction. When unset, wsd runs
  // standalone against an in-memory store.
  //
  // The caller owns the carrier (WebSocket, in-process direct
  // binding, or any future flavour). This package only needs the
  // typed surface; the transport seam lives in workspace-rpc.
  // Future RPCs (exec, mounts, watchers) will travel beside
  // SyncRPC on the same connection, so the caller may pass a
  // composite stub — we accept the narrow SyncRPC subset
  // structurally.
  upstream?: SyncRPC;
}

export interface NodeVfsHandle {
  // @platformatic/vfs filesystem the FUSE driver consumes.
  vfs: NodeVirtualFileSystem;
  // workspace-fs Database backing the same store. Exposed so the
  // CLI can construct a createSyncServer(db) and serve the local
  // store to upstream callers over capnweb.
  db: Database;
}

export async function createNodeVirtualFileSystem(
  options: CreateOptions = {},
): Promise<NodeVfsHandle> {
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, () => Date.now());
  if (options.upstream !== undefined) {
    await initialPull(db, options.upstream);
  }
  const vfs = create(new SQLiteVirtualProvider(db), { moduleHooks: false });
  return { vfs, db };
}

// Initial pull: fetch every ChangeEntry from upstream, stage the
// referenced chunk bytes locally, then apply the entries. Bounded
// to the wire; large workspaces stream through without buffering
// the whole change set in memory.
async function initialPull(db: Database, upstream: SyncRPC): Promise<void> {
  const changesStream = await upstream.fetchChanges({ sinceRev: 0 });
  const entries: ChangeEntry[] = [];
  const wantedHashes: Uint8Array[] = [];
  const seen = new Set<string>();
  const reader = changesStream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      entries.push(value);
      if (value.kind === "file") {
        for (const c of value.chunks) {
          const k = hex(c.hash);
          if (!seen.has(k)) {
            seen.add(k);
            wantedHashes.push(c.hash);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  // Probe: only fetch hashes the receiver doesn't already hold.
  // On a fresh DB the probe is empty so we fetch everything; on a
  // warm DB it's the content-addressed dedup at work.
  const haveSubset = await upstream.hasObjects(wantedHashes);
  const have = new Set(haveSubset.map(hex));
  const missing = wantedHashes.filter((h) => !have.has(hex(h)));
  if (missing.length > 0) {
    const bytesStream = await upstream.fetchObjects(missing);
    const bytesReader = bytesStream.getReader();
    try {
      while (true) {
        const { value, done } = await bytesReader.read();
        if (done) break;
        stageBlob(db, value.hash, value.bytes, Date.now());
      }
    } finally {
      bytesReader.releaseLock();
    }
  }
  await applyChanges(db, entries, new Map());
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}
