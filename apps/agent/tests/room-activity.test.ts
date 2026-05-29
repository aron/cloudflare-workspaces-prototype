/**
 * Room — verifies that appending a message bumps the App DO's activity tip
 * (T2). End-to-end integration: Room.postActivity hits the same singleton
 * App DO that the tests query.
 */
import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { asUser, VENKMAN } from "./identity.js";
import type { ActivityTip } from "@app/shared";

let counter = 0;
function freshRoom() {
  counter += 1;
  const id   = `room-act-${counter}-${crypto.randomUUID()}`;
  const stub = env.Room.get(env.Room.idFromName(id));
  return { id, stub };
}

async function initRoom(stub: DurableObjectStub, id: string) {
  // Register the room with App so the room-tip UPDATE has a row to land on.
  const appStub = env.App.get(env.App.idFromName("app"));
  await appStub.fetch(asUser("https://app/rooms", VENKMAN, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ name: "act room" }),
  }));
  // App mints its own id, but Room.postActivity sends the Room's roomId.
  // So we INSERT a registry row with the matching id directly via init.
  // App.rooms only updates rows that already exist; insert via SQL-equivalent
  // by going through createRoom won't match. We rely on a parallel registry
  // INSERT via a follow-up POST whose id happens to match? Cleaner: insert
  // the row by addressing App's /rooms then re-using *that* id for the Room
  // DO. See `tips` flow below.
  return stub.fetch(asUser("https://room/init", VENKMAN, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ id, name: "act room", createdBy: VENKMAN.userId }),
  }));
}

async function getTips(): Promise<ActivityTip[]> {
  const appStub = env.App.get(env.App.idFromName("app"));
  const res = await appStub.fetch(asUser("https://app/me/receipts", VENKMAN));
  const body = await res.json() as { tips: ActivityTip[] };
  return body.tips;
}

async function postMsg(stub: DurableObjectStub, text: string) {
  return stub.fetch(asUser("https://room/messages", VENKMAN, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ parts: [{ type: "text", text }] }),
  }));
}

describe("Room → App activity bump", () => {
  it("bumps the thread tip when the message @-mentions the agent", async () => {
    // Threads don't depend on a rooms registry row, so this path is the
    // cleanest first integration check.
    const { id, stub } = freshRoom();
    await stub.fetch(asUser("https://room/init", VENKMAN, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ id, name: "thread room", createdBy: VENKMAN.userId }),
    }));
    const res = await postMsg(stub, "hey @agent help me");
    expect(res.status).toBe(201);
    const { threadId, message } = await res.json() as {
      threadId: string; message: { metadata: { createdAt: number } };
    };
    expect(threadId).toBeTruthy();

    const tips = await getTips();
    const tip = tips.find(t => t.scope === "thread" && t.scopeId === threadId);
    expect(tip).toBeDefined();
    expect(tip!.lastActivity).toBe(message.metadata.createdAt);
    expect(tip!.roomId).toBe(id);
  });

  it("bumps the room tip when the message is not a thread starter", async () => {
    // Create the rooms row through App so postActivity's UPDATE finds it,
    // then init Room DO with the same id.
    const appStub = env.App.get(env.App.idFromName("app"));
    const created = await appStub.fetch(asUser("https://app/rooms", VENKMAN, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ name: "plain room" }),
    }));
    const { room } = await created.json() as { room: { id: string } };
    const stub = env.Room.get(env.Room.idFromName(room.id));
    await stub.fetch(asUser("https://room/init", VENKMAN, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ id: room.id, name: "plain room", createdBy: VENKMAN.userId }),
    }));

    const res = await postMsg(stub, "no agent here");
    expect(res.status).toBe(201);
    const { message } = await res.json() as { message: { metadata: { createdAt: number } } };

    // postActivity runs under waitUntil; give it a beat.
    await new Promise(r => setTimeout(r, 50));
    const tips = await getTips();
    const tip = tips.find(t => t.scope === "room" && t.scopeId === room.id);
    expect(tip).toBeDefined();
    expect(tip!.lastActivity).toBe(message.metadata.createdAt);
  });
});
