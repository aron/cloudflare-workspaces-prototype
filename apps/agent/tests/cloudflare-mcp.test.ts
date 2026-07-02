/**
 * Unit tests for the pure Cloudflare-MCP helpers: resolving the last user
 * author (whose token we use) and rendering connection status.
 */
import { describe, it, expect } from "vitest";
import {
  cloudflareServerId,
  cloudflareToolPrefix,
  describeConnection,
  gateCloudflareTools,
  lastUserAuthorId,
  userIdFromServerId,
} from "../src/cloudflare-mcp.js";

function userMsg(id: string, authorId?: string) {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text: "hi" }],
    ...(authorId
      ? { metadata: { author: { kind: "user", id: authorId } } }
      : {}),
  };
}

function assistantMsg(id: string) {
  return { id, role: "assistant", parts: [{ type: "text", text: "ok" }] };
}

describe("lastUserAuthorId", () => {
  it("returns the author of the most recent user message", () => {
    const msgs = [
      userMsg("m1", "user-A"),
      assistantMsg("m2"),
      userMsg("m3", "user-B"),
      assistantMsg("m4"),
    ];
    // B spoke last → B's token.
    expect(lastUserAuthorId(msgs as never)).toBe("user-B");
  });

  it("ignores assistant messages when scanning", () => {
    const msgs = [userMsg("m1", "user-A"), assistantMsg("m2")];
    expect(lastUserAuthorId(msgs as never)).toBe("user-A");
  });

  it("returns null when no user message carries an author id", () => {
    expect(lastUserAuthorId([userMsg("m1")] as never)).toBeNull();
    expect(lastUserAuthorId([assistantMsg("m1")] as never)).toBeNull();
    expect(lastUserAuthorId([] as never)).toBeNull();
  });
});

describe("describeConnection", () => {
  it("reports disconnected when no server row exists", () => {
    expect(describeConnection(undefined)).toEqual({ state: "disconnected" });
  });

  it("surfaces the auth url while authenticating", () => {
    expect(
      describeConnection({
        state: "authenticating",
        auth_url: "https://auth.example/x",
        error: null,
      }),
    ).toEqual({ state: "authenticating", authUrl: "https://auth.example/x" });
  });

  it("reports ready", () => {
    expect(
      describeConnection({ state: "ready", auth_url: null, error: null }),
    ).toEqual({ state: "ready" });
  });

  it("reports failed with the error", () => {
    expect(
      describeConnection({ state: "failed", auth_url: null, error: "boom" }),
    ).toEqual({ state: "failed", error: "boom" });
  });

  it("treats other states as connecting", () => {
    expect(
      describeConnection({ state: "discovering", auth_url: null, error: null }),
    ).toEqual({ state: "connecting" });
  });
});

describe("server id <-> user id", () => {
  it("round-trips a user id through the server id", () => {
    expect(cloudflareServerId("user-A")).toBe("cloudflare-user-A");
    expect(userIdFromServerId("cloudflare-user-A")).toBe("user-A");
  });
  it("returns the input unchanged when it lacks the prefix", () => {
    expect(userIdFromServerId("something-else")).toBe("something-else");
  });
});

describe("gateCloudflareTools", () => {
  it("keeps only the current user's Cloudflare tools, plus all non-Cloudflare", () => {
    const prefixA = cloudflareToolPrefix("usera");
    const prefixB = cloudflareToolPrefix("userb");
    const keys = [
      "read",
      "exec",
      "schedule",
      `${prefixA}search`,
      `${prefixA}execute`,
      `${prefixB}search`,
    ];
    const kept = gateCloudflareTools(keys, "usera");
    expect(kept).toContain("read");
    expect(kept).toContain("exec");
    expect(kept).toContain("schedule");
    expect(kept).toContain(`${prefixA}search`);
    expect(kept).toContain(`${prefixA}execute`);
    // B's Cloudflare tool is dropped from A's turn.
    expect(kept).not.toContain(`${prefixB}search`);
  });

  it("drops all Cloudflare tools when there is no identified user", () => {
    const prefixA = cloudflareToolPrefix("usera");
    const keys = ["read", `${prefixA}search`];
    expect(gateCloudflareTools(keys, null)).toEqual(["read"]);
  });
});
