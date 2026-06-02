// Host-side Workspace facade.
//
// Runs inside a Cloudflare Worker / Durable Object. Owns a local
// dofs Database (the host store) and a SyncRPC connection
// to wsd. Filesystem operations on Workspace.fs mutate the local
// store directly via the WorkspaceFilesystem class from
// @cloudflare/dofs; sync between the host store and wsd
// is driven explicitly via Workspace.push() / Workspace.pull().
// The shell-side pre-exec push / post-exec pull bracket lives
// on Workspace.shell.exec.

import {
  Database,
  type DurableObjectStorageLike,
  initializeSchema,
  SQLiteWorkspaceProvider,
  WorkspaceFilesystem,
} from "@cloudflare/dofs";
import { pullOnce, pushOnce } from "@cloudflare/workspace-rpc/driver";

import type { BackendHandle, WorkspaceBackend } from "./backend.js";
import { WorkspaceShell } from "./shell.js";
import { WorkspaceStub } from "./stub.js";

export interface WorkspaceOptions {
  // Local store backing this Workspace. In a Durable Object, pass
  // `ctx.storage`; in tests, pass a SQLiteTestStorage from
  // @cloudflare/dofs/testing. The constructor opens a
  // Database against it and runs initializeSchema (idempotent).
  storage: DurableObjectStorageLike;

  // Backends are tried in declared order. The first one whose
  // connect() resolves wins; the rest are not consulted.
  backends: WorkspaceBackend[];

  // Clock used for mtime / last_seen on local FS writes. Defaults
  // to Date.now. Override for deterministic tests.
  now?: () => number;
}

export class Workspace {
  readonly #db: Database;
  readonly #fs: WorkspaceFilesystem;
  /**
   * Lazily-constructed dofs provider. Built on first `provider()`
   * call; cached so repeated callers share the same instance.
   */
  #provider: SQLiteWorkspaceProvider | undefined;
  readonly #backends: WorkspaceBackend[];
  readonly #now: () => number;
  #handle: BackendHandle | undefined;
  #shell: WorkspaceShell | undefined;
  #readyPromise: Promise<void> | undefined;
  // FIFO that serializes mutating entry points (push, pull, and the
  // shell exec bracket which goes through them). Reads bypass the
  // queue entirely — they hit the local store directly through
  // Workspace.fs. The queue is a single tail-promise: each new caller
  // chains its work onto the tail and updates it. See docs/02 "Concurrent
  // mutators".
  #mutationTail: Promise<unknown> = Promise.resolve();

  constructor(options: WorkspaceOptions) {
    if (options.backends.length === 0) {
      throw new Error("Workspace requires at least one backend");
    }
    this.#now = options.now ?? Date.now;
    this.#db = new Database(options.storage);
    initializeSchema(this.#db, this.#now);
    this.#fs = new WorkspaceFilesystem(this.#db, { now: this.#now });
    this.#backends = options.backends.slice();
  }

  // Local store. Exposed for tests / diagnostics and for the
  // sync helpers that take a Database directly.
  get db(): Database {
    return this.#db;
  }

  // Filesystem facade — the documented Workspace.fs surface from
  // docs/04. Available immediately; doesn't need ready() because
  // reads and writes hit the local store, not the wire.
  get fs(): WorkspaceFilesystem {
    return this.#fs;
  }

  /**
   * Underlying dofs `SQLiteWorkspaceProvider` over the local store.
   *
   * This is the `@platformatic/vfs`-shaped provider — a node:fs
   * surface with full symlink support. Callers that want a
   * `VirtualFileSystem` (e.g. to hand to isomorphic-git) wrap it
   * themselves to keep `@platformatic/vfs` out of this package's
   * dependency tree:
   *
   * ```ts
   * import { create, VirtualProvider } from "@platformatic/vfs";
   * import type { SQLiteWorkspaceProvider } from "@cloudflare/dofs";
   *
   * class Glue extends VirtualProvider {
   *   constructor(private inner: SQLiteWorkspaceProvider) { super(); }
   *   override get readonly()         { return this.inner.readonly; }
   *   override get supportsSymlinks() { return this.inner.supportsSymlinks; }
   *   override get supportsWatch()    { return this.inner.supportsWatch; }
   * }
   * // Forward every node:fs method to `inner` via a
   * // `for (const name of [...]) Object.defineProperty(...)` loop.
   * const vfs = create(new Glue(workspace.provider()));
   * ```
   *
   * Available immediately; doesn't need `ready()` because the
   * provider only reads/writes the local store, not the wire.
   */
  provider(): SQLiteWorkspaceProvider {
    if (!this.#provider) {
      this.#provider = new SQLiteWorkspaceProvider(this.#db, { now: this.#now });
    }
    return this.#provider;
  }

  // Shell facade. Throws if called before ready() resolves.
  // exec() brackets the spawn with push() / pull(); see shell.ts.
  get shell(): WorkspaceShell {
    if (!this.#shell) {
      throw new Error("Workspace not connected — await ready() first");
    }
    return this.#shell;
  }

  // Walk the backends in declared order. Caches the first
  // successful BackendHandle so subsequent .shell / .close calls
  // reuse it. ready() is idempotent; multiple callers share
  // the same in-flight connection attempt.
  ready(): Promise<void> {
    if (this.#readyPromise) return this.#readyPromise;
    this.#readyPromise = this.#connect();
    return this.#readyPromise;
  }

  // Wrap this workspace in a WorkspaceStub so it can be handed
  // across the Workers-RPC boundary (e.g. returned from a DO RPC
  // method). The stub is a lazy RpcTarget — it doesn't own any
  // resources itself; it just delegates back to this workspace.
  // Throws if called before ready() resolves, because the inner
  // .shell getter does.
  stub(): WorkspaceStub {
    // Touch .shell so the not-connected error surfaces here
    // rather than on the first RPC method call.
    void this.shell;
    return new WorkspaceStub(this);
  }

  // Sync the local store with the connected backend.
  //
  // push() ships everything the host has written since the last
  // push to wsd; pull() applies everything wsd has produced since
  // the last pull. Both are explicit — the package doesn't run a
  // background loop. WorkspaceShell brackets exec() automatically;
  // call these directly for FS-only flows that need to hand off to
  // the container via a tool other than exec.
  //
  // Returns the number of entries transferred so a polling loop
  // can decide whether to tick again.
  push(): Promise<number> {
    return this.#serialize(async () => {
      await this.ready();
      if (!this.#handle) throw new Error("Workspace not connected");
      return pushOnce(this.#db, this.#handle.rpc.sync);
    });
  }

  pull(): Promise<number> {
    return this.#serialize(async () => {
      await this.ready();
      if (!this.#handle) throw new Error("Workspace not connected");
      return pullOnce(this.#db, this.#handle.rpc.sync);
    });
  }

  // Tail-promise FIFO. Each call chains onto the existing tail so
  // it can't start until every queued mutation ahead of it has
  // resolved (or rejected). Rejections are not contagious: we swallow
  // the rejection here so a failing mutation doesn't poison the rest
  // of the queue — the caller still sees the original rejection via
  // the returned promise.
  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#mutationTail.then(fn, fn);
    this.#mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async close(): Promise<void> {
    if (this.#handle) {
      try {
        await this.#handle.close();
      } finally {
        this.#handle = undefined;
        this.#shell = undefined;
        this.#readyPromise = undefined;
      }
    }
  }

  async #connect(): Promise<void> {
    const errors: Array<{ id: string; error: unknown }> = [];
    for (const backend of this.#backends) {
      try {
        const handle = await backend.connect();
        this.#handle = handle;
        // Workspace satisfies the Sync interface in shell.ts via
        // its public push() / pull() methods.
        this.#shell = new WorkspaceShell(handle.rpc.shell, this);
        // Tear down our caches if the transport drops mid-session.
        // Backends without a `closed` promise (in-process fakes) opt
        // out by omitting it; we only react when it's wired.
        if (handle.closed) {
          handle.closed
            .catch(() => {})
            .then(() => {
              // Only clear if this handle is still the current one.
              // A close() that already ran will have nulled #handle,
              // and a subsequent ready() may have installed a new one.
              if (this.#handle === handle) {
                this.#handle = undefined;
                this.#shell = undefined;
                this.#readyPromise = undefined;
              }
            });
        }
        return;
      } catch (error) {
        errors.push({ id: backend.id, error });
      }
    }
    const summary = errors
      .map(
        ({ id, error }) => `  - ${id}: ${error instanceof Error ? error.message : String(error)}`,
      )
      .join("\n");
    throw new Error(`Workspace: no backend reachable\n${summary}`);
  }
}
