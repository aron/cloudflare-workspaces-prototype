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

import { CloudflareContainerBackend, Workspace } from "@cloudflare/workspace";

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

  // ---- Worker-facing RPC methods --------------------------------

  async do_writeFile(path: string, body: ArrayBuffer): Promise<void> {
    await this.#workspace.ready();
    await this.#workspace.fs.writeFile(path, new Uint8Array(body));
  }

  async do_readFile(path: string): Promise<ArrayBuffer> {
    await this.#workspace.ready();
    const bytes = await this.#workspace.fs.readFile(path);
    // Copy into a fresh ArrayBuffer so the RPC layer can
    // transfer it cleanly across the isolate boundary.
    const out = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(out).set(bytes);
    return out;
  }

  async do_execCollect(
    command: string,
    options: { cwd?: string; encoding?: "utf8" } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    await this.#workspace.ready();
    const handle =
      options.encoding === "utf8"
        ? await this.#workspace.shell.exec(command, { encoding: "utf8", cwd: options.cwd })
        : await this.#workspace.shell.exec(command, { cwd: options.cwd });
    const result = await handle.result();
    const stdout = typeof result.stdout === "string" ? result.stdout : decodeBytes(result.stdout);
    const stderr = typeof result.stderr === "string" ? result.stderr : decodeBytes(result.stderr);
    return { exitCode: result.exitCode, stdout, stderr };
  }

  // Forward raw HTTP into wsd. Used by the Worker's legacy
  // passthrough path (`/c/<name>/<wsd-path>`) for debugging —
  // e.g. `curl /c/demo/health` hits wsd's /health.
  //
  // Drives Workspace.ready() first so the backend has started
  // the container and confirmed :8080 is open.
  async do_proxy(req: Request): Promise<Response> {
    await this.#workspace.ready();
    return this.ctx.container!.getTcpPort(8080).fetch(req);
  }

  // ---- WebSocket: wsd's outbound /ws upgrade ---------------------

  override async fetch(request: Request): Promise<Response> {
    return this.#backend.handleFetch(request);
  }
}

function decodeBytes(value: unknown): string {
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (Array.isArray(value)) {
    const total = value.reduce((acc, part) => acc + (part as Uint8Array).byteLength, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const part of value as Uint8Array[]) {
      buf.set(part, off);
      off += part.byteLength;
    }
    return new TextDecoder().decode(buf);
  }
  return "";
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

    // Legacy passthrough: /c/<name>/<rest> proxies into wsd's HTTP.
    const passMatch = url.pathname.match(/^\/c\/([^/]+)(\/.*)?$/);
    if (passMatch) {
      const [, name, rest] = passMatch;
      const stub = env.WSD.get(env.WSD.idFromName(name));
      const forwarded = new URL(request.url);
      forwarded.pathname = rest ?? "/";
      return stub.do_proxy(new Request(forwarded, request));
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        [
          "wsd-container example",
          "",
          "  PUT  /c/<name>/file/<path>     write file",
          "  GET  /c/<name>/file/<path>     read file",
          "  POST /c/<name>/exec            run a command (SSE result frame)",
          "  GET  /c/<name>/<wsd-path>      proxy raw HTTP to wsd",
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

  if (request.method === "PUT") {
    const body = await request.arrayBuffer();
    try {
      await stub.do_writeFile(path, body);
      return new Response(null, { status: 204 });
    } catch (error) {
      return errorJson(error, 500);
    }
  }

  if (request.method === "GET") {
    try {
      const body = await stub.do_readFile(path);
      return new Response(body, {
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
  try {
    const result = await stub.do_execCollect(command, {
      cwd: body.cwd,
      encoding: body.encoding,
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
