// Example Worker + container-enabled Durable Object running wsd,
// exposing a minimal write / read / exec HTTP surface modelled on
// the cloudflare/sandbox-sdk bridge.
//
// Uses `ctx.container` directly (no @cloudflare/containers helper)
// so the lifecycle plumbing is explicit:
//
//   - ctx.container.start({...}) on first fetch
//   - ctx.container.monitor() to observe exits and tear the
//     workspace down
//   - ctx.container.getTcpPort(8080).fetch(...) to talk to wsd
//   - ctx.container.interceptOutboundHttp("workspace.internal", ...)
//     to give wsd a callback URL for the capnweb upgrade
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

import type { BackendHandle, WorkspaceBackend } from "@cloudflare/workspace";
import { Workspace } from "@cloudflare/workspace";
import type { WorkspaceRPC } from "@cloudflare/workspace-rpc";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";

export interface Env {
  WSD: DurableObjectNamespace<WsdContainer>;
}

// Stable virtual hostname the container uses to reach back into the
// Worker. ctx.container.interceptOutboundHttp routes anything wsd
// sends to this host into our WsdEgress WorkerEntrypoint.
const EGRESS_HOST = "workspace.internal";

// ---------------------------------------------------------------
// StubBackend: wraps an already-built capnweb WorkspaceRPC stub.
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
// Egress entrypoint: registered with the container as the outbound
// handler for http://workspace.internal. wsd reaches the DO
// through this. Owned by ctx.exports; the DO passes its own id in
// via props so the entrypoint can route /ws upgrades back to the
// right instance.
// ---------------------------------------------------------------
export class WsdEgress extends WorkerEntrypoint<Env, { doId: string }> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/ws") {
      // Forward the upgrade Request to the DO that owns this
      // container. The DO performs the upgrade in its own
      // context; the server-side socket lives in the DO
      // isolate where the capnweb session runs.
      const ns = this.env.WSD;
      const stub = ns.get(ns.idFromString(this.ctx.props.doId));
      return stub.fetch(request);
    }

    return new Response("not found", { status: 404 });
  }
}

// ---------------------------------------------------------------
// Durable Object: owns the container and the wsd ↔ DO capnweb
// session. The DO is container-enabled (wrangler.jsonc has a
// `container` block bound to this class), so this.ctx.container is
// defined.
// ---------------------------------------------------------------
export class WsdContainer extends DurableObject<Env> {
  #workspace: Workspace | undefined;
  #workspaceReady: Promise<Workspace> | undefined;
  #resolveWorkspace: ((ws: Workspace) => void) | undefined;
  #rejectWorkspace: ((err: unknown) => void) | undefined;
  #stub: RpcStub<WorkspaceRPC> | undefined;
  #ws: WebSocket | undefined;
  #started = false;

  // Boot the container (idempotent) and register the egress
  // interceptor. Called on every entry point that might need
  // wsd; the cheap path is the early-return when already
  // running.
  async #ensureContainer(): Promise<void> {
    const container = this.ctx.container;
    if (!container) {
      throw new Error("DO is not container-enabled (check wrangler.jsonc)");
    }
    if (container.running && this.#started) return;

    if (!container.running) {
      container.start({
        enableInternet: true,
        env: {
          PORT: "8080",
          MOUNT_POINT: "/workspace",
          DISABLE_FUSE: "1",
        },
      });
    }

    // Hand wsd a callback URL. The egress entrypoint receives
    // the DO id via props so it can route /ws back to us.
    const egress = (
      this.ctx as unknown as {
        exports: { WsdEgress: (init: { props: { doId: string } }) => Fetcher };
      }
    ).exports.WsdEgress({
      props: { doId: this.ctx.id.toString() },
    });
    await container.interceptOutboundHttp(EGRESS_HOST, egress);

    // Observe container exits — drop the workspace so the next
    // caller re-boots.
    this.ctx.waitUntil(
      (async () => {
        try {
          await container.monitor();
        } catch (error) {
          console.error("container.monitor() threw:", error);
        }
        console.log("container exited");
        this.#teardownWorkspace();
        this.#started = false;
      })(),
    );

    this.#started = true;
    this.#prepareWorkspacePromise();
    this.ctx.waitUntil(this.#bootstrapConnect());
  }

  async ready(timeoutMs = 30_000): Promise<void> {
    await this.#ensureContainer();
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

  // ---- Worker-facing RPC methods --------------------------------

  async do_writeFile(path: string, body: ArrayBuffer): Promise<void> {
    await this.ready();
    await this.#workspace!.fs.writeFile(path, new Uint8Array(body));
  }

  async do_readFile(path: string): Promise<ArrayBuffer> {
    await this.ready();
    const bytes = await this.#workspace!.fs.readFile(path);
    const out = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(out).set(bytes);
    return out;
  }

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

  // Forward raw HTTP into wsd. Used by the Worker's legacy
  // passthrough path (`/c/<name>/<path>`) for debugging — e.g.
  // `curl /c/demo/health`.
  async do_proxy(req: Request): Promise<Response> {
    await this.#ensureContainer();
    const container = this.ctx.container!;
    // Wait for :8080 to answer. wsd boots in well under 10s.
    await waitForPort(container, 8080, 20_000);
    return container.getTcpPort(8080).fetch(req);
  }

  // ---- WebSocket: receives wsd's outbound /ws upgrade ----------

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/ws" || request.headers.get("upgrade") !== "websocket") {
      return new Response("not found", { status: 404 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();

    this.#teardownWorkspace();
    this.#prepareWorkspacePromise();

    this.#ws = server;
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
      await waitForPort(this.ctx.container!, 8080, 20_000);
      const res = await this.ctx.container!.getTcpPort(8080).fetch(
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

// Poll a container TCP port until it answers or the deadline
// passes. Replaces the @cloudflare/containers helper's `defaultPort`
// readiness wait.
async function waitForPort(
  container: NonNullable<DurableObjectState["container"]>,
  port: number,
  timeoutMs: number,
): Promise<void> {
  const fetcher = container.getTcpPort(port);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetcher.fetch("http://container/health", { method: "HEAD" });
      // Any response (even 404) means the port is open.
      void res.body?.cancel();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`port ${port} did not become reachable within ${timeoutMs}ms: ${lastError}`);
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
// Worker HTTP surface (unchanged from before)
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
