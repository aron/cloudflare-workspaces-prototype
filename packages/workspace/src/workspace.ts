// Host-side Workspace facade.
//
// Runs inside a Cloudflare Worker / Durable Object. Owns a local
// workspace-fs Database (the host store) and a SyncRPC connection
// to wsd. Filesystem operations on Workspace.fs mutate the local
// store directly via the WorkspaceFilesystem class from
// @cloudflare/workspace-fs; sync between the host store and wsd
// is driven explicitly via Workspace.push() / Workspace.pull()
// (TODO: not yet wired — those land in a follow-up commit). The
// shell-side pre-exec push / post-exec pull bracket already lives
// on Workspace.shell.exec.

import {
  Database,
  type DurableObjectStorageLike,
  initializeSchema,
  WorkspaceFilesystem,
} from "@cloudflare/workspace-fs";

import type { BackendHandle, WorkspaceBackend } from "./backend.js";
import { WorkspaceShell } from "./shell.js";
import { WorkspaceStub } from "./stub.js";

export interface WorkspaceOptions {
  // Local store backing this Workspace. In a Durable Object, pass
  // `ctx.storage`; in tests, pass a SQLiteTestStorage from
  // @cloudflare/workspace-fs/testing. The constructor opens a
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
  readonly #backends: WorkspaceBackend[];
  readonly #now: () => number;
  #handle: BackendHandle | undefined;
  #shell: WorkspaceShell | undefined;
  #readyPromise: Promise<void> | undefined;

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

  // Shell facade. Throws if called before ready() resolves.
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
        this.#shell = new WorkspaceShell(handle.rpc);
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
