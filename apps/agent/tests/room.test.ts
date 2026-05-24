/**
 * Room — Phase 3 spec, driven by tests.
 *
 * Lifecycle:
 *   1. App mints a room id and POSTs /init to the Room.
 *   2. Users post messages via POST /messages.
 *   3. Messages mentioning `@agent` mint a thread row; the response
 *      includes a `threadId` the client uses to open the Agent DO.
 *
 * These tests cover the HTTP surface. WebSocket fanout is covered separately.
 */
import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";
import { asUser, ARON, BEA } from "./identity.js";

let roomCounter = 0;
function freshRoom() {
  // Each test addresses a unique Room instance so state doesn't bleed.
  roomCounter += 1;
  const id   = `room-${roomCounter}-${crypto.randomUUID()}`;
  const stub = env.Room.get(env.Room.idFromName(id));
  return { id, stub };
}

async function initRoom(stub: DurableObjectStub, id: string, name = "Test room", createdBy = ARON.userId) {
  return stub.fetch(
    asUser(`https://room/init`, ARON, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ id, name, createdBy }),
    }),
  );
}

describe("Room /init", () => {
  it("stores room metadata on first call", async () => {
    const { id, stub } = freshRoom();
    const res = await initRoom(stub, id, "Hackspace");
    expect(res.status).toBe(201);

    const meta = await stub.fetch(asUser("https://room/meta", BEA));
    expect(meta.status).toBe(200);
    const body = await meta.json() as { id: string; name: string; createdBy: string; createdAt: number };
    expect(body.id).toBe(id);
    expect(body.name).toBe("Hackspace");
    expect(body.createdBy).toBe(ARON.userId);
    expect(body.createdAt).toBeGreaterThan(0);
  });

  it("rejects re-initialization with 409", async () => {
    const { id, stub } = freshRoom();
    await initRoom(stub, id, "First");
    const res = await initRoom(stub, id, "Second");
    expect(res.status).toBe(409);
  });
});

describe("Room /meta", () => {
  it("returns 404 before init", async () => {
    const { stub } = freshRoom();
    const res = await stub.fetch(asUser("https://room/meta", ARON));
    expect(res.status).toBe(404);
  });
});

describe("Room /messages", () => {
  it("starts empty", async () => {
    const { id, stub } = freshRoom();
    await initRoom(stub, id);
    const res = await stub.fetch(asUser("https://room/messages", ARON));
    expect(res.status).toBe(200);
    const body = await res.json() as { messages: unknown[] };
    expect(body.messages).toEqual([]);
  });

  it("appends a user message with author metadata", async () => {
    const { id, stub } = freshRoom();
    await initRoom(stub, id);

    const post = await stub.fetch(
      asUser("https://room/messages", BEA, {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ parts: [{ type: "text", text: "hello team" }] }),
      }),
    );
    expect(post.status).toBe(201);
    const { message, threadId } = await post.json() as {
      message:   { id: string; role: string; parts: unknown[]; metadata: { author: { kind: string; id: string; name: string }; createdAt: number } };
      threadId?: string;
    };

    expect(message.role).toBe("user");
    expect(message.metadata.author).toEqual({ kind: "user", id: BEA.userId, email: BEA.email, name: BEA.name });
    expect(message.metadata.createdAt).toBeGreaterThan(0);
    expect(threadId).toBeUndefined();

    const list = await stub.fetch(asUser("https://room/messages", ARON));
    const { messages } = await list.json() as { messages: Array<{ id: string }> };
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe(message.id);
  });

  it("rejects messages with no text parts", async () => {
    const { id, stub } = freshRoom();
    await initRoom(stub, id);
    const res = await stub.fetch(
      asUser("https://room/messages", ARON, {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ parts: [] }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns messages in chronological order, oldest first", async () => {
    const { id, stub } = freshRoom();
    await initRoom(stub, id);

    for (const text of ["one", "two", "three"]) {
      await stub.fetch(
        asUser("https://room/messages", ARON, {
          method:  "POST",
          headers: { "content-type": "application/json" },
          body:    JSON.stringify({ parts: [{ type: "text", text }] }),
        }),
      );
    }

    const res = await stub.fetch(asUser("https://room/messages", ARON));
    const { messages } = await res.json() as {
      messages: Array<{ parts: Array<{ type: string; text: string }> }>;
    };
    expect(messages.map(m => m.parts[0]?.text)).toEqual(["one", "two", "three"]);
  });
});

describe("Room @agent mention → thread", () => {
  it("mints a thread when a message mentions @agent", async () => {
    const { id, stub } = freshRoom();
    await initRoom(stub, id);

    const post = await stub.fetch(
      asUser("https://room/messages", ARON, {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ parts: [{ type: "text", text: "hey @agent can you help?" }] }),
      }),
    );
    expect(post.status).toBe(201);
    const { message, threadId } = await post.json() as {
      message:  { id: string; metadata: { threadId?: string } };
      threadId: string;
    };
    expect(threadId).toBeTruthy();
    expect(message.metadata.threadId).toBe(threadId);
  });

  it("only mints one thread per message even with multiple @agent mentions", async () => {
    const { id, stub } = freshRoom();
    await initRoom(stub, id);

    const post = await stub.fetch(
      asUser("https://room/messages", ARON, {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ parts: [{ type: "text", text: "@agent @agent ping" }] }),
      }),
    );
    const { threadId } = await post.json() as { threadId: string };
    expect(threadId).toBeTruthy();

    const list = await stub.fetch(asUser("https://room/threads", ARON));
    const { threads } = await list.json() as { threads: Array<{ id: string }> };
    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe(threadId);
  });

  it("ignores @mentions that aren't @agent", async () => {
    const { id, stub } = freshRoom();
    await initRoom(stub, id);

    const post = await stub.fetch(
      asUser("https://room/messages", ARON, {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ parts: [{ type: "text", text: "talking about @nobody-here and @go" }] }),
      }),
    );
    const body = await post.json() as { threadId?: string };
    expect(body.threadId).toBeUndefined();
  });
});

describe("Room /threads", () => {
  it("returns 200 with an empty list when no threads exist", async () => {
    const { id, stub } = freshRoom();
    await initRoom(stub, id);
    const res = await stub.fetch(asUser("https://room/threads", ARON));
    expect(res.status).toBe(200);
    const body = await res.json() as { threads: unknown[] };
    expect(body.threads).toEqual([]);
  });
});
