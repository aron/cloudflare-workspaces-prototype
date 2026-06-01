// WorkspaceProxy — the WorkerEntrypoint a container DO hands to
// ctx.container.interceptOutboundHttp(...) so wsd can dial back
// into the DO.
//
// Why this exists as a separate class rather than passing the DO
// itself: `interceptOutboundHttp` requires a runtime-wrapped
// binding Fetcher (has `getSubrequestChannel` plumbing the
// platform needs). Plain DO stubs fail that check; only loopback
// bindings produced by `ctx.exports.<ClassName>(...)` for a
// top-level-exported WorkerEntrypoint pass.
//
// Usage shape in user code:
//
//   // Worker entry point — re-export the class so the runtime can
//   // wrap it into a loopback binding.
//   export { WorkspaceProxy } from "@cloudflare/workspace";
//
//   class WsdContainer extends DurableObject<Env> {
//     constructor(ctx: DurableObjectState, env: Env) {
//       super(ctx, env);
//       this.#backend = new CloudflareContainerBackend({
//         container: () => ctx.container!,
//         egress: ctx.exports.WorkspaceProxy({
//           props: {
//             // Binding name in env that points back at this DO.
//             binding: "WSD",
//             // The DO instance the upgrade should route to.
//             id: ctx.id.toString(),
//           },
//         }),
//       });
//     }
//
//     override async fetch(req: Request): Promise<Response> {
//       // The DO answers /health (port-readiness poll from the
//       // backend) and /ws (capnweb upgrade) on its own fetch().
//       const url = new URL(req.url);
//       if (url.pathname === "/health") return new Response("ok\n");
//       if (url.pathname === "/ws") return this.#backend.handleFetch(req);
//       return new Response("not found", { status: 404 });
//     }
//   }
//
// `binding` is a string because props travel through structured
// clone and DurableObjectNamespace references aren't clonable. The
// proxy looks up `env[binding]` at fetch time and falls back to a
// clear error if the name doesn't resolve. The DO class doesn't
// need to live in @cloudflare/workspace — the proxy works for any
// DO that implements a fetch() handler answering /health and /ws.

import { WorkerEntrypoint } from "cloudflare:workers";

export interface WorkspaceProxyProps {
  // Name of a DurableObjectNamespace binding in env. The proxy
  // resolves `env[binding]` at request time.
  binding: string;
  // Stringified DurableObjectId — typically `ctx.id.toString()`
  // from inside the owning DO's constructor.
  id: string;
}

export class WorkspaceProxy extends WorkerEntrypoint<unknown, WorkspaceProxyProps> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/ws") {
      const { binding, id } = this.ctx.props;
      const ns = (this.env as Record<string, unknown>)[binding] as
        | DurableObjectNamespace
        | undefined;
      if (!ns) {
        return new Response(`WorkspaceProxy: env.${binding} is not a DurableObjectNamespace`, {
          status: 500,
        });
      }
      const stub = ns.get(ns.idFromString(id));
      return stub.fetch(request);
    }

    return new Response("not found", { status: 404 });
  }
}
