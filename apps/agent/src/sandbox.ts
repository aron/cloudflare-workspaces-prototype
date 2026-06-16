/**
 * Sandbox — container-host Durable Object. One per Cloudflare
 * Container; minted by the warm pool; lives for the lifetime of
 * that container.
 *
 * Wiring: cross-DO. The *Agent* DO owns the `Workspace` instance
 * and the `CloudflareContainerBackend` that drives wsd. The backend's
 * `container: () => ...` factory returns a stub to one of these
 * Sandboxes; the backend then calls `getWorkspaceContainer()` over
 * Workers RPC to reach the runtime container handle.
 *
 * That makes this class deliberately near-empty:
 *
 *   - `withWorkspaceContainer` installs `getWorkspaceContainer()`,
 *     which the backend uses to drive `ctx.container.start()`,
 *     `ctx.container.interceptOutboundHttp()`, and
 *     `ctx.container.getTcpPort()`. That's the whole point of
 *     this DO.
 *
 *   - `WorkspaceProxy` is re-exported at the worker entrypoint
 *     (not here \u2014 it's a top-level export in `index.ts`) so wsd's
 *     `/ws` callback can route back into the Agent DO that owns
 *     the workspace.
 *
 *   - Three lifecycle methods (`startAndWaitForPorts`, `stop`,
 *     `getState`) survive only because the warm pool driver calls
 *     them. Each is a direct pass-through to `ctx.container.*`
 *     with no synthesised state. The pool branches on
 *     `getState().status === "healthy"`, mapped from
 *     `ctx.container.running`.
 *
 * What's *gone* compared to the prior shape: no Workspace instance,
 * no CloudflareContainerBackend, no `getWorkspace()` or `gitClone()`
 * RPC, no synthetic connect-state tracking. All of that moved to
 * the Agent DO where the Workspace now lives.
 */

import { withWorkspaceContainer } from "@cloudflare/workspace/backends/container";
import { DurableObject } from "cloudflare:workers";

/**
 * Lifecycle snapshot the warm pool reads via `getState()`.
 * `lastChange` exists so the pool's idle/health checks have
 * something monotone to compare against \u2014 `ctx.container.running`
 * doesn't carry a timestamp.
 */
export interface SandboxState {
  lastChange: number;
  status: "healthy" | "stopped";
}

interface SandboxEnv {
  Sandbox: DurableObjectNamespace<Sandbox>;
}

class SandboxBase extends DurableObject<SandboxEnv> {}

export class Sandbox extends withWorkspaceContainer(SandboxBase) {
  #lastChange = Date.now();

  constructor(ctx: DurableObjectState, env: SandboxEnv) {
    super(ctx, env);
    if (!ctx.container) {
      throw new Error(
        "Sandbox DO is not container-enabled. Check wrangler.jsonc " +
          "for a `containers` entry whose class_name is `Sandbox`.",
      );
    }
  }

  // Previously this DO also exposed `containerFetch(port, req, init)`
  // returning a plain `{ ok, status, body }` envelope so our forked
  // `CrossDOContainerBackend` could route /health and /connect
  // through the container-owning DO without crossing a Fetcher
  // back over Workers RPC. alpha.9's `WorkspaceContainerAPI.fetchPort(...)`
  // does the same thing and is installed automatically by
  // `withWorkspaceContainer`; the upstream `CloudflareContainerBackend`
  // calls it directly. Both the bespoke method here and the fork
  // are gone in alpha.9.

  // ── Warm-pool surface ────────────────────────────────────────────
  //
  // All three methods are RPC entries the warm pool driver calls
  // on a Sandbox stub. None of them carry workspace state \u2014 the
  // Agent DO owns that.

  /**
   * Pre-warm the container by starting it. The warm pool calls this
   * when filling idle slots so the first Agent to dial doesn't pay
   * the boot cost. `ctx.container.start()` is idempotent at the
   * runtime layer; a redundant start on a running container is a
   * no-op.
   *
   * We don't probe the wsd port from here \u2014 that's the backend's
   * job in the Agent DO's `connect()` path. This call only buys
   * the container-image pull + VM start time.
   */
  async startAndWaitForPorts(): Promise<void> {
    const container = this.ctx.container;
    if (!container) return;
    if (!container.running) {
      // Start with the same shape as @cloudflare/workspace's
      // WorkspaceContainerAPI.start(). A prewarmed container is already
      // `running` when the Agent backend dials it; the upstream start method
      // returns early in that case, so this warm-pool start is the only chance
      // to install the internet proxy and seed wsd's env.
      container.start({
        enableInternet: true,
        env: {
          PORT: "8080",
          MOUNT_POINT: "/workspace",
        },
      });
    }
    this.#lastChange = Date.now();
  }

  /**
   * Stop the running container. Pool calls this for idle eviction
   * and slot recycling. `ctx.container.destroy()` tears down the
   * VM; the next `start()` rebuilds it from the image.
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
      // already exited / lost the handle. pool can't recover
      // regardless; next start will rebuild.
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
