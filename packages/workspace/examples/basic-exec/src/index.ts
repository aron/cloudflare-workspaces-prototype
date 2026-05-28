/**
 * Minimal example: a Durable Object that owns a `Workspace` and exposes a
 * single HTTP endpoint, `POST /exec`, that runs a shell command inside the
 * companion sandbox container.
 *
 * Request:  { "command": "echo hi", "cwd"?: "/tmp" }
 * Response: { "exitCode": number, "stdout": string, "stderr": string }
 *
 * The endpoint is shaped after the container-side server's own `/exec`
 * route (see packages/workspace/src/container-sandbox/server.ts) so the
 * wire format is identical — the only difference is that here the request
 * flows DO → Workspace → container instead of bypassing the DO.
 */
import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/workspace";

// Re-export Sandbox so wrangler can find the DO class for the container
// binding declared in wrangler.jsonc.
export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  ExecAgent: DurableObjectNamespace<ExecAgent>;
  Sandbox:   DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>;
}

export class ExecAgent extends DurableObject<Env> {
  workspace: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.workspace = new Workspace({
      storage:   ctx.storage,
      sandbox:   env.Sandbox,
      sessionId: ctx.id.name ?? ctx.id.toString(),
    });
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/exec") {
      const { command, cwd } = await req.json() as { command: string; cwd?: string };
      if (typeof command !== "string" || !command.length) {
        return Response.json({ error: "missing 'command' string" }, { status: 400 });
      }
      const result = await this.workspace.exec(command, cwd);
      return Response.json(result);
    }
    return new Response("not found", { status: 404 });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // POST /exec?session=<name>  — run a command via the named ExecAgent DO.
    // `session` defaults to "default" so a plain `curl -d ... /exec` works.
    if (req.method === "POST" && url.pathname === "/exec") {
      const session = url.searchParams.get("session") ?? "default";
      const id      = env.ExecAgent.idFromName(session);
      const stub    = env.ExecAgent.get(id);
      return stub.fetch(new Request("https://do/exec", {
        method:  "POST",
        headers: req.headers,
        body:    req.body,
      }));
    }

    if (req.method === "GET" && url.pathname === "/") {
      return new Response(
        "POST /exec  body={\"command\":\"...\",\"cwd\":\"/tmp\"}  (?session=<name>)\n",
        { headers: { "content-type": "text/plain" } },
      );
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
