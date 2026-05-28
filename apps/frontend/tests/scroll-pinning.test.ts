/**
 * Tests for the scroll predicates that drive the chat panel's
 * auto-scroll + "jump to bottom" button. The thresholds (4px fudge for
 * "at bottom", one viewport for "show the button") are the spec \u2014 if
 * they shift, every chat user notices.
 */
import { describe, it, expect } from "vitest";
import {
  isAtBottom,
  isMoreThanOneViewportFromBottom,
  type ScrollMetrics,
} from "../src/lib/scroll-pinning.js";

/** Build a metrics object with the bottom gap explicitly given. */
function metrics(opts: { gap: number; clientHeight?: number; scrollHeight?: number }): ScrollMetrics {
  const clientHeight = opts.clientHeight ?? 600;
  const scrollHeight = opts.scrollHeight ?? 4000;
  // gap = scrollHeight - scrollTop - clientHeight  =>  scrollTop = scrollHeight - clientHeight - gap
  const scrollTop = scrollHeight - clientHeight - opts.gap;
  return { scrollTop, scrollHeight, clientHeight };
}

describe("isAtBottom", () => {
  it("is true when the viewport bottom is exactly at the content bottom", () => {
    expect(isAtBottom(metrics({ gap: 0 }))).toBe(true);
  });

  it("is true within the 4px fudge factor", () => {
    // Sub-pixel scroll positions drift on hi-DPI \u2014 1\u20133px gaps are
    // routine during a wheel scroll's inertial tail. Don't unpin for
    // those.
    expect(isAtBottom(metrics({ gap: 1 }))).toBe(true);
    expect(isAtBottom(metrics({ gap: 4 }))).toBe(true);
  });

  it("is false beyond the 4px fudge factor", () => {
    expect(isAtBottom(metrics({ gap: 5 }))).toBe(false);
    expect(isAtBottom(metrics({ gap: 100 }))).toBe(false);
  });

  it("is true when the content fits in the viewport (nothing to scroll)", () => {
    // Short threads: scrollHeight === clientHeight, scrollTop === 0.
    // The user is necessarily at the bottom because there's no
    // scrollback to be at.
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 400, clientHeight: 600 })).toBe(true);
  });
});

describe("isMoreThanOneViewportFromBottom", () => {
  it("is false when the gap is exactly one viewport", () => {
    // Strict > so a gap of exactly clientHeight doesn't trigger the
    // button \u2014 you can still see the bottom message in the viewport.
    expect(isMoreThanOneViewportFromBottom(metrics({ gap: 600 }))).toBe(false);
  });

  it("is true once the gap exceeds one viewport", () => {
    expect(isMoreThanOneViewportFromBottom(metrics({ gap: 601 }))).toBe(true);
    expect(isMoreThanOneViewportFromBottom(metrics({ gap: 1200 }))).toBe(true);
  });

  it("is false near the bottom", () => {
    expect(isMoreThanOneViewportFromBottom(metrics({ gap: 0 }))).toBe(false);
    expect(isMoreThanOneViewportFromBottom(metrics({ gap: 200 }))).toBe(false);
  });

  it("respects different viewport heights", () => {
    // On a tall monitor (1000px viewport) the threshold is also 1000px.
    expect(isMoreThanOneViewportFromBottom(metrics({ gap: 999, clientHeight: 1000, scrollHeight: 5000 }))).toBe(false);
    expect(isMoreThanOneViewportFromBottom(metrics({ gap: 1001, clientHeight: 1000, scrollHeight: 5000 }))).toBe(true);
  });

  it("is false when there's nothing to scroll", () => {
    expect(isMoreThanOneViewportFromBottom({ scrollTop: 0, scrollHeight: 400, clientHeight: 600 })).toBe(false);
  });
});
