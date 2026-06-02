// CloudflareContainerBackend — backs Workspace with a wsd instance
// running inside a Cloudflare Container that the calling Durable
// Object owns.
//
// The full lifecycle plumbing (start the container, register the
// outbound egress interceptor, drive wsd's POST /connect, accept
// the inbound /ws upgrade, attach the capnweb session) lives in
// the backend. The DO becomes a thin host:
//
//   class WsdContainer extends DurableObject {
//     #backend = new CloudflareContainerBackend({
//       container: () => this.ctx.container!,
//       egress: this.ctx.exports.WsdEgress({
//         props: { id: this.ctx.id.toString() },
//       }),
//     });
//     #workspace = new Workspace({ backends: [this.#backend] });
//
//     override async fetch(req: Request): Promise<Response> {
//       const url = new URL(req.url);
//       if (url.pathname === "/ws") return this.#backend.handleFetch(req);
//       return new Response("not found", { status: 404 });
//     }
//   }
//
// The DO's only contract with the backend is:
//   1. Construct it once on DO entry and keep the reference alive.
//   2. Forward /ws upgrades to backend.handleFetch().
//   3. Hand the backend to a Workspace instance.
//
// The egress fetcher is built by the DO (it needs ctx.exports +
// props), not the backend, because ctx.exports is per-isolate. The
// backend takes whatever Fetcher the DO hands it.
//
// Failure model: connect() does the bootstrap sequence once and
// throws on any failure. The Workspace's ready() retries by
// re-entering connect() on the next call. On a mid-session drop the
// backend resolves `BackendHandle.closed`, which the Workspace
// listens for and uses to drop its cached handle so the next call
// rebuilds against a fresh session. Backoff and retry policy live
// in the Workspace, not the backend.

import type { WorkspaceRPC } from "@cloudflare/workspace-rpc";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";

import type { BackendHandle, WorkspaceBackend } from "../backend.js";

export interface CloudflareContainerBackendOptions {
  // Resolver for the container the backend should drive. Called
  // each connect() so the DO can return its current ctx.container.
  // Same-DO only in v1 — the returned Container can't cross
  // isolates, so cross-DO containers need a different backend.
  container: () => Container;

  // Fetcher reachable from the container. The backend wires it
  // into ctx.container.interceptOutboundHttp(egressHost, ...). The
  // fetcher must forward `/ws` upgrade requests to the DO that
  // owns this backend so they arrive at handleFetch(). Typical
  // construction inside a DO:
  //
  //   ctx.exports.WsdEgress({
  //     props: { id: ctx.id.toString() },
  //   })
  egress: Fetcher;

  // Hostname wsd will dial back. Defaults to "workspace.internal".
  // Override for tests or to avoid collisions with other backends
  // in the same container.
  egressHost?: string;

  // TCP port wsd listens on inside the container. Default 8080,
  // matching the Dockerfile shipped with examples/wsd-container.
  containerPort?: number;

  // Environment variables passed to ctx.container.start(). Merged
  // onto sane defaults (PORT, MOUNT_POINT).
  containerEnv?: Record<string, string>;

  // Total time the backend waits for: container port to open,
  // /connect POST to return, /ws upgrade to arrive. Default 30s.
  connectTimeoutMs?: number;
}

const DEFAULT_EGRESS_HOST = "workspace.internal";
const DEFAULT_CONTAINER_PORT = 8080;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export class CloudflareContainerBackend implements WorkspaceBackend {
  readonly id = "cloudflare-container";

  readonly #options: Required<
    Omit<CloudflareContainerBackendOptions, "container" | "egress" | "containerEnv">
  > &
    Pick<CloudflareContainerBackendOptions, "container" | "egress" | "containerEnv">;

  // State for the in-flight /ws upgrade. handleFetch() resolves
  // #pendingUpgrade; connect() awaits it.
  #pendingUpgrade: Promise<WebSocket> | undefined;
  #resolveUpgrade: ((ws: WebSocket) => void) | undefined;
  #rejectUpgrade: ((err: unknown) => void) | undefined;

  // Cached after the first successful connect(). Cleared on close().
  #handle: BackendHandle | undefined;

  // Container.monitor() promise — kicked off the first time we
  // start the container. Drops the cached handle when the
  // container exits.
  #monitoring = false;

  constructor(options: CloudflareContainerBackendOptions) {
    this.#options = {
      container: options.container,
      egress: options.egress,
      egressHost: options.egressHost ?? DEFAULT_EGRESS_HOST,
      containerPort: options.containerPort ?? DEFAULT_CONTAINER_PORT,
      containerEnv: options.containerEnv,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    };
  }

  async connect(): Promise<BackendHandle> {
    if (this.#handle) return this.#handle;

    const deadline = Date.now() + this.#options.connectTimeoutMs;
    const container = this.#options.container();

    await this.#ensureContainerStarted(container);
    await this.#registerEgress(container);

    // Arm the upgrade promise before posting /connect — wsd
    // dials back as soon as /health on the egress answers, so
    // the upgrade can arrive before the POST resolves.
    this.#armUpgrade();

    await this.#waitForPort(container, deadline);
    await this.#postConnect(container, deadline);
    const ws = await this.#waitForUpgrade(deadline);

    const stub = newWebSocketRpcSession(
      ws as unknown as globalThis.WebSocket,
    ) as RpcStub<WorkspaceRPC>;

    // `closed` resolves on the first 'close' event from the underlying
    // WebSocket. The Workspace listens for it and drops its cached
    // handle so the next ready() call rebuilds against a fresh
    // session. Without this, a mid-session drop strands the dead
    // handle and every subsequent RPC throws.
    const closed = new Promise<void>((resolve) => {
      const onClose = () => {
        resolve();
        this.#handle = undefined;
      };
      ws.addEventListener("close", onClose, { once: true });
      // Some runtimes fire 'error' without a follow-up 'close' on
      // abrupt teardown; treat error as close too.
      ws.addEventListener("error", onClose, { once: true });
    });

    const handle: BackendHandle = {
      rpc: stub as unknown as WorkspaceRPC,
      closed,
      close: async () => {
        try {
          ws.close();
        } catch {
          // already closed; idempotent
        }
        this.#handle = undefined;
      },
    };
    this.#handle = handle;
    return handle;
  }

  // Routes a /ws upgrade Request into the in-flight connect().
  // Returns the 101 response that the egress handler must return
  // (via its own stub.fetch(req) chain).
  async handleFetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/ws") {
      return new Response("not found", { status: 404 });
    }
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();

    if (this.#resolveUpgrade) {
      this.#resolveUpgrade(server);
    } else {
      // No connect() in flight — close the socket immediately.
      // The remote will redial on its next attempt; we don't
      // hold orphaned sockets that nothing will reap.
      server.close(1011, "no pending connect");
      return new Response("no pending connect", { status: 409 });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // --- internals --------------------------------------------------

  #armUpgrade(): void {
    this.#pendingUpgrade = new Promise<WebSocket>((resolve, reject) => {
      this.#resolveUpgrade = resolve;
      this.#rejectUpgrade = reject;
    });
    // Swallow unhandled-rejection noise if connect() throws
    // before anyone awaits the promise.
    this.#pendingUpgrade.catch(() => {});
  }

  #clearUpgrade(): void {
    this.#pendingUpgrade = undefined;
    this.#resolveUpgrade = undefined;
    this.#rejectUpgrade = undefined;
  }

  async #ensureContainerStarted(container: Container): Promise<void> {
    if (container.running) return;
    container.start({
      enableInternet: true,
      env: {
        PORT: String(this.#options.containerPort),
        MOUNT_POINT: "/workspace",
        ...this.#options.containerEnv,
      },
    });

    if (!this.#monitoring) {
      this.#monitoring = true;
      // Don't await — the monitor outlives connect() and
      // drops the cached handle when the container exits.
      void container
        .monitor()
        .catch(() => {})
        .finally(() => {
          this.#monitoring = false;
          this.#handle = undefined;
        });
    }
  }

  async #registerEgress(container: Container): Promise<void> {
    await container.interceptOutboundHttp(this.#options.egressHost, this.#options.egress);
  }

  async #waitForPort(container: Container, deadline: number): Promise<void> {
    const fetcher = container.getTcpPort(this.#options.containerPort);
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const res = await fetcher.fetch("http://container/health", { method: "HEAD" });
        void res.body?.cancel();
        return;
      } catch (error) {
        lastError = error;
        await sleep(250);
      }
    }
    this.#rejectUpgrade?.(new Error("port did not open"));
    this.#clearUpgrade();
    throw new Error(
      `CloudflareContainerBackend: container port ${this.#options.containerPort} did not open: ${describeError(lastError)}`,
    );
  }

  async #postConnect(container: Container, deadline: number): Promise<void> {
    const remaining = Math.max(0, deadline - Date.now());
    const fetcher = container.getTcpPort(this.#options.containerPort);
    let res: Response;
    try {
      res = await fetcher.fetch(
        new Request("http://container/connect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: `http://${this.#options.egressHost}`,
            healthTimeoutMs: remaining,
          }),
        }),
      );
    } catch (error) {
      this.#rejectUpgrade?.(error);
      this.#clearUpgrade();
      throw new Error(`CloudflareContainerBackend: POST /connect failed: ${describeError(error)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      this.#rejectUpgrade?.(new Error(`/connect ${res.status}`));
      this.#clearUpgrade();
      throw new Error(`CloudflareContainerBackend: POST /connect returned ${res.status}: ${body}`);
    }
  }

  async #waitForUpgrade(deadline: number): Promise<WebSocket> {
    const upgrade = this.#pendingUpgrade;
    if (!upgrade) throw new Error("CloudflareContainerBackend: upgrade promise missing");

    const remaining = Math.max(0, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ws = await Promise.race([
        upgrade,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `CloudflareContainerBackend: /ws upgrade did not arrive within ${this.#options.connectTimeoutMs}ms`,
                ),
              ),
            remaining,
          );
        }),
      ]);
      return ws;
    } finally {
      if (timer) clearTimeout(timer);
      this.#clearUpgrade();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
