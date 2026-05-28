/**
 * Pure-function tests for parseBangInput — turns raw editor input into
 * a discriminated dispatch decision: file-viewer (`!/<path>`), chat
 * message, or invalid bang.
 */
import { describe, it, expect } from "vitest";
import { parseBangInput } from "../src/lib/bang-parser.js";

describe("parseBangInput", () => {
  it("treats !/<path> as a bang with the absolute path", () => {
    expect(parseBangInput("!/foo.png")).toEqual({ kind: "bang", path: "/foo.png" });
    expect(parseBangInput("!/workspace/x")).toEqual({ kind: "bang", path: "/workspace/x" });
  });

  it("tolerates leading whitespace", () => {
    expect(parseBangInput("  !/foo")).toEqual({ kind: "bang", path: "/foo" });
    expect(parseBangInput("\t!/foo")).toEqual({ kind: "bang", path: "/foo" });
  });

  it("rejects bare !/ as invalid (no path)", () => {
    expect(parseBangInput("!/")).toEqual({ kind: "invalid", reason: "empty path" });
  });

  it("rejects !/ followed only by whitespace", () => {
    expect(parseBangInput("!/   ")).toEqual({ kind: "invalid", reason: "empty path" });
  });

  it("rejects paths containing .. segments", () => {
    expect(parseBangInput("!/..")).toEqual({ kind: "invalid", reason: "parent segment" });
    expect(parseBangInput("!/a/../b")).toEqual({ kind: "invalid", reason: "parent segment" });
    expect(parseBangInput("!/foo/..")).toEqual({ kind: "invalid", reason: "parent segment" });
  });

  it("treats ! without a slash as ordinary chat text", () => {
    expect(parseBangInput("!foo")).toEqual({ kind: "chat" });
    expect(parseBangInput("!")).toEqual({ kind: "chat" });
    expect(parseBangInput("!!")).toEqual({ kind: "chat" });
  });

  it("treats text that doesn't start with ! as chat", () => {
    expect(parseBangInput("hello world")).toEqual({ kind: "chat" });
    expect(parseBangInput("foo!")).toEqual({ kind: "chat" });
    expect(parseBangInput("/workspace/x")).toEqual({ kind: "chat" });
    expect(parseBangInput("")).toEqual({ kind: "chat" });
  });

  it("strips trailing whitespace from the path", () => {
    expect(parseBangInput("!/foo.png  ")).toEqual({ kind: "bang", path: "/foo.png" });
  });
});
