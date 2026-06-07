/**
 * Sandbox — container-enabled Durable Object that owns a `Workspace`
 * instance and the Cloudflare Container it talks to over capnweb.
 *
 * Wiring mirrors `examples/wsd-container/src/index.ts` upstream
 * verbatim: `withWorkspaceContainer` wraps a `DurableObject` so the
 * runtime can hand us a sibling `WorkspaceProxy` egress fetcher,
 * `CloudflareContainerBackend` joins the container handle to the
 * workspace, `fetch` forwards every container-routed request back
 * to the backend.
 *
 * The Agent DO doesn't hold the Workspace directly because
 * `CloudflareContainerBackend` is same-DO-only (`ctx.container`
 * can't cross isolates). Instead the warm pool assigns each agent
 * session to a Sandbox DO and the agent pulls a `WorkspaceStub` —
 * a thin RpcTarget — across DO RPC.
 *
 * The four warm-pool surface methods (`startAndWaitForPorts` /
 * `stop` / `getState` / `gitClone`) are direct pass-throughs over
 * `ctx.container.*` plus the workspace. There's no synthetic
 * "connected" flag or rebuild dance: the Workspace's own
 * `connect()` retry loop handles transient session drops, and
 * `ctx.container.running` is the source of truth for whether the
 * container is up. If it isn't, the next caller's `ready()` will
 * boot it.
 */

import {
  CloudflareContainerBackend,
  type DurableObjectStorageLike,
  Workspace,
  WorkspaceProxy,
  type WorkspaceStub,
  withWorkspaceContainer,
} from "@cloudflare/workspace";
import { createGitClient } from "@cloudflare/workspace/git";
import { DurableObject } from "cloudflare:workers";

/** Options for `Sandbox.gitClone()`. Mirrors @cloudflare/git-tools. */
export interface GitCloneRequest {
  repo: string;
  dest: string;
  ref?: string;
  depth: number;
}

export interface GitCloneResponse {
  ok: true;
  repo: string;
  ref: string;
  dest: string;
}

export { WorkspaceProxy };

/**
 * Bindings the Sandbox DO needs. Kept minimal — only the self-
 * binding (so the loopback `WorkspaceProxy` egress can reach
 * back into this instance) is required.
 */
interface SandboxEnv {
  Sandbox: DurableObjectNamespace<Sandbox>;
}

/**
 * Lifecycle snapshot the warm pool reads via `getState()`.
 * `lastChange` exists so the pool's idle/health checks have
 * something monotone to compare against — `ctx.container.running`
 * doesn't carry a timestamp.
 *
 * `status` is a literal projection of `ctx.container.running`:
 * `"healthy"` when running, `"stopped"` when not. The richer
 * status enum (`"starting"`, `"stopping"`, `"stopped_with_code"`,
 * etc.) the old `@cloudflare/sandbox` SDK reported isn't tracked
 * here — the pool only branches on `=== "healthy"` and `=== "stopped"`.
 */
export interface SandboxState {
  lastChange: number;
  status: "healthy" | "stopped";
}

class SandboxBase extends DurableObject<SandboxEnv> {}

export class Sandbox extends withWorkspaceContainer(SandboxBase) {
  readonly #backend: CloudflareContainerBackend;
  readonly #workspace: Workspace;
  #lastChange = Date.now();

  constructor(ctx: DurableObjectState, env: SandboxEnv) {
    super(ctx, env);
    if (!ctx.container) {
      throw new Error(
        "Sandbox DO is not container-enabled. Check wrangler.jsonc " +
          "for a `containers` entry whose class_name is `Sandbox`.",
      );
    }
    this.#backend = new CloudflareContainerBackend({
      container: () => this,
      workspace: { binding: "Sandbox", id: ctx.id.toString() },
    });
    this.#workspace = new Workspace({
      // ctx.storage.sql.exec returns a narrower row type than
      // DurableObjectStorageLike declares; the runtime shape
      // matches. Cast through unknown to bypass invariance.
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      backends: [this.#backend],
    });
  }

  /**
   * Forward every container-routed request to the backend. wsd's
   * outbound `/ws` upgrade lands here via the loopback fetcher
   * `withWorkspaceContainer` wires up; the backend dispatches.
   */
  override async fetch(request: Request): Promise<Response> {
    return this.#backend.handleFetch(request);
  }

  /**
   * Hand out a `WorkspaceStub` the caller can drive across DO RPC.
   * Awaits `ready()` so the container is up and the capnweb session
   * established before the stub leaves this isolate. The Workspace
   * caches its `#readyPromise` and reconnects internally on transient
   * failures — we don't manage that lifecycle here.
   */
  async getWorkspace(): Promise<WorkspaceStub> {
    await this.#workspace.ready();
    this.#lastChange = Date.now();
    return this.#workspace.stub();
  }

  /**
   * Shallow-clone a public GitHub repo into the workspace. Runs
   * here (not on the Agent DO) because `@cloudflare/workspace/git`
   * needs `Workspace.provider()`, which only exists on the in-DO
   * `Workspace` instance — the `WorkspaceStub` we hand the agent
   * doesn't expose a provider.
   */
  async gitClone(opts: GitCloneRequest): Promise<GitCloneResponse> {
    await this.#workspace.ready();
    this.#lastChange = Date.now();
    const git = createGitClient({ ws: this.#workspace });
    const url = `https://github.com/${opts.repo}`;
    // Wipe any prior clone at the target. Stale `.git` directories
    // from a previous failed call cause isomorphic-git to error out
    // with "commit ... not available locally" — the second clone
    // refuses to overwrite the orphaned refs.
    await this.#workspace.fs.rm(opts.dest, { recursive: true, force: true });
    await this.#workspace.fs.mkdir(opts.dest, { recursive: true });
    await git.clone({
      url,
      dir: opts.dest,
      ref: opts.ref,
      depth: opts.depth,
      singleBranch: true,
    });
    return {
      ok: true,
      repo: opts.repo,
      ref: opts.ref ?? "default",
      dest: opts.dest,
    };
  }

  // ── Warm-pool surface ────────────────────────────────────────────
  //
  // The pool was originally written against the @cloudflare/sandbox
  // SDK's Container base class. We retain three of the original
  // method names so the pool driver doesn't need to know which
  // backend it's talking to; each is a one-liner over
  // `ctx.container.*` plus the workspace.

  /**
   * Pre-warm the container: start it and wait until wsd is listening
   * and the capnweb session is up. `Workspace.ready()` does both;
   * the warm pool calls this when filling its idle slots so the
   * first agent to land on this Sandbox doesn't pay the boot cost.
   */
  async startAndWaitForPorts(): Promise<void> {
    await this.#workspace.ready();
    this.#lastChange = Date.now();
  }

  /**
   * Stop the running container. Pool calls this for idle eviction
   * and slot recycling. `ctx.container.destroy()` tears down the
   * VM; the next `ready()` will rebuild it from the image. Workspace
   * state (SQLite VFS) lives in DO storage and survives untouched.
   *
   * Best-effort: a double-stop or an already-exited container
   * shouldn't crash the pool's eviction sweep.
   */
  async stop(_signal?: string): Promise<void> {
    const container = this.ctx.container;
    if (!container?.running) return;
    try {
      await container.destroy();
    } catch {
      // already exited / double-stop / lost the handle — pool can't
      // recover regardless, and the next start will rebuild.
    }
    this.#lastChange = Date.now();
  }

  /**
   * Synthetic container state. The warm pool branches on
   * `status === "healthy"` (good to hand out) and `status === "stopped"`
   * (re-warm needed). Map `ctx.container.running` directly.
   */
  async getState(): Promise<SandboxState> {
    return {
      lastChange: this.#lastChange,
      status: this.ctx.container?.running ? "healthy" : "stopped",
    };
  }
}
