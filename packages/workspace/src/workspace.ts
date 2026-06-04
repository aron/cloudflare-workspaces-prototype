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
  type ApplyResult,
  Database,
  type DurableObjectStorageLike,
  initializeSchema,
  SQLiteWorkspaceProvider,
  WorkspaceFilesystem,
} from "@cloudflare/dofs";
import { pullOnce, pushOnce, reconcileWatermarks } from "@cloudflare/workspace-rpc/driver";

import type { BackendHandle, WorkspaceBackend } from "./backend.js";
import { MountIndex } from "./mounts/index.js";
import { buildMountRegistry, type MountValue } from "./mounts/registry.js";
import type { Mount } from "./mounts/types.js";
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

  // Identifier for this workspace / session. Forwarded to mount
  // factories via MountContext.sessionId. Optional; defaults to "".
  sessionId?: string;

  // Mounts to register against the workspace. Keys are absolute
  // mount roots (no trailing slash, no nesting). Values are either
  // bare Mount objects or factories that take a MountContext and
  // return one. Factories are called once at construction.
  mounts?: Record<string, MountValue>;

  // Bounded retry policy for ready(). When omitted, ready() runs
  // the backend list once and surfaces the first failure — the
  // shipped behaviour before retries existed. When set, a transient
  // failure on every backend triggers a wait + retry, up to
  // `attempts` total tries with exponential backoff. The delay
  // starts at `initialDelayMs` and doubles each round, capped at
  // `maxDelayMs`.
  reconnect?: ReconnectOptions;
}

export interface ReconnectOptions {
  // Total connect() attempts across the backend list. 1 means
  // no retry (one pass). Default 1.
  attempts: number;
  // First backoff delay in ms. Doubles each round up to maxDelayMs.
  initialDelayMs: number;
  // Cap on the per-attempt backoff delay.
  maxDelayMs: number;
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
  readonly #reconnect: ReconnectOptions;
  readonly #now: () => number;
  readonly #mounts: Map<string, Mount>;
  readonly #mountIndex: MountIndex;
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
    this.#reconnect = options.reconnect ?? { attempts: 1, initialDelayMs: 0, maxDelayMs: 0 };
    this.#mounts = buildMountRegistry(options.mounts, {
      sessionId: options.sessionId,
      vfs: () => this.provider(),
    });
    this.#mountIndex = new MountIndex({
      db: this.#db,
      fs: this.#fs,
      mounts: this.#mounts,
    });
  }

  // Force every registered mount to materialize. Idempotent; safe to
  // call from multiple places (ready(), tests, future fs/shell
  // entry points). Concurrent callers share one materialize() pass
  // per mount.
  ensureMountsIndexed(): Promise<void> {
    return this.#mountIndex.ensureIndexed();
  }

  // Resolved mount registry, keyed by absolute mount root. Returned
  // as a defensive copy so callers can't mutate the internal map.
  mounts(): Map<string, Mount> {
    return new Map(this.#mounts);
  }

  // Local store. Exposed for tests / diagnostics and for the
  // sync helpers that take a Database directly.
  get db(): Database {
    return this.#db;
  }

  // Filesystem facade — the documented Workspace.fs surface from
  // docs/04. Available immediately; doesn't need ready() because
  // reads and writes hit the local store, not the wire.
  //
  // Read-only mount enforcement lives at the data layer in
  // @cloudflare/dofs: writeFile / mkdir / rm consult the registered
  // mount roots and reject EROFS without needing a workspace-side
  // wrapper. The same check fires on the apply path used by
  // pullOnce, so container-side writes under a read-only mount are
  // also rejected (and surfaced via Workspace.pull's skipped[]).
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
    this.#readyPromise = (async () => {
      await this.#connect();
      // Index after the backend is wired so reads of mounted paths
      // are populated before the first push() inside an exec()
      // bracket can ship them.
      await this.#mountIndex.ensureIndexed();
    })();
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
  // push() returns the number of entries shipped to the remote so
  // a polling loop can decide whether to tick again. pull() returns
  // the dofs ApplyResult { applied, skipped } — `applied` is the
  // number of entries written into the local store, `skipped`
  // surfaces container-side writes the apply path rejected because
  // they targeted a read-only mount root. Callers that don't care
  // about read-only enforcement read `applied`; the shell exec
  // bracket folds `skipped` into its ExecResult so users see what
  // stayed authoritative on the mount.
  push(): Promise<number> {
    return this.#serialize(async () => {
      await this.ready();
      if (!this.#handle) throw new Error("Workspace not connected");
      return pushOnce(this.#db, this.#handle.rpc.sync);
    });
  }

  pull(): Promise<ApplyResult> {
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
    const { attempts, initialDelayMs, maxDelayMs } = this.#reconnect;
    let delay = initialDelayMs;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.#connectOnce();
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === attempts) break;
        await sleep(delay);
        delay = Math.min(delay * 2 || 1, maxDelayMs);
      }
    }
    // Throwing the last attempt's error preserves the per-backend
    // summary the pass produced — the caller still sees which
    // backend failed and why.
    throw lastError;
  }

  async #connectOnce(): Promise<void> {
    const errors: Array<{ id: string; error: unknown }> = [];
    for (const backend of this.#backends) {
      try {
        const handle = await backend.connect();
        // Reconcile watermarks before publishing the handle. If the
        // remote restarted between our pushes / fetches it has lost
        // state we thought it had; reset the local cursors so the
        // next tick rebaselines. Done eagerly on connect because
        // pushOnce's localRev <= sincePush early-return otherwise
        // hides the mismatch.
        await reconcileWatermarks(this.#db, handle.rpc.sync);
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

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
