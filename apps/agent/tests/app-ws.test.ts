/**
 * App WebSocket — presence + receipt/tip fanout (T4 + T5 surface).
 *
 * Covers:
 *   - WS upgrade succeeds with identity, rejects without.
 *   - `ping` → `pong` round-trip.
 *   - POST /activity broadcasts a `tip` frame to all connected clients.
 *   - PUT /me/receipts broadcasts a `receipt` frame tagged with userId.
 *   - A user `focus`-ed on a scope has their receipt auto-advanced when a
 *     message lands there, and is notified via a `receipt` frame.
 */
import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { asUser, VENKMAN, STANTZ } from "./identity.js";

function appStub() {
  return env.App.get(env.App.idFromName("app"));
}

async function openWS(user: typeof VENKMAN): Promise<WebSocket> {
  const res = await appStub().fetch(
    asUser("https://app/ws", user, { headers: { upgrade: "websocket" } }),
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no webSocket on upgrade response");
  ws.accept();
  return ws;
}

function nextFrame<T = unknown>(ws: WebSocket, predicate?: (f: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      const parsed = JSON.parse(e.data) as T;
      if (predicate && !predicate(parsed)) return;
      cleanup();
      resolve(parsed);
    };
    const onClose = (e: CloseEvent) => {
      cleanup();
      reject(new Error(`socket closed: ${e.code} ${e.reason}`));
    };
    const cleanup = () => {
      ws.removeEventListener("message", onMsg);
      ws.removeEventListener("close", onClose);
    };
    ws.addEventListener("message", onMsg);
    ws.addEventListener("close", onClose);
  });
}

describe("App WebSocket", () => {
  it("rejects upgrades without identity", async () => {
    const res = await appStub().fetch(new Request("https://app/ws", {
      headers: { upgrade: "websocket" },
    }));
    // The worker would 401 first; here we hit the DO directly and the
    // upgrade handler closes the socket with code 4401.
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    await new Promise<void>((resolve) => {
      ws.addEventListener("close", (e) => {
        expect(e.code).toBe(4401);
        resolve();
      });
    });
  });

  it("answers ping with pong", async () => {
    const ws = await openWS(VENKMAN);
    const pong = nextFrame<{ type: string }>(ws, f => f.type === "pong");
    ws.send(JSON.stringify({ type: "ping" }));
    expect((await pong).type).toBe("pong");
    ws.close();
  });

  it("broadcasts a tip frame on POST /activity", async () => {
    const ws = await openWS(VENKMAN);
    const incoming = nextFrame<{ type: string; scope: string; scopeId: string; lastActivity: number }>(
      ws, f => f.type === "tip",
    );
    await appStub().fetch(new Request("https://app/activity", {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ scope: "thread", scopeId: "t-ws-1", roomId: "r-ws-1", lastActivity: 9_000 }),
    }));
    const frame = await incoming;
    expect(frame.scope).toBe("thread");
    expect(frame.scopeId).toBe("t-ws-1");
    expect(frame.lastActivity).toBe(9_000);
    ws.close();
  });

  it("broadcasts a receipt frame on PUT /me/receipts", async () => {
    const ws = await openWS(VENKMAN);
    const incoming = nextFrame<{ type: string; userId: string; lastRead: number }>(
      ws, f => f.type === "receipt",
    );
    await appStub().fetch(asUser("https://app/me/receipts", VENKMAN, {
      method:  "PUT",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ scope: "room", scopeId: "r-ws-rcpt", lastRead: 7_777 }),
    }));
    const frame = await incoming;
    expect(frame.userId).toBe(VENKMAN.userId);
    expect(frame.lastRead).toBe(7_777);
    ws.close();
  });

  it("auto-advances a focused user's receipt when activity lands on their scope", async () => {
    const ws = await openWS(VENKMAN);
    // Tell App we're focused on this thread.
    ws.send(JSON.stringify({ type: "focus", scope: "thread", scopeId: "t-focus-1" }));
    // Give the focus frame a tick to land (onMessage is async).
    await new Promise(r => setTimeout(r, 30));

    // Wait for the receipt frame (skip past the tip broadcast).
    const incoming = nextFrame<{ type: string; userId: string; lastRead: number; scopeId: string }>(
      ws, f => f.type === "receipt",
    );
    // Stantz (or anyone) posts activity to the same thread.
    await appStub().fetch(new Request("https://app/activity", {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ scope: "thread", scopeId: "t-focus-1", roomId: "r-focus-1", lastActivity: 12_345 }),
    }));
    const frame = await incoming;
    expect(frame.userId).toBe(VENKMAN.userId);
    expect(frame.scopeId).toBe("t-focus-1");
    expect(frame.lastRead).toBe(12_345);

    // And the stored receipt advanced too.
    const res = await appStub().fetch(asUser("https://app/me/receipts", VENKMAN));
    const body = await res.json() as { receipts: Array<{ scopeId: string; lastRead: number }> };
    const r = body.receipts.find(x => x.scopeId === "t-focus-1");
    expect(r?.lastRead).toBe(12_345);
    ws.close();
  });

  it("does not auto-advance for a user who isn't focused", async () => {
    const v = await openWS(VENKMAN);
    const s = await openWS(STANTZ);
    s.send(JSON.stringify({ type: "focus", scope: "thread", scopeId: "t-only-stantz" }));
    await new Promise(r => setTimeout(r, 30));

    // Listen on Venkman's socket: should only see a tip, never a receipt
    // for this scope.
    let sawReceipt = false;
    v.addEventListener("message", (e) => {
      if (typeof e.data !== "string") return;
      const f = JSON.parse(e.data) as { type: string; scopeId?: string };
      // Receipt frames are broadcast tagged with userId; the client filters.
      // Venkman should never see a receipt frame *for himself* on this scope.
      const ff = f as { type: string; scopeId?: string; userId?: string };
      if (ff.type === "receipt" && ff.scopeId === "t-only-stantz" && ff.userId === VENKMAN.userId) sawReceipt = true;
    });
    await appStub().fetch(new Request("https://app/activity", {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ scope: "thread", scopeId: "t-only-stantz", roomId: "r-x", lastActivity: 1 }),
    }));
    // Wait long enough for any auto-advance broadcast to land.
    await new Promise(r => setTimeout(r, 80));
    expect(sawReceipt).toBe(false);

    // Venkman's receipt did not advance.
    const res = await appStub().fetch(asUser("https://app/me/receipts", VENKMAN));
    const body = await res.json() as { receipts: Array<{ scopeId: string }> };
    expect(body.receipts.find(r => r.scopeId === "t-only-stantz")).toBeUndefined();

    v.close();
    s.close();
  });
});

describe("App presence TTL eviction", () => {
  it("does not auto-advance a stale presence entry", async () => {
    // Shrink the TTL so the focus frame we send next ages out immediately.
    await appStub().fetch(new Request("https://app/__test/presence-ttl", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body:   JSON.stringify({ ms: 0 }),
    }));

    const ws = await openWS(VENKMAN);
    ws.send(JSON.stringify({ type: "focus", scope: "thread", scopeId: "t-stale" }));
    await new Promise(r => setTimeout(r, 30));

    // Don't listen for a receipt frame — we're proving the absence of one.
    let sawReceipt = false;
    ws.addEventListener("message", (e) => {
      if (typeof e.data !== "string") return;
      const f = JSON.parse(e.data) as { type: string; userId?: string; scopeId?: string };
      if (f.type === "receipt" && f.userId === VENKMAN.userId && f.scopeId === "t-stale") {
        sawReceipt = true;
      }
    });

    // Bump activity. With a TTL of 0ms, the focus entry is stale on the
    // next read and `autoAdvanceFocusedReceipts` evicts rather than fires.
    await appStub().fetch(new Request("https://app/activity", {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ scope: "thread", scopeId: "t-stale", roomId: "r-stale", lastActivity: 42_000 }),
    }));
    await new Promise(r => setTimeout(r, 80));

    expect(sawReceipt).toBe(false);

    // And the stored receipt was not advanced.
    const res = await appStub().fetch(asUser("https://app/me/receipts", VENKMAN));
    const body = await res.json() as { receipts: Array<{ scopeId: string }> };
    expect(body.receipts.find(r => r.scopeId === "t-stale")).toBeUndefined();

    // Restore TTL so it doesn't leak into other tests sharing the singleton.
    await appStub().fetch(new Request("https://app/__test/presence-ttl", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body:   JSON.stringify({ ms: 60000 }),
    }));
    ws.close();
  });
});
