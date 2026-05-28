/**
 * Pure-function tests for guessMimeType — used by the agent's
 * /files/* route to label served workspace bytes with a sensible
 * Content-Type without pulling in a 50KB MIME database.
 */
import { describe, it, expect } from "vitest";
import { guessMimeType } from "../src/mime.js";

describe("guessMimeType", () => {
  it("returns image/png for .png", () => {
    expect(guessMimeType("/workspace/foo.png")).toBe("image/png");
  });

  it("returns image/jpeg for .jpg and .jpeg", () => {
    expect(guessMimeType("a.jpg")).toBe("image/jpeg");
    expect(guessMimeType("a.jpeg")).toBe("image/jpeg");
  });

  it("returns image/svg+xml for .svg", () => {
    expect(guessMimeType("/x/y.svg")).toBe("image/svg+xml");
  });

  it("returns text/markdown for .md", () => {
    expect(guessMimeType("README.md")).toBe("text/markdown; charset=utf-8");
  });

  it("returns application/json for .json", () => {
    expect(guessMimeType("data.json")).toBe("application/json; charset=utf-8");
  });

  it("returns text/plain for .txt", () => {
    expect(guessMimeType("notes.txt")).toBe("text/plain; charset=utf-8");
  });

  it("returns text/plain for source files without a known type", () => {
    expect(guessMimeType("script.ts")).toBe("text/plain; charset=utf-8");
    expect(guessMimeType("main.go")).toBe("text/plain; charset=utf-8");
    expect(guessMimeType("Makefile")).toBe("text/plain; charset=utf-8");
  });

  it("returns application/octet-stream for binary files without a known type", () => {
    expect(guessMimeType("blob.bin")).toBe("application/octet-stream");
    expect(guessMimeType("file.unknownext")).toBe("application/octet-stream");
  });

  it("is case-insensitive on the extension", () => {
    expect(guessMimeType("FOO.PNG")).toBe("image/png");
    expect(guessMimeType("DOC.PDF")).toBe("application/pdf");
  });

  it("returns application/pdf for .pdf", () => {
    expect(guessMimeType("a.pdf")).toBe("application/pdf");
  });

  it("handles a few common audio/video types", () => {
    expect(guessMimeType("a.mp3")).toBe("audio/mpeg");
    expect(guessMimeType("a.mp4")).toBe("video/mp4");
    expect(guessMimeType("a.webm")).toBe("video/webm");
    expect(guessMimeType("a.wav")).toBe("audio/wav");
  });
});
