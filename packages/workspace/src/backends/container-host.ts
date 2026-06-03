// ContainerHost — the seam CloudflareContainerBackend drives instead
// of talking to a Container binding directly. Two reasons it exists:
//
//   1. Same-DO vs cross-DO. A container-pool deployment wants the
//      DO that owns the Workspace (e.g. an Agent DO) to be separate
//      from the DO that owns the Container binding (a pool member
//      that can be re-leased between sessions). The pool member's
//      ctx.container isn't reachable from the Agent's isolate, but
//      a DO stub satisfying ContainerHost is.
//
//   2. Testability. The interface is narrower than `Container` —
//      three async methods — and fakes don't need to mimic the
//      full runtime surface.
//
// The workspace argument to interceptOutboundHttp is intentionally a
// union: Fetcher for the same-DO case (where the caller can build a
// WorkspaceProxy loopback fetcher in the right isolate), or
// WorkspaceRef plain data for the cross-DO case (Fetcher can't
// travel over Workers RPC, so the host-side constructs the
// WorkspaceProxy itself from {binding, id}).

// Identifies the Durable Object that owns the Workspace and answers
// the /ws upgrade. Plain data so it can travel over Workers RPC.
export interface WorkspaceRef {
  // Binding name in the host Worker's env that resolves to the
  // DurableObjectNamespace for the Workspace-owning DO class.
  binding: string;
  // Stringified DurableObjectId of the specific Workspace owner.
  id: string;
}

// Driver surface CloudflareContainerBackend talks to. Same-DO
// callers use localContainerHost(ctx); cross-DO callers extend
// ContainerHostDO and pass an RPC stub.
export interface ContainerHost {
  // Idempotent start. Returns once the runtime has accepted the
  // start command; readiness is verified by the backend polling
  // /health via fetchPort.
  start(env: Record<string, string>): Promise<void>;

  // Wire `host` → workspace inside the container's egress table.
  // Called once per backend connect(). Same-DO ContainerHost
  // implementations accept a Fetcher built locally; cross-DO ones
  // accept a WorkspaceRef and construct the fetcher themselves.
  interceptOutboundHttp(host: string, workspace: Fetcher | WorkspaceRef): Promise<void>;

  // Forward an HTTP request to the named TCP port inside the
  // container. The backend uses this for the /health poll and the
  // POST /connect handshake.
  fetchPort(port: number, request: Request): Promise<Response>;
}

// Same-DO adapter. Wraps `ctx.container` directly. The caller is
// responsible for handing in a workspace Fetcher when calling
// connect() through the backend — typically `ctx.exports.WorkspaceProxy(...)`.
//
// We don't construct the WorkspaceProxy fetcher in here because
// ctx.exports requires per-binding type augmentation that lives in
// the user's worker-configuration.d.ts, not in @cloudflare/workspace.
// Pushing the construction to the call site keeps this helper
// type-portable across users.
export function localContainerHost(ctx: DurableObjectState): ContainerHost {
  const container = ctx.container;
  if (!container) {
    throw new Error("localContainerHost: DO is not container-enabled (check wrangler.jsonc)");
  }
  return {
    async start(env) {
      if (container.running) return;
      container.start({ enableInternet: true, env });
    },
    async interceptOutboundHttp(host, workspace) {
      if (!isFetcher(workspace)) {
        throw new Error(
          "localContainerHost: same-DO callers must pass a Fetcher (e.g. ctx.exports.WorkspaceProxy(...)); WorkspaceRef is only used by cross-DO ContainerHostDO",
        );
      }
      await container.interceptOutboundHttp(host, workspace);
    },
    async fetchPort(port, request) {
      return container.getTcpPort(port).fetch(request);
    },
  };
}

function isFetcher(value: Fetcher | WorkspaceRef): value is Fetcher {
  return typeof (value as Fetcher).fetch === "function";
}

// Cross-DO callers implement ContainerHost on a container-enabled
// DO of their own. The shape is roughly:
//
//   import { DurableObject } from "cloudflare:workers";
//   import {
//     type ContainerHost,
//     type WorkspaceRef,
//     WorkspaceProxy,
//   } from "@cloudflare/workspace";
//
//   export { WorkspaceProxy };
//
//   export class WsdHost extends DurableObject<Env> implements ContainerHost {
//     async start(env: Record<string, string>) {
//       const c = this.ctx.container!;
//       if (!c.running) c.start({ enableInternet: true, env });
//     }
//     async interceptOutboundHttp(host: string, workspace: Fetcher | WorkspaceRef) {
//       if (typeof (workspace as Fetcher).fetch === "function") {
//         throw new Error("WsdHost only accepts WorkspaceRef across the RPC boundary");
//       }
//       const { binding, id } = workspace as WorkspaceRef;
//       await this.ctx.container!.interceptOutboundHttp(
//         host,
//         this.ctx.exports.WorkspaceProxy({ props: { binding, id } }),
//       );
//     }
//     async fetchPort(port: number, req: Request) {
//       return this.ctx.container!.getTcpPort(port).fetch(req);
//     }
//   }
//
// Then in the Agent DO:
//
//   #backend = new CloudflareContainerBackend({
//     container: async () => {
//       const memberId = await pickPoolMember(this.env, this.ctx.id);
//       return this.env.WsdHost.get(this.env.WsdHost.idFromString(memberId));
//     },
//     workspace: { binding: "AgentDO", id: this.ctx.id.toString() },
//   });
//
// The base class isn't shipped from @cloudflare/workspace itself
// because ctx.exports.WorkspaceProxy depends on per-Worker type
// augmentation that lives in the consumer's worker-configuration.d.ts.
