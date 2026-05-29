/**
 * Room — Google Chat webhook notifications when a message mentions a user
 * who has saved their Google Chat ID.
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

async function touch(user = VENKMAN) {
  const appStub = env.App.get(env.App.idFromName("app"));
  await appStub.fetch(asUser("https://app/me", user));
}

async function setGChatId(user: typeof VENKMAN, id: string | null) {
  const appStub = env.App.get(env.App.idFromName("app"));
  await appStub.fetch(asUser("https://app/me/settings", user, {
    method:  "PUT",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ googleChatUserId: id }),
  }));
}

interface FetchSpy {
  calls: Array<{ url: string; init?: RequestInit }>;
  restore: () => void;
}

function spyFetch(matcher: (url: string) => boolean): FetchSpy {
  const original = globalThis.fetch;
  const calls: FetchSpy["calls"] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (matcher(url)) {
      calls.push({ url, init });
      return new Response("ok", { status: 200 });
    }
    return original(input as RequestInfo, init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const WEBHOOK = "https://chat.googleapis.com/v1/spaces/TEST/messages?key=k&token=t";

// `env` is typed readonly but in the test harness it's a plain object; cast away.
const mutEnv = env as unknown as { GCHAT_WEBHOOK_URL?: string };

describe("Room — mention notifications", () => {
  let spy: FetchSpy;
  beforeEach(() => { spy = spyFetch(u => u.startsWith("https://chat.googleapis.com")); });
  afterEach(()  => { spy.restore(); delete mutEnv.GCHAT_WEBHOOK_URL; });

  async function flush() {
    // ctx.waitUntil isn't awaited by the response; yield a few times so the
    // background notify promise can run to completion.
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5));
  }

  it("fires a webhook when a recognised user is mentioned", async () => {
    mutEnv.GCHAT_WEBHOOK_URL = WEBHOOK;
    await touch(STANTZ);
    await setGChatId(STANTZ, "999000111");

    const { id, stub } = freshRoom();
    await initRoom(stub, id);
    const res = await stub.fetch(asUser(`https://room/messages`, VENKMAN, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ parts: [{ type: "text", text: `hey <mention type="user" id="${STANTZ.userId}">@x</mention> look at this` }] }),
    }));
    expect(res.status).toBe(201);

    await flush();
    expect(spy.calls.length).toBe(1);
    const body = JSON.parse(spy.calls[0]!.init!.body as string) as { text: string };
    expect(body.text).toContain("<users/999000111>");
    expect(body.text).toContain("Stantz");
    expect(body.text).toContain("Hackspace");
    // No APP_BASE_URL set and no x-app-base-url header on the inbound stub
    // call — so the payload must not contain a bare path. The first line
    // (the mention + summary) is fine; we just don't want a raw `/rooms/...`.
    expect(body.text).not.toMatch(/\n\/rooms\//);
  });

  it("includes an absolute deep-link URL when APP_BASE_URL is set", async () => {
    mutEnv.GCHAT_WEBHOOK_URL = WEBHOOK;
    (mutEnv as { APP_BASE_URL?: string }).APP_BASE_URL = "https://example.test";
    await touch(STANTZ);
    await setGChatId(STANTZ, "999000111");

    const { id, stub } = freshRoom();
    await initRoom(stub, id);
    const res = await stub.fetch(asUser(`https://room/messages`, VENKMAN, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ parts: [{ type: "text", text: `<mention type="user" id="${STANTZ.userId}">@x</mention>` }] }),
    }));
    const created = await res.json() as { message: { id: string } };
    await flush();
    expect(spy.calls.length).toBe(1);
    const body = JSON.parse(spy.calls[0]!.init!.body as string) as { text: string };
    expect(body.text).toContain(`https://example.test/rooms/${id}#${created.message.id}`);
    delete (mutEnv as { APP_BASE_URL?: string }).APP_BASE_URL;
  });

  it("does not fire when GCHAT_WEBHOOK_URL is unset", async () => {
    await touch(STANTZ);
    await setGChatId(STANTZ, "999000111");

    const { id, stub } = freshRoom();
    await initRoom(stub, id);
    await stub.fetch(asUser(`https://room/messages`, VENKMAN, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ parts: [{ type: "text", text: `<mention type="user" id="${STANTZ.userId}">@x</mention>` }] }),
    }));

    await flush();
    expect(spy.calls.length).toBe(0);
  });

  it("does not fire when the mentioned user has no Google Chat ID", async () => {
    mutEnv.GCHAT_WEBHOOK_URL = WEBHOOK;
    await touch(STANTZ);
    await setGChatId(STANTZ, null);

    const { id, stub } = freshRoom();
    await initRoom(stub, id);
    await stub.fetch(asUser(`https://room/messages`, VENKMAN, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ parts: [{ type: "text", text: `<mention type="user" id="${STANTZ.userId}">@x</mention>` }] }),
    }));

    await flush();
    expect(spy.calls.length).toBe(0);
  });

  it("does not notify the author for self-mentions", async () => {
    mutEnv.GCHAT_WEBHOOK_URL = WEBHOOK;
    await touch(VENKMAN);
    await setGChatId(VENKMAN, "555");

    const { id, stub } = freshRoom();
    await initRoom(stub, id);
    await stub.fetch(asUser(`https://room/messages`, VENKMAN, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ parts: [{ type: "text", text: `<mention type="user" id="${VENKMAN.userId}">@x</mention> note to self` }] }),
    }));

    await flush();
    expect(spy.calls.length).toBe(0);
  });
});
