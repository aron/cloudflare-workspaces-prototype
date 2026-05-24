/**
 * Pure tests for the URL route parser. The client uses the URL as the only
 * source of truth for navigation state — no localStorage. We need a tiny
 * deterministic parser that maps pathname → route variant.
 */
import { describe, it, expect } from "vitest";
import { parseRoute, formatRoute, type Route } from "../src/client/route.js";

describe("parseRoute", () => {
  it("maps / to the room picker", () => {
    expect(parseRoute("/")).toEqual({ kind: "picker" });
  });

  it("maps an empty path to the room picker", () => {
    expect(parseRoute("")).toEqual({ kind: "picker" });
  });

  it("maps /rooms/:id to a room view", () => {
    expect(parseRoute("/rooms/abc-123")).toEqual({ kind: "room", roomId: "abc-123" });
  });

  it("maps /rooms/:id/threads/:tid to a thread view", () => {
    expect(parseRoute("/rooms/abc-123/threads/t-9")).toEqual({
      kind:     "thread",
      roomId:   "abc-123",
      threadId: "t-9",
    });
  });

  it("tolerates a trailing slash", () => {
    expect(parseRoute("/rooms/abc-123/")).toEqual({ kind: "room", roomId: "abc-123" });
  });

  it("falls back to the picker for unknown shapes", () => {
    expect(parseRoute("/whatever")).toEqual({ kind: "picker" });
    expect(parseRoute("/rooms")).toEqual({ kind: "picker" });
    expect(parseRoute("/rooms//threads/x")).toEqual({ kind: "picker" });
  });
});

describe("formatRoute", () => {
  it("round-trips picker → /", () => {
    expect(formatRoute({ kind: "picker" })).toBe("/");
  });

  it("round-trips room → /rooms/:id", () => {
    expect(formatRoute({ kind: "room", roomId: "abc" })).toBe("/rooms/abc");
  });

  it("round-trips thread → /rooms/:id/threads/:tid", () => {
    expect(formatRoute({ kind: "thread", roomId: "abc", threadId: "t1" })).toBe("/rooms/abc/threads/t1");
  });

  it("is the inverse of parseRoute for all variants", () => {
    const routes: Route[] = [
      { kind: "picker" },
      { kind: "room",   roomId:  "r-1" },
      { kind: "thread", roomId:  "r-1", threadId: "t-2" },
    ];
    for (const r of routes) {
      expect(parseRoute(formatRoute(r))).toEqual(r);
    }
  });
});
