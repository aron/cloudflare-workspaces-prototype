/**
 * Minimal example: a Durable Object that owns a `Workspace` and exposes
 * two endpoints, one blocking and one streaming.
 *
 *   POST /exec         { command, cwd? } -> { exitCode, stdout, stderr }
 *     Runs the command via Workspace.exec and returns once it exits.
 *
 *   POST /exec/stream  { command, cwd? } -> NDJSON stream of LogEvents
 *     Spawns the command via Workspace.startProcess and streams stdout,
 *     stderr, and the final exit event back as newline-delimited JSON.
 *     Same wire shape as the sandbox SDK's LogEvent. Use to debug the
 *     streaming exec path end-to-end:
 *       curl -N -X POST <worker>/exec/stream -d '{"command":"ls -la /"}'
 *
 * The endpoints are shaped after the container-side server's routes (see
 * packages/workspace/src/container-sandbox/server.ts) so the wire format
 * is identical end-to-end.
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

    if (req.method === "POST" && url.pathname === "/exec/stream") {
      const { command, cwd } = await req.json() as { command: string; cwd?: string };
      if (typeof command !== "string" || !command.length) {
        return Response.json({ error: "missing 'command' string" }, { status: 400 });
      }
      return this.streamExec(command, cwd);
    }

    return new Response("not found", { status: 404 });
  }

  /**
   * Spawn `command` via Workspace.startProcess and pipe its LogEvents
   * back as newline-delimited JSON. One LogEvent per line; the stream
   * closes after the `exit` event (or after an `error` event).
   *
   * Used to validate the streaming exec wiring end-to-end without the
   * agent's tool layer in the picture. If this works in prod, the bug
   * is upstream of Workspace.streamProcessLogs.
   */
  private async streamExec(command: string, cwd?: string): Promise<Response> {
    const ws = this.workspace;
    const proc = await ws.startProcess(command, { cwd: cwd ?? "/tmp" });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const events = await ws.streamProcessLogs(proc.id);
          for await (const event of events) {
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
            if (event.type === "exit" || event.type === "error") break;
          }
          // Pull files the process wrote so callers can read them back via
          // a follow-up endpoint. Failures here are non-fatal.
          try { await ws.pullDirtyAfter(); } catch { /* best effort */ }
        } catch (err) {
          const details = err instanceof Error ? err.message : String(err);
          controller.enqueue(encoder.encode(JSON.stringify({
            type: "error", data: details, timestamp: new Date().toISOString(), processId: proc.id,
          }) + "\n"));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type":  "application/x-ndjson",
        "cache-control": "no-store",
      },
    });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // POST /exec?session=<name>  — run a command via the named ExecAgent DO.
    // `session` defaults to "default" so a plain `curl -d ... /exec` works.
    // POST /exec(/stream)?session=<name>  — forward to the named ExecAgent DO.
    if (req.method === "POST" && (url.pathname === "/exec" || url.pathname === "/exec/stream")) {
      const session = url.searchParams.get("session") ?? "default";
      const id      = env.ExecAgent.idFromName(session);
      const stub    = env.ExecAgent.get(id);
      return stub.fetch(new Request(`https://do${url.pathname}`, {
        method:  "POST",
        headers: req.headers,
        body:    req.body,
      }));
    }

    if (req.method === "GET" && url.pathname === "/") {
      return new Response(
        "POST /exec         body={\"command\":\"...\",\"cwd\":\"/tmp\"}  (?session=<name>)\n" +
        "POST /exec/stream  body={\"command\":\"...\",\"cwd\":\"/tmp\"}  -> NDJSON stream\n",
        { headers: { "content-type": "text/plain" } },
      );
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
