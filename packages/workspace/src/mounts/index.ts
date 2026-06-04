// Mount indexer.
//
// Drives each registered Mount's materialize() exactly once per DO
// lifetime. Persists progress to _vfs_mounts so a subsequent
// Workspace over the same store does not re-run. Failures roll back
// the subtree under the mount root and leave _vfs_mounts.indexed = 0
// so the next pass retries from scratch.

import type { Database, WorkspaceFilesystem } from "@cloudflare/dofs";

import type { Mount, MountWriteAPI } from "./types.js";

export interface IndexerOptions {
  db: Database;
  fs: WorkspaceFilesystem;
  // The resolved registry keyed by absolute mount root.
  mounts: Map<string, Mount>;
}

// Materialize every registered mount whose _vfs_mounts row is not
// yet marked indexed. Calls are deduped through the per-workspace
// `indexPromise` cached in MountIndex below; this free function is
// the workhorse.
async function runIndex(opts: IndexerOptions): Promise<void> {
  const { db, fs, mounts } = opts;
  // Snapshot the indexed flag per root so we don't re-run something
  // a previous attach already finished.
  const status = new Map<string, boolean>();
  for (const root of mounts.keys()) {
    const row = db.one<{ indexed: number }>("SELECT indexed FROM _vfs_mounts WHERE root = ?", root);
    status.set(root, row?.indexed === 1);
  }

  // Run every pending mount in parallel. Per-mount failures clear
  // their own subtree; the overall index call rejects with the first
  // failure once every pending mount has settled.
  const pending = [...mounts.entries()].filter(([root]) => status.get(root) !== true);
  if (pending.length === 0) return;

  const results = await Promise.allSettled(
    pending.map(async ([root, mount]) => {
      // Record the mount as registered-but-not-indexed before we
      // start writing into the subtree. If materialize() crashes
      // the row stays with indexed=0 and a later pass retries.
      db.run(
        "INSERT INTO _vfs_mounts (root, kind, indexed) VALUES (?, ?, 0)\n" +
          "  ON CONFLICT(root) DO UPDATE SET kind = excluded.kind, indexed = 0",
        root,
        mount.kind,
      );

      const api = createWriteAPI({ fs, root, mount });
      try {
        // Pre-create the mount root so an empty mount (one whose
        // materialize() produces zero entries) still has a
        // resolvable inode. Without this, only non-empty mounts get
        // a root — as a side effect of the first writeFile's parent
        // mkdir chain — and readdir(root) on an empty mount rejects
        // with ENOENT. The mkdir is inside the try block so a crash
        // mid-materialize rolls it back via the existing fs.rm path
        // below.
        await fs.mkdir(root, { recursive: true });
        await mount.materialize(api);
      } catch (error) {
        // Roll back anything the partial materialize landed under
        // this mount's root. We use fs.rm with recursive+force so a
        // half-created subtree leaves no orphan rows behind.
        try {
          await fs.rm(root, { recursive: true, force: true });
        } catch {
          // Best effort. If the subtree doesn't exist we still want
          // the original error to surface.
        }
        throw error;
      }
      db.run("UPDATE _vfs_mounts SET indexed = 1 WHERE root = ?", root);
    }),
  );

  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length > 0) {
    // Surface the first failure; preserve the original error so
    // tests / callers see the underlying message.
    throw failures[0].reason;
  }
}

interface WriteAPIOptions {
  fs: WorkspaceFilesystem;
  root: string;
  mount: Mount;
}

function createWriteAPI(opts: WriteAPIOptions): MountWriteAPI {
  const { fs, root, mount } = opts;
  const maxBytes = mount.maxBytes;
  const maxEntries = mount.maxEntries;
  let bytesWritten = 0;
  let entriesWritten = 0;

  function checkPath(absPath: string): void {
    if (!absPath.startsWith(`${root}/`) && absPath !== root) {
      throw new Error(`mount ${root}: writeFile/mkdir target ${absPath} is outside the mount root`);
    }
  }

  return {
    root,
    async writeFile(
      absPath: string,
      source: ReadableStream<Uint8Array>,
      mode?: number,
    ): Promise<void> {
      checkPath(absPath);
      if (maxEntries !== undefined && entriesWritten + 1 > maxEntries) {
        throw new Error(`mount ${root}: maxEntries=${maxEntries} exceeded`);
      }
      entriesWritten += 1;

      // Ensure the parent directory chain exists. mkdir on an
      // existing path is EEXIST, which is fine here because the
      // recursive flag swallows that for the already-a-directory
      // case.
      const lastSlash = absPath.lastIndexOf("/");
      if (lastSlash > 0) {
        await fs.mkdir(absPath.slice(0, lastSlash), { recursive: true });
      }

      // When a byte cap is set, tee the source stream so we can
      // count bytes without buffering. The tee keeps the streaming
      // contract: bytes still flow chunk-by-chunk into writeFile.
      let toWrite: ReadableStream<Uint8Array> = source;
      if (maxBytes !== undefined) {
        const [counted, forwarded] = source.tee();
        toWrite = forwarded;
        // Drain the counted side concurrently; if the cap is
        // exceeded mid-stream, cancel the forwarded side to short
        // circuit the write.
        const cancelForwarded = (reason: unknown): void => {
          forwarded.cancel(reason).catch(() => {});
        };
        const counter = (async () => {
          const reader = counted.getReader();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value === undefined) continue;
              bytesWritten += value.byteLength;
              if (bytesWritten > maxBytes) {
                const err = new Error(
                  `mount ${root}: maxBytes=${maxBytes} exceeded (saw ${bytesWritten})`,
                );
                cancelForwarded(err);
                throw err;
              }
            }
          } finally {
            reader.releaseLock();
          }
        })();
        // Await both sides. If the counter rejects, surface that;
        // otherwise let writeFile propagate.
        const writePromise = fs.writeFile(absPath, toWrite, { mode });
        const [counterResult, writeResult] = await Promise.allSettled([counter, writePromise]);
        if (counterResult.status === "rejected") throw counterResult.reason;
        if (writeResult.status === "rejected") throw writeResult.reason;
        return;
      }
      await fs.writeFile(absPath, toWrite, { mode });
    },

    async mkdir(absPath: string, mode?: number): Promise<void> {
      checkPath(absPath);
      if (maxEntries !== undefined && entriesWritten + 1 > maxEntries) {
        throw new Error(`mount ${root}: maxEntries=${maxEntries} exceeded`);
      }
      entriesWritten += 1;
      await fs.mkdir(absPath, { recursive: true, mode });
    },
  };
}

// Singleton wrapper that the Workspace holds. The class keeps the
// in-flight promise so concurrent ensureIndexed() callers share one
// run.
export class MountIndex {
  readonly #db: Database;
  readonly #fs: WorkspaceFilesystem;
  readonly #mounts: Map<string, Mount>;
  #inFlight: Promise<void> | undefined;
  #done = false;

  constructor(opts: IndexerOptions) {
    this.#db = opts.db;
    this.#fs = opts.fs;
    this.#mounts = opts.mounts;
  }

  ensureIndexed(): Promise<void> {
    if (this.#done) return Promise.resolve();
    if (this.#inFlight) return this.#inFlight;
    if (this.#mounts.size === 0) {
      this.#done = true;
      return Promise.resolve();
    }
    this.#inFlight = runIndex({ db: this.#db, fs: this.#fs, mounts: this.#mounts })
      .then(() => {
        this.#done = true;
      })
      .finally(() => {
        this.#inFlight = undefined;
      });
    return this.#inFlight;
  }
}
