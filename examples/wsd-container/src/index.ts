// Example Worker + Durable Object that owns a Cloudflare Container
// running wsd, and exposes a minimal HTTP surface (write / read /
// exec) modelled after the cloudflare/sandbox-sdk bridge.
//
// Wire shape:
//
//   client ─► Worker /c/<name>/{file,exec}
//                │  (DO RPC method calls)
//                ▼
//          DO (WsdContainer) ──► Cloudflare Container ──► wsd
//                ▲                                            │
//                │      ws://workspace.internal/ws            │
//                └────────── capnweb session ◄────────────────┘
//
// The DO holds the server side of the wsd→DO WebSocket and runs a
// capnweb client session over it. WorkspaceRPC.sync drives the
// file IO; WorkspaceRPC.shell drives exec.

import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/workspace";
import { Workspace } from "@cloudflare/workspace";
import type { WorkspaceRPC } from "@cloudflare/workspace-rpc";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";

export { ContainerProxy };

export interface Env {
  WSD: DurableObjectNamespace<WsdContainer>;
}

// Stable virtual hostname the container uses to reach back into the
// Worker via outboundByHost interception.
const EGRESS_HOST = "workspace.internal";

// ---------------------------------------------------------------
// Backend: wraps an already-connected WorkspaceRPC stub.
//
// `TestBackend` from @cloudflare/workspace dials a URL to build the
// stub. Here the stub is built from the WebSocket the DO already
// holds, so we just hand it through.
// ---------------------------------------------------------------
class StubBackend implements WorkspaceBackend {
  readonly id = "wsd-do-ws";
  readonly #stub: WorkspaceRPC;
  readonly #close: () => Promise<void>;

  constructor(stub: WorkspaceRPC, close: () => Promise<void>) {
    this.#stub = stub;
    this.#close = close;
  }

  connect(): Promise<BackendHandle> {
    return Promise.resolve({ rpc: this.#stub, close: this.#close });
  }
}

// ---------------------------------------------------------------
// Durable Object
// ---------------------------------------------------------------
export class WsdContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";

  #workspace: Workspace | undefined;
  #workspaceReady: Promise<Workspace> | undefined;
  #resolveWorkspace: ((ws: Workspace) => void) | undefined;
  #rejectWorkspace: ((err: unknown) => void) | undefined;
  #stub: RpcStub<WorkspaceRPC> | undefined;
  #ws: WebSocket | undefined;

  override onStart(): void {
    console.log("wsd container started");
    this.#prepareWorkspacePromise();
    this.ctx.waitUntil(this.#bootstrapConnect());
  }

  override onStop(): void {
    console.log("wsd container stopped");
    this.#teardownWorkspace();
  }

  override onError(error: unknown): void {
    console.error("wsd container error:", error);
    this.#rejectWorkspace?.(error);
  }

  // Wait for wsd to dial in and finish the capnweb handshake.
  // The Worker calls this before forwarding any RPC.
  async ready(timeoutMs = 30_000): Promise<void> {
    if (this.#workspace) return;
    if (!this.#workspaceReady) this.#prepareWorkspacePromise();
    const ws = await Promise.race([
      this.#workspaceReady,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`workspace not ready within ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    this.#workspace = ws as Workspace;
  }

  // ---- DO RPC methods (called from the Worker fetch handler) ----

  async do_writeFile(path: string, body: ArrayBuffer): Promise<void> {
    await this.ready();
    await this.#workspace!.fs.writeFile(path, new Uint8Array(body));
  }

  async do_readFile(path: string): Promise<ArrayBuffer> {
    await this.ready();
    const bytes = await this.#workspace!.fs.readFile(path);
    // Copy into a fresh ArrayBuffer so the RPC layer can
    // transfer it cleanly across the isolate boundary.
    const out = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(out).set(bytes);
    return out;
  }

  // Run-and-collect exec. SSE streaming lives in the Worker's
  // fetch handler; that one calls into a separate streaming
  // method below.
  async do_execCollect(
    command: string,
    options: { cwd?: string; encoding?: "utf8" } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    await this.ready();
    const handle =
      options.encoding === "utf8"
        ? await this.#workspace!.shell.exec(command, { encoding: "utf8", cwd: options.cwd })
        : await this.#workspace!.shell.exec(command, { cwd: options.cwd });
    const result = await handle.result();
    const stdout = typeof result.stdout === "string" ? result.stdout : decodeBytes(result.stdout);
    const stderr = typeof result.stderr === "string" ? result.stderr : decodeBytes(result.stderr);
    return { exitCode: result.exitCode, stdout, stderr };
  }

  // ---- WebSocket handling: wsd ↔ DO capnweb carrier ----

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/ws" || request.headers.get("upgrade") !== "websocket") {
      return super.fetch(request);
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();

    // Tear down any previous session if wsd reconnects.
    this.#teardownWorkspace();
    this.#prepareWorkspacePromise();

    this.#ws = server;
    // Build a capnweb client stub over the WebSocket. wsd's
    // /connect handler calls acceptWebSocketSession(ws, rpc)
    // which exports a WorkspaceRPC on its end; here we don't
    // expose anything (no localMain), we just consume.
    const stub = newWebSocketRpcSession<WorkspaceRPC>(server as unknown as WebSocket);
    this.#stub = stub;

    const backend = new StubBackend(stub as unknown as WorkspaceRPC, async () => {
      try {
        server.close();
      } catch {}
    });
    const workspace = new Workspace({ backends: [backend] });
    await workspace.ready();
    this.#resolveWorkspace?.(workspace);

    server.addEventListener("close", () => {
      console.log("DO: wsd closed the WebSocket");
      this.#teardownWorkspace();
    });
    server.addEventListener("error", (event) => {
      console.error("DO: WebSocket error", event);
    });

    console.log("DO: capnweb session attached over wsd WebSocket");
    return new Response(null, { status: 101, webSocket: client });
  }

  #prepareWorkspacePromise(): void {
    this.#workspaceReady = new Promise<Workspace>((resolve, reject) => {
      this.#resolveWorkspace = resolve;
      this.#rejectWorkspace = reject;
    });
    // Swallow unhandled-rejection noise if no one ever awaits.
    this.#workspaceReady.catch(() => {});
  }

  #teardownWorkspace(): void {
    this.#workspace = undefined;
    this.#stub = undefined;
    this.#ws = undefined;
    this.#rejectWorkspace?.(new Error("WebSocket closed"));
    this.#workspaceReady = undefined;
    this.#resolveWorkspace = undefined;
    this.#rejectWorkspace = undefined;
  }

  async #bootstrapConnect(): Promise<void> {
    try {
      const res = await this.containerFetch(
        new Request("http://container/connect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: `http://${EGRESS_HOST}` }),
        }),
      );
      if (!res.ok) {
        console.error(`/connect failed: ${res.status} ${await res.text()}`);
        return;
      }
      console.log(`/connect ok: ${await res.text()}`);
    } catch (error) {
      console.error("/connect threw:", error);
    }
  }
}

function decodeBytes(value: unknown): string {
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (Array.isArray(value)) {
    // joinParts<undefined> returns Uint8Array[] when encoding is
    // undefined; concat then decode.
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
// Egress proxy: container → Worker over workspace.internal
// ---------------------------------------------------------------
WsdContainer.outboundByHost = {
  [EGRESS_HOST]: async (request, env, ctx) => {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/ws") {
      const ns = (env as Env).WSD;
      const stub = ns.get(ns.idFromString(ctx.containerId));
      return stub.fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
};

// ---------------------------------------------------------------
// Worker HTTP surface: minimal write / read / exec
//
// Modelled on cloudflare/sandbox-sdk's bridge:
//   PUT  /c/<name>/file/<path...>   raw body → wsd writeFile
//   GET  /c/<name>/file/<path...>   octet-stream of file bytes
//   POST /c/<name>/exec             { command | argv, cwd?, encoding? }
//                                   → SSE stream of stdout/stderr/exit
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

    // Legacy passthrough: /c/<name>/<rest> proxies into the
    // container's HTTP server (useful for /health pokes).
    const passMatch = url.pathname.match(/^\/c\/([^/]+)(\/.*)?$/);
    if (passMatch) {
      const [, name, rest] = passMatch;
      const container = getContainer(env.WSD, name);
      const forwarded = new URL(request.url);
      forwarded.pathname = rest ?? "/";
      return container.fetch(new Request(forwarded, request));
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        [
          "wsd-container example",
          "",
          "  PUT  /c/<name>/file/<path>     write file",
          "  GET  /c/<name>/file/<path>     read file",
          "  POST /c/<name>/exec            run a command (SSE stream)",
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
  const ns = env.WSD;
  const stub = ns.get(ns.idFromName(name));

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

  return new Response("method not allowed", {
    status: 405,
    headers: { allow: "GET, PUT" },
  });
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

  const ns = env.WSD;
  const stub = ns.get(ns.idFromName(name));

  // Run-and-collect: drain the exec, send one SSE result frame,
  // close. Streaming the live event stream over SSE would need
  // the DO to expose an async-iterable RPC method; v1 keeps the
  // surface flat. The agent loop can poll instead.
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
