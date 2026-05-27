/**
 * Long-lived capnweb RPC connection to the workspace-server running in the
 * sandbox container.
 *
 * Mirrors the pattern used by `@cloudflare/sandbox`'s
 * `ContainerControlConnection`: the RPC stub is created eagerly on top of a
 * deferred transport, so callers can issue RPC calls before the WebSocket
 * upgrade has completed — queued sends flush automatically once the upgrade
 * resolves.
 *
 * On WebSocket close/error the connection self-destructs (sync, from the
 * event handler) and the next caller transparently re-builds it against the
 * still-running container-side `workspace-server`. This is what makes the
 * connection survive DO restarts in practice: the Workspace instance is
 * reconstructed when the DO wakes, the container keeps the workspace-server
 * process alive across the gap, and the first new RPC call rebuilds the
 * WebSocket against it.
 */

import { RpcSession, type RpcStub, type RpcTransport } from "capnweb";
import { switchPort } from "@cloudflare/containers";
import type { Sandbox } from "@cloudflare/sandbox";
import type { ContainerRpc } from "./shared/index.js";

/** Stub shape that exposes the container fetch surface we depend on. */
export interface ContainerFetchStub {
  fetch(request: Request): Promise<Response>;
}

export interface ContainerConnectionOptions {
  /** Sandbox DO stub (from `getSandbox(...)`). Used to issue the WS-upgrade fetch. */
  stub: ContainerFetchStub;
  /** Container port the workspace-server listens on. */
  port: number;
  /** Fired exactly once when an established WebSocket transitions to closed/errored. */
  onClose?: () => void;
}

/**
 * RPC transport that queues sends and blocks receives until a WebSocket
 * is provided via `activate()`. Mirrors sandbox-sdk's DeferredTransport so the
 * RPC stub can be created before the upgrade completes; queued calls flush
 * the moment the socket is ready.
 */
export class DeferredTransport implements RpcTransport {
  #ws: WebSocket | null = null;
  #sendQueue: string[] = [];
  #receiveQueue: string[] = [];
  #receiveResolver?: (msg: string) => void;
  #receiveRejecter?: (err: unknown) => void;
  #error?: unknown;

  activate(ws: WebSocket): void {
    this.#ws = ws;

    ws.addEventListener("message", (event: MessageEvent) => {
      if (this.#error) return;
      if (typeof event.data === "string") {
        if (this.#receiveResolver) {
          this.#receiveResolver(event.data);
          this.#receiveResolver = undefined;
          this.#receiveRejecter = undefined;
        } else {
          this.#receiveQueue.push(event.data);
        }
      } else {
        // capnweb's wire format is strictly text (JSON). A binary frame
        // means the peer is misbehaving — fail loudly so in-flight calls
        // don't hang forever.
        this.#fail(new TypeError("Received non-string message from WebSocket."));
      }
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      this.#fail(new Error(`Peer closed WebSocket: ${event.code} ${event.reason}`));
    });
    ws.addEventListener("error", () => {
      this.#fail(new Error("WebSocket connection failed."));
    });

    // Flush queued sends.
    for (const msg of this.#sendQueue) ws.send(msg);
    this.#sendQueue = [];
  }

  async send(message: string): Promise<void> {
    if (this.#ws) this.#ws.send(message);
    else this.#sendQueue.push(message);
  }

  async receive(): Promise<string> {
    if (this.#receiveQueue.length > 0) return this.#receiveQueue.shift()!;
    if (this.#error) throw this.#error;
    return new Promise<string>((resolve, reject) => {
      this.#receiveResolver = resolve;
      this.#receiveRejecter = reject;
    });
  }

  abort(reason: unknown): void {
    this.#fail(reason instanceof Error ? reason : new Error(String(reason)));
    if (this.#ws) {
      const msg = reason instanceof Error ? reason.message : String(reason);
      try { this.#ws.close(3000, msg); } catch { /* already closed */ }
    }
  }

  #fail(err: unknown): void {
    if (this.#error) return;
    this.#error = err;
    this.#receiveRejecter?.(err);
    this.#receiveResolver = undefined;
    this.#receiveRejecter = undefined;
  }
}

/**
 * Manages a single capnweb WebSocket session against the container's
 * workspace-server. The stub is materialised eagerly and remains valid across
 * the WS upgrade — callers don't need to `await connect()` before using it.
 */
export class ContainerConnection {
  private readonly stub: RpcStub<ContainerRpc>;
  private readonly session: RpcSession<ContainerRpc>;
  private readonly transport: DeferredTransport;
  private ws: WebSocket | null = null;
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private readonly containerStub: ContainerFetchStub;
  private readonly port: number;
  private readonly onClose: (() => void) | undefined;

  constructor(opts: ContainerConnectionOptions) {
    this.containerStub = opts.stub;
    this.port = opts.port;
    this.onClose = opts.onClose;

    this.transport = new DeferredTransport();
    this.session = new RpcSession<ContainerRpc>(this.transport);
    this.stub = this.session.getRemoteMain();
  }

  /**
   * Typed RPC stub. Available immediately — calls issued before the WS upgrade
   * resolves are queued in the transport and flushed once it's up.
   */
  rpc(): RpcStub<ContainerRpc> {
    // Kick off the connect on first access so the upgrade overlaps with the
    // caller's first RPC method invocation.
    if (!this.connected && !this.connectPromise) {
      this.connect().catch(() => { /* surface via the queued call */ });
    }
    return this.stub;
  }

  isConnected(): boolean { return this.connected; }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  disconnect(): void {
    try { (this.stub as unknown as Disposable)[Symbol.dispose]?.(); } catch { /* stub may already be disposed */ }
    if (this.ws) {
      // Unbind our listeners first so a late close/error event can't reach
      // a successor connection that the owner installed in our place.
      this.ws.removeEventListener("close", this.onWsClose);
      this.ws.removeEventListener("error", this.onWsError);
      try { this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
    this.connected = false;
    this.connectPromise = null;
  }

  // ---- internal ----

  private fireOnClose(): void {
    if (!this.onClose) return;
    try { this.onClose(); } catch { /* swallow buggy listener */ }
  }

  private onWsClose = (): void => {
    const wasConnected = this.connected;
    this.connected = false;
    this.ws = null;
    if (wasConnected) this.fireOnClose();
  };

  private onWsError = (): void => {
    const wasConnected = this.connected;
    this.connected = false;
    this.ws = null;
    if (wasConnected) this.fireOnClose();
  };

  private async doConnect(): Promise<void> {
    try {
      const req = new Request(`http://container/rpc`, {
        headers: { Upgrade: "websocket", Connection: "upgrade" },
      });
      const res = await this.containerStub.fetch(switchPort(req, this.port));
      if (res.status !== 101) {
        throw new Error(`WebSocket upgrade failed: ${res.status} ${res.statusText}`);
      }
      const ws = (res as unknown as { webSocket?: WebSocket }).webSocket;
      // Dispose the Response stub so workerd doesn't warn at hibernate time.
      try { (res as unknown as Disposable)[Symbol.dispose]?.(); } catch { /* older runtimes */ }
      if (!ws) throw new Error("No WebSocket in upgrade response");
      ws.accept();

      ws.addEventListener("close", this.onWsClose);
      ws.addEventListener("error", this.onWsError);

      this.ws = ws;
      this.transport.activate(ws);
      this.connected = true;
    } catch (err) {
      this.connected = false;
      this.transport.abort(err);
      throw err;
    }
  }
}
