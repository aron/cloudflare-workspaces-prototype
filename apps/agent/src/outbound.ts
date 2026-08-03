import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * Open-internet `Fetcher` for the `javascript` exec backend.
 *
 * The worker-javascript backend runs user code in a Dynamic Worker
 * whose `globalOutbound` defaults to `null` — no public network. To
 * let in-isolate `fetch()` reach the internet we hand the Dynamic
 * Worker a `Fetcher` as its `globalOutbound`; every `fetch()` the
 * isolate makes is routed here, and this entrypoint forwards it to
 * the Worker's own global `fetch` (the open network).
 *
 * It's wired through the self-referential loopback binding
 * `this.ctx.exports.OutboundProxy()` — the same `ctx.exports` pattern
 * `@cloudflare/computer` uses for `WorkspaceServiceProxy`. Exported at
 * the worker entrypoint (see index.ts) so the loopback resolves at
 * runtime.
 *
 * This gives the JavaScript plane the same open-network posture the
 * container backend already has; the isolate stays sandboxed
 * otherwise (no filesystem beyond the workspace capability, no
 * bindings).
 */
export class OutboundProxy extends WorkerEntrypoint {
  override fetch(request: Request): Promise<Response> {
    return fetch(request);
  }
}
