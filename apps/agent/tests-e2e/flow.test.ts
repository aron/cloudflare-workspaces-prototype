/**
 * End-to-end happy path through the full stack:
 *
 *   1. /api/app/me                            → identity bootstrap
 *   2. POST /api/app/rooms                     → create room (App row)
 *   3. GET  /api/app/rooms                     → list contains the new room
 *   4. GET  /api/rooms/:id/meta                → Room was initialized by worker
 *   5. POST /api/rooms/:id/messages            → simple message, no thread
 *   6. POST /api/rooms/:id/messages with @agent  → thread minted
 *   7. GET  /api/rooms/:id/threads             → thread is listed
 *   8. WS   /api/rooms/:id/ws                  → broadcast received on new post
 *   9. GET  Agent DO /debug/:threadId/messages → seed message persisted
 *
 * Each step uses real bindings (Room, App, Agent DO, Sandbox container).
 * No mocks. Failure here means a real-user regression.
 */
import { describe, it, expect, beforeAll } from "vitest";
import WebSocket from "ws";
import { BASE_URL } from "./harness.js";

let roomId: string;
let threadId: string | undefined;

beforeAll(async () => {
  const create = await fetch(`${BASE_URL}/api/app/rooms`, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ name: `e2e ${Date.now()}` }),
  });
  expect(create.status).toBe(201);
  const body = await create.json() as { room: { id: string } };
  roomId = body.room.id;
});

describe("E2E: identity + rooms", () => {
  it("returns the local dev identity and the current model", async () => {
    const res = await fetch(`${BASE_URL}/api/app/me`);
    expect(res.status).toBe(200);
    const me = await res.json() as { userId: string; email: string; name: string; model: string };
    expect(me.userId).toBeTruthy();
    expect(me.email).toBeTruthy();
    expect(me.name).toBeTruthy();
    expect(me.model).toBeTruthy();
  });

  it("lists the created room", async () => {
    const res  = await fetch(`${BASE_URL}/api/app/rooms`);
    const body = await res.json() as { rooms: Array<{ id: string }> };
    expect(body.rooms.map(r => r.id)).toContain(roomId);
  });

  it("worker initializes the Room so /meta is immediately available", async () => {
    const res = await fetch(`${BASE_URL}/api/rooms/${roomId}/meta`);
    expect(res.status).toBe(200);
    const meta = await res.json() as { id: string };
    expect(meta.id).toBe(roomId);
  });
});

describe("E2E: room messages", () => {
  it("appends a plain message without minting a thread", async () => {
    const res = await fetch(`${BASE_URL}/api/rooms/${roomId}/messages`, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ parts: [{ type: "text", text: "hello team" }] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { threadId?: string; message: { metadata: { author: { name: string } } } };
    expect(body.threadId).toBeUndefined();
    expect(body.message.metadata.author.name).toBeTruthy();
  });

  it("mints a thread when @agent is mentioned", async () => {
    const res = await fetch(`${BASE_URL}/api/rooms/${roomId}/messages`, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ parts: [{ type: "text", text: "@agent can you help with the build?" }] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { threadId: string };
    expect(body.threadId).toBeTruthy();
    threadId = body.threadId;
  });

  it("lists the minted thread", async () => {
    const res = await fetch(`${BASE_URL}/api/rooms/${roomId}/threads`);
    expect(res.status).toBe(200);
    const body = await res.json() as { threads: Array<{ id: string; agentId: string }> };
    expect(body.threads.find(t => t.id === threadId)?.agentId).toBe("agent");
  });
});

describe("E2E: room WebSocket fanout", () => {
  it("broadcasts a posted message to a connected client", async () => {
    const url = `${BASE_URL.replace(/^http/, "ws")}/api/rooms/${roomId}/ws`;
    const ws  = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    const incoming = new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out waiting for WS frame")), 8000);
      ws.on("message", (data) => { clearTimeout(t); resolve(data.toString()); });
    });

    await fetch(`${BASE_URL}/api/rooms/${roomId}/messages`, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ parts: [{ type: "text", text: "ws broadcast" }] }),
    });

    const frame = JSON.parse(await incoming) as {
      type: string;
      message: { parts: Array<{ text: string }> };
    };
    expect(frame.type).toBe("message");
    expect(frame.message.parts[0]?.text).toBe("ws broadcast");

    ws.close();
  });
});

describe("E2E: Agent DO seed", () => {
  it("Room seeded the Agent DO with the originating user message", async () => {
    if (!threadId) throw new Error("threadId missing — prior test must have failed");

    // Poll: the seed call is awaited inline by Room, but `saveMessages` may
    // still be flushing through the AIChatAgent's turn queue. Give it a few
    // seconds before declaring failure.
    const deadline = Date.now() + 10_000;
    let messages: Array<{ role: string; parts: Array<{ text?: string }>; metadata?: { author?: { name?: string } } }> = [];
    while (Date.now() < deadline) {
      const res = await fetch(`${BASE_URL}/debug/${threadId}/messages`);
      if (res.ok) {
        const body = await res.json() as { messages: typeof messages };
        if (body.messages.length > 0) { messages = body.messages; break; }
      }
      await new Promise(r => setTimeout(r, 500));
    }

    expect(messages.length).toBeGreaterThan(0);
    const seed = messages[0]!;
    expect(seed.role).toBe("user");
    const text = seed.parts.find(p => p.text)?.text ?? "";
    expect(text).toContain("@agent");
    expect(seed.metadata?.author?.name).toBeTruthy();
  });
});
