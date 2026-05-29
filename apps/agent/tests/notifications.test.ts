/**
 * App DO — pending notifications queue (N1).
 *
 * Covers:
 *   - Enqueue inserts ready_at = createdAt + debounce window.
 *   - Pre-ready drain is a no-op.
 *   - Post-ready drain with a fresh receipt drops every grouped row.
 *   - Post-ready drain with no advancing receipt fires *one* webhook with
 *     a count summary that covers every row in the group.
 *   - Per-recipient grouping is independent (Venkman + Stantz don't merge).
 *   - Per-scope grouping is independent (room vs. thread for same user).
 *   - Idempotent enqueue: same (message_id, user_id) won't double-insert.
 *   - Missing Google Chat ID / webhook → row marked dropped (no infinite retry).
 *   - Webhook failure bumps attempts; success on retry clears the row.
 */
import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { asUser, VENKMAN, STANTZ } from "./identity.js";

function appStub() {
  return env.App.get(env.App.idFromName("app"));
}

async function touch(user: typeof VENKMAN) {
  await appStub().fetch(asUser("https://app/me", user));
}

async function setGChatId(user: typeof VENKMAN, id: string | null) {
  await appStub().fetch(asUser("https://app/me/settings", user, {
    method:  "PUT",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ googleChatUserId: id }),
  }));
}

async function putReceipt(user: typeof VENKMAN, scope: "room" | "thread", scopeId: string, lastRead: number) {
  await appStub().fetch(asUser("https://app/me/receipts", user, {
    method:  "PUT",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ scope, scopeId, lastRead }),
  }));
}

async function setDebounce(ms: number) {
  await appStub().fetch(new Request("https://app/__test/notif-debounce", {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ ms }),
  }));
}

async function enqueue(mentions: Array<Record<string, unknown>>) {
  return appStub().fetch(new Request("https://app/notifications/enqueue", {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ mentions }),
  }));
}

async function drain(): Promise<{ sent: number; dropped: number; failed: number; swept: number }> {
  const res = await appStub().fetch(new Request("https://app/notifications/drain", { method: "POST" }));
  return await res.json();
}

interface FetchSpy {
  calls: Array<{ url: string; body: string }>;
  restore: () => void;
}
function spyWebhook(opts: { fail?: boolean } = {}): FetchSpy {
  const original = globalThis.fetch;
  const calls: FetchSpy["calls"] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("chat.googleapis.com")) {
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ url, body });
      return new Response("err", { status: opts.fail ? 500 : 200 });
    }
    return original(input as RequestInfo, init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const WEBHOOK = "https://chat.googleapis.com/v1/spaces/TEST/messages?key=k&token=t";
const mutEnv = env as unknown as { GCHAT_WEBHOOK_URL?: string };

beforeEach(async () => {
  mutEnv.GCHAT_WEBHOOK_URL = WEBHOOK;
  await setDebounce(0);  // ready_at == created_at; drain immediately
  await appStub().fetch(new Request("https://app/__test/clear-notifications", { method: "POST" }));
});
afterEach(async () => {
  delete mutEnv.GCHAT_WEBHOOK_URL;
  // Restore production debounce so the value doesn't leak across the
  // singleton-shared App DO into unrelated tests.
  await setDebounce(60_000);
});

describe("App /notifications/enqueue", () => {
  it("inserts rows and returns the count", async () => {
    await touch(VENKMAN);
    const res = await enqueue([
      { userId: VENKMAN.userId, roomId: "r1", messageId: `m1-${crypto.randomUUID()}`,
        snippet: "hi", authorName: "Stantz", roomName: "Hackspace",
        createdAt: 1000 },
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enqueued: 1 });
  });

  it("is idempotent on (message_id, user_id) while in flight", async () => {
    await touch(VENKMAN);
    const m = { userId: VENKMAN.userId, roomId: "r1", messageId: `dup-${crypto.randomUUID()}`,
      snippet: "hi", authorName: "Stantz", roomName: "Hackspace",
      createdAt: 1000 };
    const a = await enqueue([m]); expect(await a.json()).toEqual({ enqueued: 1 });
    const b = await enqueue([m]); expect(await b.json()).toEqual({ enqueued: 0 });
  });

  it("rejects malformed mentions but accepts the well-formed ones in the same batch", async () => {
    await touch(VENKMAN);
    const res = await enqueue([
      { userId: VENKMAN.userId, roomId: "r1", messageId: `ok-${crypto.randomUUID()}`, snippet: "x",
        authorName: "S", roomName: "H", createdAt: 1000 },
      { userId: "", roomId: "r1", messageId: "bad", createdAt: 1000 },
      { roomId: "r1", messageId: `alsobad-${crypto.randomUUID()}`, createdAt: 1000 },
    ]);
    expect(await res.json()).toEqual({ enqueued: 1 });
  });
});

describe("App /notifications/drain — receipt check", () => {
  it("drops the whole group when the user has read past the latest mention", async () => {
    await touch(VENKMAN);
    await setGChatId(VENKMAN, "123456789");
    await enqueue([
      { userId: VENKMAN.userId, roomId: "r-read", messageId: `m1-${crypto.randomUUID()}`,
        snippet: "first", authorName: "Stantz", roomName: "Hackspace",
        createdAt: 1000 },
      { userId: VENKMAN.userId, roomId: "r-read", messageId: `m2-${crypto.randomUUID()}`,
        snippet: "second", authorName: "Stantz", roomName: "Hackspace",
        createdAt: 2000 },
    ]);
    // Read past the latest mention before the drain runs.
    await putReceipt(VENKMAN, "room", "r-read", 5000);

    const spy = spyWebhook();
    try {
      const r = await drain();
      expect(r.dropped).toBe(2);
      expect(r.sent).toBe(0);
      expect(spy.calls).toHaveLength(0);
    } finally {
      spy.restore();
    }
  });
});

describe("App /notifications/drain — delivery", () => {
  it("fires exactly one webhook per (user, scope) group and summarises the burst", async () => {
    await touch(VENKMAN);
    await setGChatId(VENKMAN, "999000111");
    await enqueue([
      { userId: VENKMAN.userId, roomId: "r-burst", messageId: `m1-${crypto.randomUUID()}`,
        snippet: "earlier", authorName: "Stantz", roomName: "Hackspace",
        createdAt: 1000 },
      { userId: VENKMAN.userId, roomId: "r-burst", messageId: `m2-${crypto.randomUUID()}`,
        snippet: "latest", authorName: "Stantz", roomName: "Hackspace",
        createdAt: 2000 },
      { userId: VENKMAN.userId, roomId: "r-burst", messageId: `m3-${crypto.randomUUID()}`,
        snippet: "middle", authorName: "Stantz", roomName: "Hackspace",
        createdAt: 1500 },
    ]);

    const spy = spyWebhook();
    try {
      const r = await drain();
      expect(r.sent).toBe(3);
      expect(r.dropped).toBe(0);
      expect(spy.calls).toHaveLength(1);
      // Payload should reference the count and the *latest* snippet.
      expect(spy.calls[0]!.body).toMatch(/3 new mentions/);
      expect(spy.calls[0]!.body).toMatch(/latest/);
    } finally {
      spy.restore();
    }
  });

  it("keeps per-recipient and per-scope groups independent", async () => {
    await touch(VENKMAN); await touch(STANTZ);
    await setGChatId(VENKMAN, "111111111");
    await setGChatId(STANTZ,  "222222222");
    await enqueue([
      { userId: VENKMAN.userId, roomId: "r-x", messageId: `v1-${crypto.randomUUID()}`,
        snippet: "for venkman", authorName: "Stantz", roomName: "Hackspace",
        createdAt: 1000 },
      { userId: STANTZ.userId,  roomId: "r-x", messageId: `s1-${crypto.randomUUID()}`,
        snippet: "for stantz",  authorName: "Venkman", roomName: "Hackspace",
        createdAt: 1000 },
      { userId: VENKMAN.userId, roomId: "r-x", threadId: "t-x", messageId: `v2-${crypto.randomUUID()}`,
        snippet: "in thread",  authorName: "Stantz", roomName: "Hackspace",
        createdAt: 1000 },
    ]);

    const spy = spyWebhook();
    try {
      const r = await drain();
      // 3 rows, 3 groups, 3 webhook calls.
      expect(r.sent).toBe(3);
      expect(spy.calls).toHaveLength(3);
    } finally {
      spy.restore();
    }
  });

  it("drops rows when no Google Chat ID is on file (no infinite retry)", async () => {
    await touch(VENKMAN);
    await setGChatId(VENKMAN, null);
    await enqueue([
      { userId: VENKMAN.userId, roomId: "r-no-id", messageId: `m1-${crypto.randomUUID()}`,
        snippet: "x", authorName: "S", roomName: "H", createdAt: 1000 },
    ]);
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

  it("bumps attempts on webhook failure and stays pending for retry", async () => {
    await touch(VENKMAN);
    await setGChatId(VENKMAN, "333333333");
    await enqueue([
      { userId: VENKMAN.userId, roomId: "r-retry", messageId: `m1-${crypto.randomUUID()}`,
        snippet: "x", authorName: "S", roomName: "H", createdAt: 1000 },
    ]);

    const fail = spyWebhook({ fail: true });
    try {
      const r1 = await drain();
      expect(r1.failed).toBe(1);
      expect(r1.sent).toBe(0);
    } finally {
      fail.restore();
    }

    // Second drain with a working webhook: row clears.
    const ok = spyWebhook();
    try {
      const r2 = await drain();
      expect(r2.sent).toBe(1);
      expect(ok.calls).toHaveLength(1);
    } finally {
      ok.restore();
    }
  });
});

describe("App /notifications/drain — pre-debounce holdback", () => {
  it("ignores rows whose ready_at is in the future", async () => {
    await touch(VENKMAN);
    await setGChatId(VENKMAN, "444444444");
    // Restore real debounce so ready_at is far in the future.
    await setDebounce(60_000);
    await enqueue([
      { userId: VENKMAN.userId, roomId: "r-future", messageId: `m1-${crypto.randomUUID()}`,
        snippet: "x", authorName: "S", roomName: "H",
        createdAt: Date.now() },
    ]);
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
});
