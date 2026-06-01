// Example Worker + container-enabled Durable Object running wsd.
//
// The DO is a thin shell over CloudflareContainerBackend: it picks
// the container (this.ctx.container) and the egress fetcher
// (ctx.exports.WsdEgress with the DO id in props), forwards
// /ws upgrades to backend.handleFetch(), and otherwise just calls
// into a single Workspace instance.
//
// Wire shape:
//
//   client ─► Worker /c/<name>/{file,exec}
//              │  (DO RPC)
//              ▼
//        WsdContainer DO ──► Container ──► wsd (:8080)
//              ▲                                │
//              │  ws://workspace.internal/ws    │
//              └─── capnweb session ◄───────────┘

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

import { CloudflareContainerBackend, Workspace, type WorkspaceStub } from "@cloudflare/workspace";

export interface Env {
  WSD: DurableObjectNamespace<WsdContainer>;
}

// ---------------------------------------------------------------
// Egress entrypoint: registered with the container as the outbound
// handler for http://workspace.internal. wsd reaches the DO
// through this. ctx.props carries the owning DO's id so /ws
// upgrades route to the right instance.
// ---------------------------------------------------------------
export class WsdEgress extends WorkerEntrypoint<Env, { doId: string }> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const ns = this.env.WSD;
      const stub = ns.get(ns.idFromString(this.ctx.props.doId));
      return stub.fetch(request);
    }
    // The backend's connect() POSTs to wsd's /connect, which
    // then polls /health on the egress host before dialling
    // the WebSocket. Answer here so wsd knows the egress is
    // reachable.
    if (url.pathname === "/health") {
      return new Response("ok\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  }
}

// ---------------------------------------------------------------
// Durable Object: owns one Workspace backed by one container.
// ---------------------------------------------------------------
export class WsdContainer extends DurableObject<Env> {
  readonly #backend: CloudflareContainerBackend;
  readonly #workspace: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (!ctx.container) {
      throw new Error("DO is not container-enabled (check wrangler.jsonc)");
    }
    this.#backend = new CloudflareContainerBackend({
      container: () => ctx.container!,
      // ctx.exports is per-isolate, so the DO has to build
      // the egress fetcher itself and hand it to the backend.
      egress: (
        ctx as unknown as {
          exports: { WsdEgress: (init: { props: { doId: string } }) => Fetcher };
        }
      ).exports.WsdEgress({
        props: { doId: ctx.id.toString() },
      }),
    });
    this.#workspace = new Workspace({ backends: [this.#backend] });
  }

  // ---- Worker-facing RPC surface --------------------------------

  // Returns an RpcTarget that the caller (Worker or another DO)
  // uses to reach the Workspace. Methods on the returned stub
  // round-trip back into this DO over Workers RPC; the actual
  // SyncRPC + ShellRPC traffic stays on the wsd ↔ DO capnweb wire.
  async getWorkspace(): Promise<WorkspaceStub> {
    await this.#workspace.ready();
    return this.#workspace.stub();
  }

  // ---- WebSocket: wsd's outbound /ws upgrade ---------------------

  override async fetch(request: Request): Promise<Response> {
    return this.#backend.handleFetch(request);
  }
}

// ---------------------------------------------------------------
// Worker HTTP surface (unchanged)
// ---------------------------------------------------------------

interface ExecRequest {
  command?: string;
  argv?: string[];
  cwd?: string;
  encoding?: "utf8";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const fileMatch = url.pathname.match(/^\/c\/([^/]+)\/file\/(.+)$/);
    if (fileMatch) return handleFile(request, env, fileMatch[1], `/${fileMatch[2]}`);

    const execMatch = url.pathname.match(/^\/c\/([^/]+)\/exec\/?$/);
    if (execMatch) return handleExec(request, env, execMatch[1]);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        [
          "wsd-container example",
          "",
          "  PUT  /c/<name>/file/<path>     write file",
          "  GET  /c/<name>/file/<path>     read file",
          "  POST /c/<name>/exec            run a command (SSE result frame)",

          "",
        ].join("\n"),
        { headers: { "content-type": "text/plain" } },
      );
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleFile(
  request: Request,
  env: Env,
  name: string,
  path: string,
): Promise<Response> {
  const stub = env.WSD.get(env.WSD.idFromName(name));
  const ws = await stub.getWorkspace();

  if (request.method === "PUT") {
    const body = await request.arrayBuffer();
    try {
      await ws.fs.writeFile(path, body);
      return new Response(null, { status: 204 });
    } catch (error) {
      return errorJson(error, 500);
    }
  }

  if (request.method === "GET") {
    try {
      const bytes = await ws.fs.readFile(path);
      // Copy into a plain ArrayBuffer so the Response body init
      // type accepts it (the RPC-returned Uint8Array carries a
      // Disposable brand that confuses BodyInit's union).
      const buf = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buf).set(bytes);
      return new Response(buf, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") return errorJson(error, 404);
      return errorJson(error, 500);
    }
  }

  return new Response("method not allowed", { status: 405, headers: { allow: "GET, PUT" } });
}

async function handleExec(request: Request, env: Env, name: string): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
  }
  let body: ExecRequest;
  try {
    body = (await request.json()) as ExecRequest;
  } catch {
    return errorJson(new Error("invalid JSON body"), 400);
  }

  let command: string;
  if (typeof body.command === "string" && body.command.length > 0) {
    command = body.command;
  } else if (Array.isArray(body.argv) && body.argv.length > 0) {
    command = body.argv.map(shellQuote).join(" ");
  } else {
    return errorJson(new Error("must provide command or argv"), 400);
  }

  const stub = env.WSD.get(env.WSD.idFromName(name));
  const ws = await stub.getWorkspace();
  try {
    const result = await ws.shell.exec(command, {
      cwd: body.cwd,
      encoding: "utf8",
    });
    const payload = `event: result\ndata: ${JSON.stringify(result)}\n\n`;
    return new Response(payload, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  } catch (error) {
    return errorJson(error, 500);
  }
}

function errorJson(error: unknown, status: number): Response {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code;
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-+=:,.\/@%]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
