/**
 * Pure-function tests for isValidViewerPath. Used by the parser and the
 * autocomplete acceptor — both need the same "does this string identify
 * a file the viewer can fetch" rule.
 */
import { describe, it, expect } from "vitest";
import { isValidViewerPath } from "../src/lib/viewer-path.js";

describe("isValidViewerPath", () => {
  it("accepts absolute paths with at least one segment", () => {
    expect(isValidViewerPath("/x")).toBe(true);
    expect(isValidViewerPath("/workspace/foo.png")).toBe(true);
    expect(isValidViewerPath("/a/b/c")).toBe(true);
  });

  it("rejects relative paths", () => {
    expect(isValidViewerPath("x")).toBe(false);
    expect(isValidViewerPath("a/b")).toBe(false);
    expect(isValidViewerPath("./x")).toBe(false);
  });

  it("rejects empty / root-only paths", () => {
    expect(isValidViewerPath("")).toBe(false);
    expect(isValidViewerPath("/")).toBe(false);
    expect(isValidViewerPath("//")).toBe(false);
  });

  it("rejects paths containing .. segments", () => {
    expect(isValidViewerPath("/..")).toBe(false);
    expect(isValidViewerPath("/a/../b")).toBe(false);
    expect(isValidViewerPath("/foo/..")).toBe(false);
  });

  it("rejects whitespace-only paths", () => {
    expect(isValidViewerPath("/   ")).toBe(false);
  });
});
