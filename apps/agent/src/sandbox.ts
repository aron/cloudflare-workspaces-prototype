/**
 * Sandbox — container-enabled Durable Object that owns a wsd
 * instance and exposes a `@cloudflare/workspace` Workspace over it.
 *
 * Replaces the old `@cloudflare/sandbox` SDK. The Agent DO no longer
 * holds the Workspace directly because `CloudflareContainerBackend`
 * is same-DO-only: `ctx.container` can't cross isolates. Instead the
 * Agent DO is assigned a Sandbox instance (via the warm pool) and
 * pulls a serialisable `WorkspaceStub` over Durable Object RPC.
 *
 * Wiring mirrors examples/think on the workspace `next` branch:
 *   - `WorkspaceProxy` is re-exported at the worker entrypoint so
 *     the runtime can build a loopback Fetcher for the egress
 *     interceptor.
 *   - The DO forwards `/ws` upgrades to the backend.
 *   - `getWorkspace()` returns a `WorkspaceStub` callers can hold
 *     across RPC.
 *
 * The Sandbox DO also stands in for the bits of the old
 * `@cloudflare/sandbox` SDK the WarmPool drives:
 * `startAndWaitForPorts`, `stop`, `getState`, `renewActivityTimeout`.
 * The semantics are mapped onto `Workspace.ready()` + the
 * `ctx.container` lifecycle.
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

/**
 * Options accepted by `Sandbox.gitClone()`. Mirrors the input
 * schema in `@cloudflare/git-tools`'s clone tool.
 */
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
  head?: string;
}

export { WorkspaceProxy };

/**
 * Bindings the Sandbox container DO sees. Kept minimal: it doesn't
 * need the rest of the agent env to run.
 */
interface SandboxEnv {
  Sandbox: DurableObjectNamespace<Sandbox>;
}

/**
 * Shape returned by `getState()`. Lossy mirror of the surface the
 * warm pool used to inspect on `@cloudflare/sandbox`-backed
 * containers. We only synthesise the fields the pool actually reads.
 */
export interface SandboxState {
  lastChange: number;
  status: "running" | "stopping" | "stopped" | "healthy" | "stopped_with_code";
  exitCode?: number;
}

/**
 * Base class for the Sandbox DO. `withWorkspaceContainer` wraps a
 * `DurableObject` subclass with the loopback wiring the
 * `CloudflareContainerBackend` egress needs (the runtime spawns a
 * sibling `WorkspaceProxy` bound to this DO's id). Without the
 * mixin, `CloudflareContainerBackend.handleFetch` doesn't know how
 * to route the wsd-initiated `/ws` upgrade back into the backend.
 */
class SandboxBase extends DurableObject<SandboxEnv> {}

export class Sandbox extends withWorkspaceContainer(SandboxBase) {
  readonly #backend: CloudflareContainerBackend;
  readonly #workspace: Workspace;
  /**
   * Timestamp of the last lifecycle transition. Used by `getState()`
   * so the warm pool's idle/health checks have something monotone
   * to compare against — the underlying `ctx.container.running`
   * flag doesn't carry one.
   */
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
      // `withWorkspaceContainer` makes this DO a `ContainerHostHolder`
      // (it implements `getWorkspaceContainer()` against
      // `ctx.container`). Passing `() => this` is the documented
      // pattern from examples/wsd-container.
      container: () => this,
      workspace: { binding: "Sandbox", id: ctx.id.toString() },
    });
    this.#workspace = new Workspace({
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      backends: [this.#backend],
    });
  }

  /**
   * Forward every container-routed request to the backend. wsd's
   * outbound `/ws` upgrade lands here via the loopback fetcher
   * `withWorkspaceContainer` wires up; the backend's own handler
   * knows how to dispatch.
   */
  override async fetch(request: Request): Promise<Response> {
    return this.#backend.handleFetch(request);
  }

  /**
   * Connect (if necessary) and hand out a Workspace stub the caller
   * can drive out across RPC. The stub is a lazy RpcTarget that proxies
   * every call back into this DO; it owns no resources itself.
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
   *
   * The git client is built per-call. It's cheap enough
   * (`@platformatic/vfs.create()` + an isogit cache object) that
   * caching adds more code than it saves; revisit if we add other
   * git tools (`diff`, `status`) that should share a packfile cache
   * with `clone`.
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
    // `createGitClient` doesn't expose `resolveRef`; the upstream
    // tool returns no `head` either when it isn't available, so we
    // mirror that behaviour rather than reaching past the client.
    return {
      ok: true,
      repo: opts.repo,
      ref: opts.ref ?? "default",
      dest: opts.dest,
    };
  }

  // ── Warm-pool surface ────────────────────────────────────────────
  //
  // The pool was originally written against the `@cloudflare/sandbox`
  // SDK's `Container` base class. We provide the same method names
  // here so the pool driver doesn't have to know which backend it's
  // talking to. Semantics map onto `Workspace.ready()` plus a thin
  // wrapper over `ctx.container`.

  /**
   * Pre-warm the container: start it and wait until wsd is listening
   * + the WebSocket session is up. Used by the WarmPool to fill its
   * idle pool before any agent actually requests a workspace.
   */
  async startAndWaitForPorts(): Promise<void> {
    await this.#workspace.ready();
    this.#lastChange = Date.now();
  }

  /** Alias retained for compatibility with the warm pool. */
  async warmup(): Promise<{ ok: true }> {
    await this.startAndWaitForPorts();
    return { ok: true };
  }

  /**
   * Stop the running container. The pool calls this to evict idle
   * assignments and to recycle a slot. We forward to
   * `ctx.container.destroy()` which the Cloudflare runtime treats
   * as a hard stop; the next start() rebuilds from the image.
   */
  async stop(_signal?: string): Promise<void> {
    const container = this.ctx.container;
    if (!container) return;
    if (container.running) {
      try {
        await container.destroy();
      } catch {
        // Best-effort. A double-stop or a container that already
        // exited shouldn't crash the pool's eviction sweep.
      }
    }
    this.#lastChange = Date.now();
  }

  /**
   * Keep the DO alive so the pool's alarm sweep can find us. The
   * `@cloudflare/sandbox` SDK used this to push the activity-timeout
   * timer forward; with the new backend there's no implicit timer to
   * renew, so this is a no-op that exists for API parity. Leaving it
   * in place means the pool's existing call sites don't fork around
   * a missing method on the stub.
   */
  renewActivityTimeout(): void {
    // intentional no-op
  }

  /**
   * Synthetic container state. The warm pool uses two predicates:
   * `status === "healthy"` (assignment is good to hand out) and
   * `status === "stopped"` / `"stopped_with_code"` (re-warm needed).
   * Map `ctx.container.running` to "healthy"/"stopped" so those
   * predicates keep working.
   */
  async getState(): Promise<SandboxState> {
    const container = this.ctx.container;
    const running = container?.running ?? false;
    return {
      lastChange: this.#lastChange,
      status: running ? "healthy" : "stopped",
    };
  }
}
