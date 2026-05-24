/**
 * AppDO — regression coverage for Phase 2 (already implemented).
 * These tests should pass without any further code changes.
 */
import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { asUser, ARON, BEA } from "./identity.js";

function appStub() {
  return env.AppDO.get(env.AppDO.idFromName("app"));
}

describe("AppDO /me", () => {
  it("echoes the caller's identity and current model", async () => {
    const res = await appStub().fetch(asUser("https://app/me", ARON));
    expect(res.status).toBe(200);
    const body = await res.json() as { userId: string; email: string; name: string; model: string };
    expect(body.userId).toBe(ARON.userId);
    expect(body.email).toBe(ARON.email);
    expect(body.name).toBe(ARON.name);
    // Test env has no OPENAI_API_KEY, so we fall back to the Workers AI default.
    expect(body.model).toBe("kimi-k2.6");
  });

  it("rejects requests without identity headers with 401", async () => {
    const res = await appStub().fetch(new Request("https://app/me"));
    expect(res.status).toBe(401);
  });
});

describe("AppDO /rooms", () => {
  it("starts with an empty room list", async () => {
    const res = await appStub().fetch(asUser("https://app/rooms", ARON));
    expect(res.status).toBe(200);
    const body = await res.json() as { rooms: unknown[] };
    expect(body.rooms).toEqual([]);
  });

  it("creates a room and records the creator", async () => {
    const created = await appStub().fetch(
      asUser("https://app/rooms", ARON, {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ name: "Hackspace" }),
      }),
    );
    expect(created.status).toBe(201);
    const { room } = await created.json() as { room: { id: string; name: string; createdBy: string } };
    expect(room.name).toBe("Hackspace");
    expect(room.createdBy).toBe(ARON.userId);
    expect(room.id).toMatch(/^[0-9a-f-]{36}$/);

    const list = await appStub().fetch(asUser("https://app/rooms", BEA));
    const { rooms } = await list.json() as { rooms: Array<{ id: string }> };
    expect(rooms.map(r => r.id)).toContain(room.id);
  });

  it("rejects empty room names", async () => {
    const res = await appStub().fetch(
      asUser("https://app/rooms", ARON, {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ name: "   " }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects names longer than 80 chars", async () => {
    const res = await appStub().fetch(
      asUser("https://app/rooms", ARON, {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ name: "x".repeat(81) }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
