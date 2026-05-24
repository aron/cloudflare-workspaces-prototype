/**
 * Pure-function coverage for `src/lib/mentions.ts`. All cursor-position
 * logic is testable as plain string/number math, so we exercise it here
 * rather than in a DOM environment.
 */
import { describe, it, expect } from "vitest";
import {
  tokenize,
  findActiveMention,
  applyMention,
} from "../src/lib/mentions.js";

describe("tokenize", () => {
  it("returns a single text run for plain text", () => {
    expect(tokenize("hello world")).toEqual([
      { type: "text", text: "hello world" },
    ]);
  });

  it("finds mentions and emits them in order", () => {
    expect(tokenize("hi @go and @zig")).toEqual([
      { type: "text",    text: "hi " },
      { type: "mention", raw: "@go",  handle: "go" },
      { type: "text",    text: " and " },
      { type: "mention", raw: "@zig", handle: "zig" },
    ]);
  });

  it("lowercases the handle but preserves the raw casing", () => {
    expect(tokenize("@GoBoss!")).toEqual([
      { type: "mention", raw: "@GoBoss", handle: "goboss" },
      { type: "text",    text: "!" },
    ]);
  });

  it("falls through unknown handles as plain text when a known set is provided", () => {
    const known = new Set(["go"]);
    expect(tokenize("@nobody and @go", known)).toEqual([
      { type: "text",    text: "@nobody and " },
      { type: "mention", raw: "@go", handle: "go" },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(tokenize("")).toEqual([]);
  });
});

describe("findActiveMention", () => {
  it("detects a mention being typed at end of string", () => {
    expect(findActiveMention("hey @go", 7)).toEqual({
      start: 4, end: 7, prefix: "go",
    });
  });

  it("detects an empty mention right after typing `@`", () => {
    expect(findActiveMention("hey @", 5)).toEqual({
      start: 4, end: 5, prefix: "",
    });
  });

  it("returns null when caret is not inside any mention", () => {
    expect(findActiveMention("plain text", 5)).toBeNull();
  });

  it("ignores `@` glued to a preceding word (e.g. emails)", () => {
    expect(findActiveMention("me@example.com", 14)).toBeNull();
  });

  it("treats start-of-string @ as a mention trigger", () => {
    expect(findActiveMention("@go", 3)).toEqual({
      start: 0, end: 3, prefix: "go",
    });
  });

  it("cancels when a space appears between @ and the caret", () => {
    expect(findActiveMention("@go and ", 8)).toBeNull();
  });

  it("uses caret, not end-of-string", () => {
    // Caret sits between @z and ig.
    expect(findActiveMention("@zig", 2)).toEqual({
      start: 0, end: 2, prefix: "z",
    });
  });

  it("lowercases the prefix", () => {
    expect(findActiveMention("@GoB", 4)).toEqual({
      start: 0, end: 4, prefix: "gob",
    });
  });
});

describe("applyMention", () => {
  it("replaces the active region with `@<handle> ` and reports the new caret", () => {
    const active = { start: 4, end: 5, prefix: "" };
    expect(applyMention("hey @ how are you?", active, "go")).toEqual({
      text:  "hey @go  how are you?",
      caret: 8,  // after "hey @go " (8 chars)
    });
  });

  it("preserves text on both sides", () => {
    const active = { start: 0, end: 3, prefix: "go" };
    const r = applyMention("@go and others", active, "go");
    expect(r.text).toBe("@go  and others");
    expect(r.caret).toBe(4);  // after "@go "
  });

  it("works at end of input", () => {
    const active = { start: 4, end: 7, prefix: "zi" };
    const r = applyMention("hey @zi", active, "zig");
    expect(r.text).toBe("hey @zig ");
    expect(r.caret).toBe(9);
  });
});
