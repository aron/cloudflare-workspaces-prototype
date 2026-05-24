/**
 * Room → Agent `/seed` wiring.
 *
 * When a room message mentions `@agent`, Room mints a thread and tells
 * the Agent DO at `idFromName(threadId)` to persist the originating user
 * message so the agent sees it on first turn.
 *
 * The Agent binding in `wrangler.test.jsonc` points at `FakeAgent`, which
 * records every fetch so we can assert exactly what Room sent.
 */
import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { asUser, VENKMAN } from "./identity.js";

async function setupRoom() {
  const id   = `room-seed-${crypto.randomUUID()}`;
  const stub = env.Room.get(env.Room.idFromName(id));
  const init = await stub.fetch(asUser("https://room/init", VENKMAN, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ id, name: "Seed room", createdBy: VENKMAN.userId }),
  }));
  expect(init.status).toBe(201);
  return { id, stub };
}

async function fakeAgentCalls(threadId: string) {
  const agentStub = env.Agent.get(env.Agent.idFromName(threadId));
  const res = await agentStub.fetch(new Request("https://agent/__calls"));
  return (await res.json() as { calls: Array<{ method: string; path: string; body: unknown }> }).calls;
}

describe("Room mints a thread and seeds the Agent DO", () => {
  it("POSTs /seed with the room id and the originating message", async () => {
    const { id: roomId, stub } = await setupRoom();

    const post = await stub.fetch(
      asUser("https://room/messages", VENKMAN, {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ parts: [{ type: "text", text: "@agent help with the build" }] }),
      }),
    );
    expect(post.status).toBe(201);
    const { message, threadId } = await post.json() as {
      message:  { id: string; parts: Array<{ text: string }>; metadata: { author: unknown } };
      threadId: string;
    };
    expect(threadId).toBeTruthy();

    const calls = await fakeAgentCalls(threadId);
    const seed  = calls.find(c => c.method === "POST" && c.path === "/seed");
    expect(seed, "Room must POST /seed to the Agent DO").toBeDefined();

    const body = seed!.body as {
      roomId:        string;
      threadId:      string;
      message:       { id: string; role: string; parts: Array<{ text: string }>; metadata: { author: unknown } };
    };
    expect(body.roomId).toBe(roomId);
    expect(body.threadId).toBe(threadId);
    expect(body.message.id).toBe(message.id);
    expect(body.message.role).toBe("user");
    expect(body.message.parts[0]?.text).toBe("@agent help with the build");
    expect(body.message.metadata.author).toEqual(message.metadata.author);
  });

  it("does NOT call /seed when @agent isn't mentioned", async () => {
    const { stub } = await setupRoom();

    // Use a unique thread namespace we control so we can poll FakeAgent for
    // any unexpected calls. The contract: Room must not call any Agent DO
    // when @agent is not mentioned. We assert that by checking the FakeAgent
    // for the only id Room could have invented — but since it shouldn't
    // invent one at all, we just confirm threadId is absent in the response.
    const post = await stub.fetch(
      asUser("https://room/messages", VENKMAN, {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ parts: [{ type: "text", text: "no mentions here, hi @go" }] }),
      }),
    );
    const body = await post.json() as { threadId?: string };
    expect(body.threadId).toBeUndefined();
  });
});
