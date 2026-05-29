/**
 * Room — @mention notifications. Mentions now flow through the App DO's
 * pending_notifications queue rather than firing the Google Chat webhook
 * synchronously. These tests verify the Room → App enqueue handoff and
 * the end-to-end behaviour once the cron drain pass runs.
 */
import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { asUser, VENKMAN, STANTZ } from "./identity.js";

function freshRoom() {
  const id   = `room-notify-${crypto.randomUUID()}`;
  const stub = env.Room.get(env.Room.idFromName(id));
  return { id, stub };
}

async function initRoom(stub: DurableObjectStub, id: string) {
  return stub.fetch(asUser("https://room/init", VENKMAN, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ id, name: "Hackspace", createdBy: VENKMAN.userId }),
  }));
}

function appStub() {
  return env.App.get(env.App.idFromName("app"));
}
async function touch(user = VENKMAN) {
  await appStub().fetch(asUser("https://app/me", user));
}
async function setGChatId(user: typeof VENKMAN, id: string | null) {
  await appStub().fetch(asUser("https://app/me/settings", user, {
    method:  "PUT",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ googleChatUserId: id }),
  }));
}
async function clearQueue() {
  await appStub().fetch(new Request("https://app/__test/clear-notifications", { method: "POST" }));
}
async function setDebounce(ms: number) {
  await appStub().fetch(new Request("https://app/__test/notif-debounce", {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ ms }),
  }));
}
async function drain() {
  const res = await appStub().fetch(new Request("https://app/notifications/drain", { method: "POST" }));
  return await res.json() as { sent: number; dropped: number; failed: number; swept: number };
}

interface FetchSpy {
  calls: Array<{ url: string; body: string }>;
  restore: () => void;
}
function spyWebhook(): FetchSpy {
  const original = globalThis.fetch;
  const calls: FetchSpy["calls"] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("chat.googleapis.com")) {
      calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      return new Response("ok", { status: 200 });
    }
    return original(input as RequestInfo, init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const WEBHOOK = "https://chat.googleapis.com/v1/spaces/TEST/messages?key=k&token=t";
const mutEnv = env as unknown as { GCHAT_WEBHOOK_URL?: string };

beforeEach(async () => {
  mutEnv.GCHAT_WEBHOOK_URL = WEBHOOK;
  await clearQueue();
  await setDebounce(0);  // ready immediately, so a single drain() finalises rows
});
afterEach(async () => {
  delete mutEnv.GCHAT_WEBHOOK_URL;
  await setDebounce(60_000);
});

/** Give Room's `ctx.waitUntil` enqueue task a few ticks to land. */
async function flushWaitUntil() {
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5));
}

describe("Room — @mention notifications", () => {
  it("enqueues a notification that the drain then delivers", async () => {
    await touch(STANTZ);
    await setGChatId(STANTZ, "999000111");

    const { id, stub } = freshRoom();
    await initRoom(stub, id);
    const res = await stub.fetch(asUser(`https://room/messages`, VENKMAN, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ parts: [{ type: "text",
        text: `hey <mention type="user" id="${STANTZ.userId}">@x</mention> look at this` }] }),
    }));
    expect(res.status).toBe(201);
    await flushWaitUntil();

    const spy = spyWebhook();
    try {
      const r = await drain();
      expect(r.sent).toBe(1);
      expect(spy.calls).toHaveLength(1);
      const body = JSON.parse(spy.calls[0]!.body) as { text: string };
      expect(body.text).toContain("<users/999000111>");
      expect(body.text).toContain("Hackspace");
    } finally {
      spy.restore();
    }
  });

  it("drops the queued mention when the recipient reads before the drain runs", async () => {
    await touch(STANTZ);
    await setGChatId(STANTZ, "999000111");

    // Debounce stays at 0 (from beforeEach) so the row is immediately
    // eligible. The test exercises the receipt check that runs *inside*
    // the drain pass: between enqueue and drain, the recipient reads.
    const { id, stub } = freshRoom();
    await initRoom(stub, id);
    await stub.fetch(asUser(`https://room/messages`, VENKMAN, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ parts: [{ type: "text",
        text: `<mention type="user" id="${STANTZ.userId}">@x</mention>` }] }),
    }));
    await flushWaitUntil();

    // Recipient reads the room past the message before the drain runs.
    await appStub().fetch(asUser("https://app/me/receipts", STANTZ, {
      method:  "PUT",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ scope: "room", scopeId: id, lastRead: Date.now() + 1_000_000 }),
    }));

    const spy = spyWebhook();
    try {
      const r = await drain();
      expect(r.dropped).toBe(1);
      expect(r.sent).toBe(0);
      expect(spy.calls).toHaveLength(0);
    } finally {
      spy.restore();
    }
  });

  it("does not enqueue self-mentions", async () => {
    await touch(VENKMAN);
    await setGChatId(VENKMAN, "555");

    const { id, stub } = freshRoom();
    await initRoom(stub, id);
    await stub.fetch(asUser(`https://room/messages`, VENKMAN, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ parts: [{ type: "text",
        text: `<mention type="user" id="${VENKMAN.userId}">@x</mention> note to self` }] }),
    }));
    await flushWaitUntil();

    const spy = spyWebhook();
    try {
      const r = await drain();
      expect(r.sent).toBe(0);
      expect(r.dropped).toBe(0);
      expect(spy.calls).toHaveLength(0);
    } finally {
      spy.restore();
    }
  });

  it("drops queued rows when no Google Chat ID is on file", async () => {
    await touch(STANTZ);
    await setGChatId(STANTZ, null);

    const { id, stub } = freshRoom();
    await initRoom(stub, id);
    await stub.fetch(asUser(`https://room/messages`, VENKMAN, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ parts: [{ type: "text",
        text: `<mention type="user" id="${STANTZ.userId}">@x</mention>` }] }),
    }));
    await flushWaitUntil();

    const spy = spyWebhook();
    try {
      const r = await drain();
      expect(r.dropped).toBe(1);
      expect(r.sent).toBe(0);
      expect(spy.calls).toHaveLength(0);
    } finally {
      spy.restore();
    }
  });
});
