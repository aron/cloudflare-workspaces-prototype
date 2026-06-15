import type { BackendHandle, WorkspaceBackend } from "@cloudflare/workspace";
import type {
  CloudflareContainerBackendOptions,
  IWorkspaceContainerAPI,
} from "@cloudflare/workspace/backends/container";
import { newWebSocketRpcSession } from "capnweb";

const DEFAULT_EGRESS_HOST = "workspace.internal";
const DEFAULT_CONTAINER_PORT = 8080;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;

export interface ContainerFetchResult {
  ok: boolean;
  status: number;
  body: string;
}

export interface CrossDOContainerHostHolder {
  getWorkspaceContainer():
    | Pick<IWorkspaceContainerAPI, "start" | "interceptOutboundHttp">
    | Promise<Pick<IWorkspaceContainerAPI, "start" | "interceptOutboundHttp">>;
  containerFetch(
    port: number,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<ContainerFetchResult>;
}

export type CrossDOContainerBackendOptions = Omit<
  CloudflareContainerBackendOptions,
  "container"
> & {
  container: () => CrossDOContainerHostHolder | Promise<CrossDOContainerHostHolder>;
};

/**
 * App-local variant of `@cloudflare/workspace`'s
 * `CloudflareContainerBackend` for the cross-DO warm-pool topology.
 *
 * The published backend assumes this works across Workers RPC:
 *
 *   host.port(8080).fetch("http://container/health")
 *
 * where `host.port()` returns `ctx.container.getTcpPort(8080)` from the
 * Sandbox DO. In current local workerd that returned Fetcher reaches the
 * Agent DO without a subrequest channel and crashes with:
 *
 *   this Fetcher doesn't yet implement getSubrequestChannel()
 *
 * Keep the upstream architecture (Agent owns Workspace + SQLite, Sandbox owns
 * ctx.container) but don't return Fetchers over RPC. `Sandbox.containerFetch()`
 * performs the TCP-port fetch inside the Sandbox DO and returns only a plain
 * serializable result.
 */
export class CrossDOContainerBackend implements WorkspaceBackend {
  // `type` mirrors the upstream CloudflareContainerBackend so logs
  // and tracing keep using the same identifier across the two
  // backend implementations. `id` is the selector the agent (and
  // the exec tool's `backend` parameter) names this entry by;
  // keeping it short (`container`) matches the convention in
  // @cloudflare/workspace's examples and is what the model writes.
  readonly type = "cloudflare-container";
  readonly id = "container";

  readonly #options: Required<
    Pick<
      CrossDOContainerBackendOptions,
      "container" | "workspace" | "egressHost" | "containerPort" | "containerEnv" | "connectTimeoutMs" | "heartbeatIntervalMs"
    >
  >;

  #pendingUpgrade?: Promise<WebSocket>;
  #resolveUpgrade?: (ws: WebSocket) => void;
  #rejectUpgrade?: (err: unknown) => void;
  #handle?: BackendHandle;

  constructor(options: CrossDOContainerBackendOptions) {
    this.#options = {
      container: options.container,
      workspace: options.workspace,
      egressHost: options.egressHost ?? DEFAULT_EGRESS_HOST,
      containerPort: options.containerPort ?? DEFAULT_CONTAINER_PORT,
      containerEnv: options.containerEnv ?? {},
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      heartbeatIntervalMs:
        options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    };
  }

  async connect(): Promise<BackendHandle> {
    if (this.#handle) return this.#handle;

    const deadline = Date.now() + this.#options.connectTimeoutMs;
    const container = await this.#options.container();
    const host = await container.getWorkspaceContainer();

    await host.start({
      PORT: String(this.#options.containerPort),
      MOUNT_POINT: "/workspace",
      ...this.#options.containerEnv,
    });
    await host.interceptOutboundHttp(
      this.#options.egressHost,
      this.#options.workspace,
    );

    this.#armUpgrade();
    await this.#waitForPort(container, deadline);
    await this.#postConnect(container, deadline);

    const ws = await this.#waitForUpgrade(deadline);
    const stub = newWebSocketRpcSession(ws) as unknown as BackendHandle["rpc"] & {
      onRpcBroken(cb: () => void): void;
      [Symbol.dispose]?(): void;
    };

    let stopHeartbeat: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      let fired = false;
      const onClose = () => {
        if (fired) return;
        fired = true;
        stopHeartbeat?.();
        resolve();
        this.#handle = undefined;
      };
      ws.addEventListener("close", onClose, { once: true });
      ws.addEventListener("error", onClose, { once: true });
      stub.onRpcBroken(onClose);
    });

    if (this.#options.heartbeatIntervalMs > 0) {
      stopHeartbeat = startHeartbeat({
        intervalMs: this.#options.heartbeatIntervalMs,
        ping: () => stub.sync.watermarks(),
        onFailure: () => {
          try {
            ws.close();
          } catch {
            // already closed
          }
        },
      });
    }

    const handle: BackendHandle = {
      rpc: stub,
      closed,
      close: async () => {
        stopHeartbeat?.();
        try {
          stub[Symbol.dispose]?.();
        } catch {
          // best effort
        }
        try {
          ws.close();
        } catch {
          // best effort
        }
        this.#handle = undefined;
      },
    };
    this.#handle = handle;
    return handle;
  }

  async handleFetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname !== "/ws") {
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
      server.close(1011, "no pending connect");
      return new Response("no pending connect", { status: 409 });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  #armUpgrade(): void {
    this.#pendingUpgrade = new Promise((resolve, reject) => {
      this.#resolveUpgrade = resolve;
      this.#rejectUpgrade = reject;
    });
    this.#pendingUpgrade.catch(() => {});
  }

  #clearUpgrade(): void {
    this.#pendingUpgrade = undefined;
    this.#resolveUpgrade = undefined;
    this.#rejectUpgrade = undefined;
  }

  async #waitForPort(
    container: CrossDOContainerHostHolder,
    deadline: number,
  ): Promise<void> {
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const res = await container.containerFetch(
          this.#options.containerPort,
          "http://container/health",
          { method: "HEAD" },
        );
        if (res.ok) return;
        lastError = new Error(`HEAD /health returned ${res.status}: ${res.body}`);
      } catch (error) {
        lastError = error;
      }
      await sleep(250);
    }
    this.#rejectUpgrade?.(new Error("port did not open"));
    this.#clearUpgrade();
    throw new Error(
      `CloudflareContainerBackend: container port ${this.#options.containerPort} did not open: ${describeError(lastError)}`,
    );
  }

  async #postConnect(
    container: CrossDOContainerHostHolder,
    deadline: number,
  ): Promise<void> {
    const remaining = Math.max(0, deadline - Date.now());
    let res: ContainerFetchResult;
    try {
      res = await container.containerFetch(
        this.#options.containerPort,
        "http://container/connect",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: `http://${this.#options.egressHost}`,
            healthTimeoutMs: remaining,
          }),
        },
      );
    } catch (error) {
      this.#rejectUpgrade?.(error);
      this.#clearUpgrade();
      throw new Error(
        `CloudflareContainerBackend: POST /connect failed: ${describeError(error)}`,
      );
    }

    if (!res.ok) {
      this.#rejectUpgrade?.(new Error(`/connect ${res.status}`));
      this.#clearUpgrade();
      throw new Error(
        `CloudflareContainerBackend: POST /connect returned ${res.status}: ${res.body}`,
      );
    }
  }

  async #waitForUpgrade(deadline: number): Promise<WebSocket> {
    const upgrade = this.#pendingUpgrade;
    if (!upgrade) {
      throw new Error("CloudflareContainerBackend: upgrade promise missing");
    }

    const remaining = Math.max(0, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        upgrade,
        new Promise<WebSocket>((_, reject) => {
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
    } finally {
      if (timer) clearTimeout(timer);
      this.#clearUpgrade();
    }
  }
}

function startHeartbeat(options: {
  intervalMs: number;
  ping: () => Promise<unknown>;
  onFailure(error: Error): void;
}): () => void {
  const { intervalMs, ping, onFailure } = options;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    ping().catch((error) => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      onFailure(error instanceof Error ? error : new Error(String(error)));
    });
  }, intervalMs);
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
