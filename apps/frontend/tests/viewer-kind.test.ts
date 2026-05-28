/**
 * Pure-function tests for decideKind. Given the HEAD response (content
 * type + size) and optionally the sniffed first-N-bytes for ambiguous
 * cases, pick how the file should be rendered.
 */
import { describe, it, expect } from "vitest";
import { decideKind } from "../src/lib/viewer-kind.js";

const enc = new TextEncoder();
const TEXT_CAP = 256 * 1024;

describe("decideKind", () => {
  it("returns image for any image/* content type, regardless of size", () => {
    expect(decideKind({ contentType: "image/png", size: 10 }, { maxTextBytes: TEXT_CAP })).toBe("image");
    expect(decideKind({ contentType: "image/jpeg", size: 5_000_000 }, { maxTextBytes: TEXT_CAP })).toBe("image");
    expect(decideKind({ contentType: "image/svg+xml", size: 200 }, { maxTextBytes: TEXT_CAP })).toBe("image");
  });

  it("returns text for text/* under the cap", () => {
    expect(decideKind({ contentType: "text/plain; charset=utf-8", size: 1000 }, { maxTextBytes: TEXT_CAP })).toBe("text");
    expect(decideKind({ contentType: "text/markdown", size: 100_000 }, { maxTextBytes: TEXT_CAP })).toBe("text");
  });

  it("returns download for text/* over the cap", () => {
    expect(decideKind({ contentType: "text/plain", size: TEXT_CAP + 1 }, { maxTextBytes: TEXT_CAP })).toBe("download");
  });

  it("returns text for application/json under the cap", () => {
    expect(decideKind({ contentType: "application/json", size: 500 }, { maxTextBytes: TEXT_CAP })).toBe("text");
  });

  it("returns text for unknown content type when sniff says it's text", () => {
    expect(
      decideKind(
        { contentType: "application/octet-stream", size: 100, sniffBytes: enc.encode("hello world\n") },
        { maxTextBytes: TEXT_CAP },
      ),
    ).toBe("text");
  });

  it("returns download for unknown content type when sniff says it's binary", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(
      decideKind(
        { contentType: "application/octet-stream", size: 100, sniffBytes: png },
        { maxTextBytes: TEXT_CAP },
      ),
    ).toBe("download");
  });

  it("returns download for unknown content type with no sniff", () => {
    expect(
      decideKind({ contentType: "application/octet-stream", size: 100 }, { maxTextBytes: TEXT_CAP }),
    ).toBe("download");
  });

  it("returns download for unknown content type over the cap even if sniff would say text", () => {
    expect(
      decideKind(
        {
          contentType: "application/octet-stream",
          size: TEXT_CAP + 1,
          sniffBytes: enc.encode("hello world"),
        },
        { maxTextBytes: TEXT_CAP },
      ),
    ).toBe("download");
  });

  it("returns download for application/pdf and similar binary types", () => {
    expect(decideKind({ contentType: "application/pdf", size: 1000 }, { maxTextBytes: TEXT_CAP })).toBe("download");
  });

  it("returns download for audio / video types", () => {
    expect(decideKind({ contentType: "audio/mpeg", size: 1000 }, { maxTextBytes: TEXT_CAP })).toBe("download");
    expect(decideKind({ contentType: "video/mp4", size: 1000 }, { maxTextBytes: TEXT_CAP })).toBe("download");
  });
});
