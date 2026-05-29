/**
 * Pure unit tests for the notify.ts helpers — snippet trimming, token
 * extraction, and payload construction. No DO involvement.
 */
import { describe, it, expect } from "vitest";
import {
  buildPayload,
  buildSnippet,
  extractMentionedUserIds,
  redactWebhookUrl,
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
  it("strips <mention> tags down to their @handle label", () => {
    expect(buildSnippet(
      'hey <mention type="user" id="abc-123">@bob</mention> ship it',
    )).toBe("hey @bob ship it");
  });
  it("falls back to a generic label when the inner text is empty", () => {
    expect(buildSnippet(
      '<mention type="user" id="abc"></mention> pinged',
    )).toBe("@user pinged");
  });
  it("never leaves a bare angle bracket in the snippet", () => {
    // Google Chat 500s on unknown `<...>` references.
    const out = buildSnippet('a <mention type="agent" id="agent">@agent</mention> b');
    expect(out).not.toMatch(/<mention/);
    expect(out).toBe("a @agent b");
  });
  it("strips legacy <user:ID> tokens down to a generic @user label", () => {
    expect(buildSnippet("hey <user:abc-123> ship it")).toBe("hey @user ship it");
  });
  it("strips legacy <agent:ID> tokens down to a generic @agent label", () => {
    expect(buildSnippet("talk to <agent:agent> about this")).toBe("talk to @agent about this");
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
  it("also pulls ids from legacy <user:ID> tokens", () => {
    expect(extractMentionedUserIds("hi <user:abc> and <user:def>").sort())
      .toEqual(["abc", "def"]);
  });
  it("dedupes across current and legacy formats for the same id", () => {
    const ids = extractMentionedUserIds(
      '<mention type="user" id="abc">@x</mention> and <user:abc>',
    );
    expect(ids).toEqual(["abc"]);
  });
});

describe("buildPayload", () => {
  it("renders the <users/ID> mention, room name, italicised snippet, and link", () => {
    const payload = buildPayload({
      webhookUrl:       "https://chat.googleapis.com/...",
      googleChatUserId: "115736912860088353887",
      roomName:         "Hackspace",
      snippet:          "ship it",
      roomUrl:          "https://hackspace/r/abc",
    });
    expect(payload.text).toContain("<users/115736912860088353887>");
    expect(payload.text).toContain("(Hackspace)");
    // Snippet is italic, not a `>` blockquote (Chat doesn't support `>`).
    expect(payload.text).toContain("_ship it_");
    expect(payload.text).not.toMatch(/\n> /);
    expect(payload.text).toContain("https://hackspace/r/abc");
  });
  it("escapes underscores inside the snippet so italics stay one span", () => {
    const payload = buildPayload({
      webhookUrl:       "x",
      googleChatUserId: "1",
      roomName:         "r",
      snippet:          "hello _world_ ok",
    });
    expect(payload.text).toContain("_hello \\_world\\_ ok_");
  });
  it("omits the snippet line when empty", () => {
    const payload = buildPayload({
      webhookUrl:       "x",
      googleChatUserId: "1",
      roomName:         "r",
      snippet:          "",
    });
    // No italic snippet span and no blockquote. The italic wrapper is
    // `\n_..._` — we just check there's no newline-prefixed underscore.
    expect(payload.text).not.toMatch(/\n_/);
    expect(payload.text).not.toMatch(/\n> /);
  });
});

describe("redactWebhookUrl", () => {
  it("masks key and token query params but keeps the rest of the URL", () => {
    const out = redactWebhookUrl(
      "https://chat.googleapis.com/v1/spaces/AAQ123/messages?key=AIzaSyTOPSECRET&token=WByNiSECRETTOKEN",
    );
    expect(out).toBe(
      "https://chat.googleapis.com/v1/spaces/AAQ123/messages?key=REDACTED&token=REDACTED",
    );
  });
  it("returns an empty string for empty input", () => {
    expect(redactWebhookUrl("")).toBe("");
  });
  it("returns a placeholder for a malformed URL", () => {
    expect(redactWebhookUrl("not a url")).toBe("<invalid-url>");
  });
  it("leaves URLs without key/token alone", () => {
    expect(redactWebhookUrl("https://example.test/hook")).toBe("https://example.test/hook");
  });
});
