/**
 * Pure-function tests for src/mentions.ts. No DOs, no bindings.
 */
import { describe, it, expect } from "vitest";
import { extractMentions, firstMention, resolvePersonaForTurn } from "../src/mentions.js";

describe("extractMentions", () => {
  it("returns an empty list when no mentions are present", () => {
    expect(extractMentions("hello world")).toEqual([]);
  });

  it("finds a single known persona", () => {
    expect(extractMentions("hey @go can you help?")).toEqual(["go"]);
  });

  it("ignores unknown personas", () => {
    expect(extractMentions("talking about @nobody-here")).toEqual([]);
  });

  it("de-duplicates repeated mentions, first wins", () => {
    expect(extractMentions("@go @go again")).toEqual(["go"]);
  });

  it("preserves document order for multiple distinct mentions", () => {
    expect(extractMentions("@zig then @go please")).toEqual(["zig", "go"]);
  });

  it("is case-insensitive on the trigger but normalizes to lowercase", () => {
    expect(extractMentions("@GO @Zig")).toEqual(["go", "zig"]);
  });
});

describe("firstMention", () => {
  it("returns null when none match", () => {
    expect(firstMention("plain text")).toBeNull();
  });
  it("returns the first known persona", () => {
    expect(firstMention("ping @zig and @go")).toBe("zig");
  });
});

describe("resolvePersonaForTurn", () => {
  it("returns the default when no user message mentions a persona", () => {
    const messages = [
      { role: "user",      parts: [{ type: "text", text: "hello" }] },
      { role: "assistant", parts: [{ type: "text", text: "hi" }] },
    ];
    expect(resolvePersonaForTurn(messages, "go")).toBe("go");
  });

  it("uses the most recent user mention", () => {
    const messages = [
      { role: "user",      parts: [{ type: "text", text: "@zig start" }] },
      { role: "assistant", parts: [{ type: "text", text: "working on it" }] },
      { role: "user",      parts: [{ type: "text", text: "@go take over" }] },
    ];
    expect(resolvePersonaForTurn(messages, "zig")).toBe("go");
  });

  it("ignores mentions in assistant messages", () => {
    const messages = [
      { role: "user",      parts: [{ type: "text", text: "@zig start" }] },
      { role: "assistant", parts: [{ type: "text", text: "let's bring in @go" }] },
    ];
    expect(resolvePersonaForTurn(messages, "cloudflare-worker")).toBe("zig");
  });

  it("walks backwards past user messages that don't mention anyone", () => {
    const messages = [
      { role: "user",      parts: [{ type: "text", text: "@go please" }] },
      { role: "assistant", parts: [{ type: "text", text: "ok" }] },
      { role: "user",      parts: [{ type: "text", text: "thanks" }] },
    ];
    expect(resolvePersonaForTurn(messages, "zig")).toBe("go");
  });

  it("falls back to default for an empty history", () => {
    expect(resolvePersonaForTurn([], "cloudflare-worker")).toBe("cloudflare-worker");
  });
});
