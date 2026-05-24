/**
 * Pure-helper tests for the formatting utilities the UI uses. These are
 * tiny functions but trivial to break — they handle untrusted input
 * (names from the IdP, server timestamps) so the regression coverage is
 * worth its weight.
 */
import { describe, it, expect } from "vitest";
import { initials, relTime } from "../src/lib/utils.js";

describe("initials", () => {
  it("returns two-letter initials for a two-part name", () => {
    expect(initials("Venkman Stantz")).toBe("VS");
  });
  it("uses the first two letters for a single-word name", () => {
    expect(initials("Venkman")).toBe("VE");
  });
  it("uppercases", () => {
    expect(initials("venkman stantz")).toBe("VS");
  });
  it("ignores extra parts beyond the second", () => {
    expect(initials("First Middle Last")).toBe("FM");
  });
  it("returns ? for an empty name", () => {
    expect(initials("")).toBe("?");
  });
});

describe("relTime", () => {
  const NOW = 1_700_000_000_000;
  it("renders 'just now' under a minute", () => {
    expect(relTime(NOW - 30_000, NOW)).toBe("just now");
  });
  it("renders minutes", () => {
    expect(relTime(NOW - 5 * 60_000, NOW)).toBe("5m ago");
  });
  it("renders hours", () => {
    expect(relTime(NOW - 3 * 3600_000, NOW)).toBe("3h ago");
  });
  it("renders 'yesterday' for 1 day", () => {
    expect(relTime(NOW - 24 * 3600_000, NOW)).toBe("yesterday");
  });
  it("renders days for 2–6", () => {
    expect(relTime(NOW - 3 * 24 * 3600_000, NOW)).toBe("3d ago");
  });
  it("falls back to a date for older timestamps", () => {
    const out = relTime(NOW - 30 * 24 * 3600_000, NOW);
    expect(out).toMatch(/\d/);  // contains a digit; locale-dependent format
    expect(out).not.toMatch(/ago/);
  });
});
