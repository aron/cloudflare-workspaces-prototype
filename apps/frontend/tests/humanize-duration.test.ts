/**
 * Tests for the duration humanizer used in the tool-call header. The
 * breakpoints (1s, 1m) are the spec — if the boundaries shift, every
 * place that displays a tool duration in the UI gets a visible jump,
 * so we pin them down here.
 */
import { describe, it, expect } from "vitest";
import { humanizeDuration } from "../src/lib/humanize-duration.js";

describe("humanizeDuration", () => {
  it("renders sub-second values as integer milliseconds", () => {
    expect(humanizeDuration(0)).toBe("0ms");
    expect(humanizeDuration(7)).toBe("7ms");
    expect(humanizeDuration(999)).toBe("999ms");
  });

  it("rounds millisecond values to the nearest integer", () => {
    // Date.now() differences are integers, but performance.now() and
    // the AI SDK's durationMs can be fractional. Strip the noise.
    expect(humanizeDuration(7.4)).toBe("7ms");
    expect(humanizeDuration(7.5)).toBe("8ms");
  });

  it("switches to one-decimal seconds at 1s", () => {
    expect(humanizeDuration(1000)).toBe("1.0s");
    expect(humanizeDuration(1499)).toBe("1.5s");
    expect(humanizeDuration(59_999)).toBe("60.0s");
  });

  it("switches to minutes-and-seconds at 1m", () => {
    expect(humanizeDuration(60_000)).toBe("1m");
    expect(humanizeDuration(61_000)).toBe("1m 1s");
    expect(humanizeDuration(125_000)).toBe("2m 5s");
  });

  it("drops the seconds component when it rounds to zero", () => {
    // 60_400ms is "1m 0s" — confusing to read; we elide the trailing 0s.
    expect(humanizeDuration(60_400)).toBe("1m");
    expect(humanizeDuration(60_500)).toBe("1m 1s");
  });

  it("falls back to 0ms for invalid input", () => {
    expect(humanizeDuration(Number.NaN)).toBe("0ms");
    expect(humanizeDuration(Number.POSITIVE_INFINITY)).toBe("0ms");
    expect(humanizeDuration(-1)).toBe("0ms");
  });
});
