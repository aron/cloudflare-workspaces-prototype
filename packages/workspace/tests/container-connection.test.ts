/**
 * Tests for the long-lived capnweb RPC connection. Covers the lifecycle
 * properties that matter for DO survivability:
 *
 *   - `DeferredTransport` queues sends before the WebSocket is activated and
 *     flushes them on activate.
 *   - Receives block until a message arrives, and reject if the transport
 *     fails first.
 *   - `ContainerConnection` deduplicates concurrent connects, fires `onClose`
 *     exactly once per established connection, and unbinds its listeners on
 *     `disconnect()` so a late close/error event can't reach a successor.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ContainerConnection,
  DeferredTransport,
  type ContainerFetchStub,
} from "../src/container-connection.ts";

// ---------------------------------------------------------------------------
// Fake WebSocket
// ---------------------------------------------------------------------------

interface TrackedWebSocket extends WebSocket {
  /** How many listeners are currently bound for `type`. */
  listenerCount(type: string): number;
  /** Dispatch a `message` event with the given string payload. */
  emitMessage(data: string): void;
  /** Dispatch a `close` event. */
  emitClose(code?: number, reason?: string): void;
  /** Dispatch an `error` event. */
  emitError(): void;
  /** Capture of every `send()` call. */
  sent: string[];
}

function makeWebSocket(): TrackedWebSocket {
  const target = new EventTarget();
  const counts: Record<string, number> = {};
  const sent: string[] = [];

  const addListener = (type: string, listener: EventListener) => {
    counts[type] = (counts[type] ?? 0) + 1;
    target.addEventListener(type, listener);
  };
  const removeListener = (type: string, listener: EventListener) => {
    counts[type] = Math.max(0, (counts[type] ?? 0) - 1);
    target.removeEventListener(type, listener);
  };

  const ws = {
    addEventListener: addListener,
    removeEventListener: removeListener,
    send: (msg: string) => sent.push(msg),
    close: () => { /* noop */ },
    accept: () => { /* noop */ },
    readyState: 1,
    listenerCount: (type: string) => counts[type] ?? 0,
    emitMessage: (data: string) =>
      target.dispatchEvent(Object.assign(new Event("message"), { data })),
    emitClose: (code = 1000, reason = "") =>
      target.dispatchEvent(Object.assign(new Event("close"), { code, reason })),
    emitError: () => target.dispatchEvent(new Event("error")),
    sent,
  };
  return ws as unknown as TrackedWebSocket;
}

function makeUpgradeResponse(ws: WebSocket): Response {
  return { status: 101, statusText: "Switching Protocols", webSocket: ws } as unknown as Response;
}

function makeStub(response: Response | Promise<Response>): ContainerFetchStub & { fetchCount: number } {
  const stub = {
    fetchCount: 0,
    async fetch(_req: Request) {
      stub.fetchCount++;
      return response;
    },
  };
  return stub;
}

// ---------------------------------------------------------------------------
// DeferredTransport
// ---------------------------------------------------------------------------

describe("DeferredTransport", () => {
  test("queues sends before activate() and flushes on activation", async () => {
    const t = new DeferredTransport();
    await t.send("first");
    await t.send("second");

    const ws = makeWebSocket();
    assert.deepEqual(ws.sent, []);

    t.activate(ws);
    assert.deepEqual(ws.sent, ["first", "second"]);

    // Subsequent sends go straight through.
    await t.send("third");
    assert.deepEqual(ws.sent, ["first", "second", "third"]);
  });

  test("receive() blocks until a message arrives", async () => {
    const t = new DeferredTransport();
    const ws = makeWebSocket();
    t.activate(ws);

    let resolved: string | undefined;
    const p = t.receive().then(v => { resolved = v; });
    // No message yet \u2014 receive must still be pending.
    await new Promise(r => setImmediate(r));
    assert.equal(resolved, undefined);

    ws.emitMessage("hello");
    await p;
    assert.equal(resolved, "hello");
  });

  test("receive() returns queued messages received before receive() was called", async () => {
    const t = new DeferredTransport();
    const ws = makeWebSocket();
    t.activate(ws);

    ws.emitMessage("a");
    ws.emitMessage("b");
    assert.equal(await t.receive(), "a");
    assert.equal(await t.receive(), "b");
  });

  test("receive() rejects when the WebSocket closes mid-wait", async () => {
    const t = new DeferredTransport();
    const ws = makeWebSocket();
    t.activate(ws);

    const p = t.receive();
    ws.emitClose(1011, "boom");
    await assert.rejects(p, /Peer closed WebSocket: 1011 boom/);
  });

  test("receive() rejects when the WebSocket errors mid-wait", async () => {
    const t = new DeferredTransport();
    const ws = makeWebSocket();
    t.activate(ws);

    const p = t.receive();
    ws.emitError();
    await assert.rejects(p, /WebSocket connection failed/);
  });

  test("subsequent receive() calls after failure also reject", async () => {
    const t = new DeferredTransport();
    const ws = makeWebSocket();
    t.activate(ws);

    ws.emitClose(1001, "going away");
    await assert.rejects(t.receive(), /Peer closed WebSocket/);
    await assert.rejects(t.receive(), /Peer closed WebSocket/);
  });

  test("abort() fails in-flight receives and is idempotent", async () => {
    const t = new DeferredTransport();
    const ws = makeWebSocket();
    t.activate(ws);

    const p = t.receive();
    t.abort(new Error("shutdown"));
    await assert.rejects(p, /shutdown/);
    // A second abort must not throw.
    t.abort(new Error("ignored"));
  });
});

// ---------------------------------------------------------------------------
// ContainerConnection
// ---------------------------------------------------------------------------

describe("ContainerConnection", () => {
  test("starts disconnected", () => {
    const conn = new ContainerConnection({
      stub: { async fetch() { throw new Error("unused"); } },
      port: 4567,
    });
    assert.equal(conn.isConnected(), false);
  });

  test("connect() establishes the session and exposes a stub", async () => {
    const ws = makeWebSocket();
    const stub = makeStub(makeUpgradeResponse(ws));
    const conn = new ContainerConnection({ stub, port: 4567 });
    await conn.connect();
    assert.equal(conn.isConnected(), true);
    assert.equal(stub.fetchCount, 1);
  });

  test("concurrent connect() calls share one in-flight upgrade", async () => {
    const ws = makeWebSocket();
    const stub = makeStub(makeUpgradeResponse(ws));
    const conn = new ContainerConnection({ stub, port: 4567 });

    await Promise.all([conn.connect(), conn.connect(), conn.connect()]);
    assert.equal(stub.fetchCount, 1);
  });

  test("connect() rejects on non-101 upgrade response", async () => {
    const stub = makeStub({ status: 503, statusText: "Service Unavailable" } as Response);
    const conn = new ContainerConnection({ stub, port: 4567 });
    await assert.rejects(conn.connect(), /WebSocket upgrade failed: 503/);
    assert.equal(conn.isConnected(), false);
  });

  test("connect() rejects when the upgrade response has no webSocket", async () => {
    const stub = makeStub({ status: 101, statusText: "Switching Protocols" } as Response);
    const conn = new ContainerConnection({ stub, port: 4567 });
    await assert.rejects(conn.connect(), /No WebSocket in upgrade response/);
  });

  test("fires onClose once when an established connection's WS closes", async () => {
    const ws = makeWebSocket();
    const stub = makeStub(makeUpgradeResponse(ws));
    let closeCount = 0;
    const conn = new ContainerConnection({
      stub, port: 4567,
      onClose: () => { closeCount++; },
    });
    await conn.connect();

    ws.emitClose(1006, "abnormal");
    assert.equal(closeCount, 1);
    assert.equal(conn.isConnected(), false);

    // A second close event must not fire onClose again.
    ws.emitClose(1000, "");
    assert.equal(closeCount, 1);
  });

  test("fires onClose for an error event on an established connection", async () => {
    const ws = makeWebSocket();
    const stub = makeStub(makeUpgradeResponse(ws));
    let closeCount = 0;
    const conn = new ContainerConnection({
      stub, port: 4567,
      onClose: () => { closeCount++; },
    });
    await conn.connect();

    ws.emitError();
    assert.equal(closeCount, 1);
  });

  test("does NOT fire onClose for an event dispatched after disconnect()", async () => {
    // Race guard: the runtime may dispatch a delayed close after the owner
    // has installed a successor connection. Our listeners must be unbound by
    // disconnect() so a late event can't reach the (stale) onClose handler.
    const ws = makeWebSocket();
    const stub = makeStub(makeUpgradeResponse(ws));
    let closeCount = 0;
    const conn = new ContainerConnection({
      stub, port: 4567,
      onClose: () => { closeCount++; },
    });
    await conn.connect();
    conn.disconnect();

    ws.emitClose(1011, "late close");
    ws.emitError();
    assert.equal(closeCount, 0);
  });

  test("disconnect() unbinds the close and error listeners it added", async () => {
    const ws = makeWebSocket();
    const stub = makeStub(makeUpgradeResponse(ws));
    const conn = new ContainerConnection({ stub, port: 4567 });
    await conn.connect();

    const closeBefore = ws.listenerCount("close");
    const errorBefore = ws.listenerCount("error");
    conn.disconnect();
    assert.equal(ws.listenerCount("close"), closeBefore - 1);
    assert.equal(ws.listenerCount("error"), errorBefore - 1);
  });

  test("rpc() returns a stub immediately, before connect() completes", () => {
    // Use a never-resolving fetch so we can observe the rpc() call without
    // the connect actually completing.
    const stub = { async fetch() { return new Promise<Response>(() => {}); } };
    const conn = new ContainerConnection({ stub, port: 4567 });
    const remote = conn.rpc();
    assert.ok(remote, "stub should be available before the WS upgrade resolves");
  });
});
