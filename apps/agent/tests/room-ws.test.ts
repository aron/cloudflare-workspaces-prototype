/**
 * Room WebSocket fanout — when a user posts a message, every connected
 * client receives a `{ type: "message", message }` frame.
 *
 * Drives the PartyServer wiring (broadcast on POST /messages).
 */
import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { asUser, VENKMAN, STANTZ } from "./identity.js";

async function setupRoom() {
  const id   = `room-ws-${crypto.randomUUID()}`;
  const stub = env.Room.get(env.Room.idFromName(id));
  const init = await stub.fetch(asUser("https://room/init", VENKMAN, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ id, name: "WS room", createdBy: VENKMAN.userId }),
  }));
  expect(init.status).toBe(201);
  return { id, stub };
}

async function openSocket(stub: DurableObjectStub): Promise<WebSocket> {
  const res = await stub.fetch(
    asUser("https://room/ws", STANTZ, { headers: { upgrade: "websocket" } }),
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("expected a webSocket on the upgrade response");
  ws.accept();
  return ws;
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      cleanup();
      resolve(typeof e.data === "string" ? e.data : "<binary>");
    };
    const onClose = (e: CloseEvent) => {
      cleanup();
      reject(new Error(`socket closed before message: ${e.code} ${e.reason}`));
    };
    const cleanup = () => {
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close",   onClose);
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close",   onClose);
  });
}

describe("Room WebSocket fanout", () => {
  it("broadcasts a new message to connected clients", async () => {
    const { stub } = await setupRoom();
    const ws       = await openSocket(stub);
    const incoming = nextMessage(ws);

    const post = await stub.fetch(
      asUser("https://room/messages", VENKMAN, {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ parts: [{ type: "text", text: "broadcast me" }] }),
      }),
    );
    expect(post.status).toBe(201);

    const frame = await incoming;
    const parsed = JSON.parse(frame) as {
      type: string;
      message: { parts: Array<{ text: string }>; metadata: { author: { id: string } } };
    };
    expect(parsed.type).toBe("message");
    expect(parsed.message.parts[0]?.text).toBe("broadcast me");
    expect(parsed.message.metadata.author.id).toBe(VENKMAN.userId);

    ws.close();
  });
});
