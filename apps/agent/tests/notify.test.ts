/**
 * Pure unit tests for the notify.ts helpers — snippet trimming, token
 * extraction, and payload construction. No DO involvement.
 */
import { describe, it, expect } from "vitest";
import {
  buildPayload,
  buildSnippet,
  extractMentionedUserIds,
} from "../src/notify.js";

describe("buildSnippet", () => {
  it("collapses whitespace and trims", () => {
    expect(buildSnippet("  hello   world  \n\n  ")).toBe("hello world");
  });
  it("returns empty string for whitespace-only input", () => {
    expect(buildSnippet("   \n  ")).toBe("");
  });
  it("clips overly long input with an ellipsis", () => {
    const long = "x".repeat(500);
    const out = buildSnippet(long);
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("extractMentionedUserIds", () => {
  it("pulls unique ids from <mention type=user id=ID> tokens", () => {
    const ids = extractMentionedUserIds(
      'hi <mention type="user" id="abc">@x</mention> and ' +
      '<mention type="user" id="def">@x</mention> and ' +
      '<mention type="user" id="abc">@x</mention>',
    );
    expect(ids.sort()).toEqual(["abc", "def"]);
  });
  it("ignores <mention type=agent> tokens and bare @handles", () => {
    expect(extractMentionedUserIds(
      'hey @bob and <mention type="agent" id="agent">@agent</mention>',
    )).toEqual([]);
  });
  it("returns empty for input with no tokens", () => {
    expect(extractMentionedUserIds("plain text")).toEqual([]);
  });
});

describe("buildPayload", () => {
  it("includes a <users/ID> mention, the recipient name, and the snippet", () => {
    const payload = buildPayload({
      webhookUrl:       "https://chat.googleapis.com/...",
      googleChatUserId: "115736912860088353887",
      recipientName:    "Acarroll",
      roomName:         "Hackspace",
      snippet:          "ship it",
      roomUrl:          "https://hackspace/r/abc",
    });
    expect(payload.text).toContain("<users/115736912860088353887>");
    expect(payload.text).toContain("Acarroll");
    expect(payload.text).toContain("Hackspace");
    expect(payload.text).toContain("> ship it");
    expect(payload.text).toContain("https://hackspace/r/abc");
  });
  it("omits the snippet line when empty", () => {
    const payload = buildPayload({
      webhookUrl:       "x",
      googleChatUserId: "1",
      recipientName:    "n",
      roomName:         "r",
      snippet:          "",
    });
    expect(payload.text).not.toContain("\n> ");
  });
});
