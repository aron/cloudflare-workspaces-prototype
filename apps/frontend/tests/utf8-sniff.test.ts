/**
 * Pure-function tests for looksLikeUtf8Text. The viewer's HEAD response
 * gives a Content-Type that's often `application/octet-stream` for
 * extensionless or unknown files (Makefile, .env, .lock, etc.). Sniffing
 * the first few KiB lets us render those as text without bloating the
 * server's MIME table.
 */
import { describe, it, expect } from "vitest";
import { looksLikeUtf8Text } from "../src/lib/utf8-sniff.js";

const enc = new TextEncoder();

describe("looksLikeUtf8Text", () => {
  it("treats empty input as text", () => {
    // An empty file rendered as <pre> is fine — and definitely not binary.
    expect(looksLikeUtf8Text(new Uint8Array(0))).toBe(true);
  });

  it("accepts plain ASCII", () => {
    expect(looksLikeUtf8Text(enc.encode("hello\nworld"))).toBe(true);
  });

  it("accepts UTF-8 multibyte characters", () => {
    expect(looksLikeUtf8Text(enc.encode("café"))).toBe(true);
    expect(looksLikeUtf8Text(enc.encode("中文"))).toBe(true);
    expect(looksLikeUtf8Text(enc.encode("🚀 emoji"))).toBe(true);
  });

  it("rejects content with a NUL byte", () => {
    const bytes = new Uint8Array([0x68, 0x69, 0x00, 0x6f]); // "hi\0o"
    expect(looksLikeUtf8Text(bytes)).toBe(false);
  });

  it("rejects a PNG header", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(looksLikeUtf8Text(png)).toBe(false);
  });

  it("rejects content with too many control bytes", () => {
    // 10 printable + 10 control (under 90% printable threshold)
    const bytes = new Uint8Array([
      ...enc.encode("hello world"),
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x0b, 0x0c,
    ]);
    expect(looksLikeUtf8Text(bytes)).toBe(false);
  });

  it("accepts content with tab/newline/CR as printable", () => {
    expect(looksLikeUtf8Text(enc.encode("a\tb\nc\r\nd"))).toBe(true);
  });

  it("rejects invalid UTF-8 byte sequences", () => {
    // Lone continuation byte (0x80) is not valid UTF-8 at the start.
    const bytes = new Uint8Array([0x80, 0x80, 0x80]);
    expect(looksLikeUtf8Text(bytes)).toBe(false);
  });

  it("accepts a real-world Makefile snippet", () => {
    const makefile = `.PHONY: all clean\n\nall:\n\tnpm run build\n\nclean:\n\trm -rf dist\n`;
    expect(looksLikeUtf8Text(enc.encode(makefile))).toBe(true);
  });
});
