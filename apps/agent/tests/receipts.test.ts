/**
 * App — read receipts + activity tips (T1).
 *
 * Covers:
 *   - PUT /me/receipts is monotonic (a stale lastRead can't roll back).
 *   - GET /me/receipts returns the caller's receipts plus all tips.
 *   - POST /activity bumps room.last_activity_at and thread_activity rows,
 *     and is also monotonic on the tip side.
 *   - Receipts are scoped per user.
 */
import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { asUser, VENKMAN, STANTZ } from "./identity.js";
import type { ActivityTip, ReadReceipt } from "@app/shared";

function appStub() {
  return env.App.get(env.App.idFromName("app"));
}

async function putReceipt(user: typeof VENKMAN, scope: "room" | "thread", scopeId: string, lastRead: number) {
  const res = await appStub().fetch(
    asUser("https://app/me/receipts", user, {
      method:  "PUT",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ scope, scopeId, lastRead }),
    }),
  );
  return res;
}

async function getReceipts(user: typeof VENKMAN) {
  const res = await appStub().fetch(asUser("https://app/me/receipts", user));
  expect(res.status).toBe(200);
  return await res.json() as { receipts: ReadReceipt[]; tips: ActivityTip[] };
}

async function postActivity(body: object) {
  // /activity is identity-less (DO-to-DO). Hit it directly without asUser.
  return await appStub().fetch(new Request("https://app/activity", {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify(body),
  }));
}

describe("App /me/receipts", () => {
  it("stores and returns a receipt", async () => {
    const ok = await putReceipt(VENKMAN, "room", "room-a", 1000);
    expect(ok.status).toBe(200);
    const { receipts } = await getReceipts(VENKMAN);
    const r = receipts.find(x => x.scope === "room" && x.scopeId === "room-a");
    expect(r?.lastRead).toBe(1000);
  });

  it("is monotonic — a stale lastRead never overwrites a newer one", async () => {
    await putReceipt(VENKMAN, "thread", "thread-mono", 2000);
    await putReceipt(VENKMAN, "thread", "thread-mono", 1500);  // stale
    const { receipts } = await getReceipts(VENKMAN);
    const r = receipts.find(x => x.scope === "thread" && x.scopeId === "thread-mono");
    expect(r?.lastRead).toBe(2000);
  });

  it("advances when given a newer lastRead", async () => {
    await putReceipt(VENKMAN, "thread", "thread-adv", 1000);
    await putReceipt(VENKMAN, "thread", "thread-adv", 3000);
    const { receipts } = await getReceipts(VENKMAN);
    const r = receipts.find(x => x.scope === "thread" && x.scopeId === "thread-adv");
    expect(r?.lastRead).toBe(3000);
  });

  it("scopes receipts per user", async () => {
    await putReceipt(VENKMAN, "room", "shared-room", 5000);
    const v = await getReceipts(VENKMAN);
    const s = await getReceipts(STANTZ);
    expect(v.receipts.find(r => r.scopeId === "shared-room")?.lastRead).toBe(5000);
    expect(s.receipts.find(r => r.scopeId === "shared-room")).toBeUndefined();
  });

  it("rejects malformed bodies", async () => {
    const bad = await appStub().fetch(asUser("https://app/me/receipts", VENKMAN, {
      method:  "PUT",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ scope: "nope", scopeId: "x", lastRead: 1 }),
    }));
    expect(bad.status).toBe(400);
  });

  it("requires identity", async () => {
    const res = await appStub().fetch(new Request("https://app/me/receipts"));
    expect(res.status).toBe(401);
  });
});

describe("App /activity", () => {
  it("bumps the room tip and is monotonic", async () => {
    // Create a real room so the rooms row exists for the UPDATE to land on.
    const created = await appStub().fetch(asUser("https://app/rooms", VENKMAN, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ name: "Tip Room" }),
    }));
    const { room } = await created.json() as { room: { id: string } };

    const ok = await postActivity({ scope: "room", scopeId: room.id, lastActivity: 10_000 });
    expect(ok.status).toBe(200);
    let tips = (await getReceipts(VENKMAN)).tips;
    expect(tips.find(t => t.scope === "room" && t.scopeId === room.id)?.lastActivity).toBe(10_000);

    // Stale write: ignored.
    await postActivity({ scope: "room", scopeId: room.id, lastActivity: 5_000 });
    tips = (await getReceipts(VENKMAN)).tips;
    expect(tips.find(t => t.scope === "room" && t.scopeId === room.id)?.lastActivity).toBe(10_000);

    // Newer write: advances.
    await postActivity({ scope: "room", scopeId: room.id, lastActivity: 20_000 });
    tips = (await getReceipts(VENKMAN)).tips;
    expect(tips.find(t => t.scope === "room" && t.scopeId === room.id)?.lastActivity).toBe(20_000);
  });

  it("upserts thread tips and tracks roomId", async () => {
    await postActivity({ scope: "thread", scopeId: "t-1", roomId: "r-1", lastActivity: 1_000 });
    await postActivity({ scope: "thread", scopeId: "t-1", roomId: "r-1", lastActivity: 500 });   // stale
    await postActivity({ scope: "thread", scopeId: "t-1", roomId: "r-1", lastActivity: 2_000 });
    const tips = (await getReceipts(VENKMAN)).tips;
    const tip = tips.find(t => t.scope === "thread" && t.scopeId === "t-1");
    expect(tip?.lastActivity).toBe(2_000);
    expect(tip?.roomId).toBe("r-1");
  });

  it("rejects thread activity without a roomId", async () => {
    const res = await postActivity({ scope: "thread", scopeId: "t-x", lastActivity: 1 });
    expect(res.status).toBe(400);
  });

  it("rejects malformed bodies", async () => {
    const res = await postActivity({ scope: "junk", scopeId: "x", lastActivity: 1 });
    expect(res.status).toBe(400);
  });
});
