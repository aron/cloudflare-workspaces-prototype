/**
 * Per-user settings API (Google Chat user ID storage).
 * internal endpoint that Room DO calls to resolve mention recipients.
 */
import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { asUser, VENKMAN, STANTZ } from "./identity.js";

function appStub() {
  return env.App.get(env.App.idFromName("app"));
}

async function touch(user = VENKMAN) {
  // /me upserts the user row, which is what we need before settings reads work.
  await appStub().fetch(asUser("https://app/me", user));
}

describe("App /me/settings", () => {
  it("returns null when nothing has been saved yet", async () => {
    await touch(VENKMAN);
    const res = await appStub().fetch(asUser("https://app/me/settings", VENKMAN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ googleChatUserId: null });
  });

  it("persists a valid Google Chat user ID and reads it back", async () => {
    await touch(VENKMAN);
    const put = await appStub().fetch(asUser("https://app/me/settings", VENKMAN, {
      method:  "PUT",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ googleChatUserId: "115736912860088353887" }),
    }));
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ googleChatUserId: "115736912860088353887" });

    const get = await appStub().fetch(asUser("https://app/me/settings", VENKMAN));
    expect(await get.json()).toEqual({ googleChatUserId: "115736912860088353887" });
  });

  it("rejects non-numeric IDs", async () => {
    await touch(VENKMAN);
    const res = await appStub().fetch(asUser("https://app/me/settings", VENKMAN, {
      method:  "PUT",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ googleChatUserId: "not-a-number" }),
    }));
    expect(res.status).toBe(400);
  });

  it("clears the value when given null", async () => {
    await touch(VENKMAN);
    await appStub().fetch(asUser("https://app/me/settings", VENKMAN, {
      method:  "PUT",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ googleChatUserId: "123456789" }),
    }));
    const put = await appStub().fetch(asUser("https://app/me/settings", VENKMAN, {
      method:  "PUT",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ googleChatUserId: null }),
    }));
    expect(await put.json()).toEqual({ googleChatUserId: null });
  });

  it("scopes per-user — STANTZ can't see VENKMAN's setting", async () => {
    await touch(VENKMAN);
    await touch(STANTZ);
    await appStub().fetch(asUser("https://app/me/settings", VENKMAN, {
      method:  "PUT",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ googleChatUserId: "999999999" }),
    }));
    const res = await appStub().fetch(asUser("https://app/me/settings", STANTZ));
    expect(await res.json()).toEqual({ googleChatUserId: null });
  });
});
