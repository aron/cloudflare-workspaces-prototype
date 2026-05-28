/**
 * Pure-function tests for splitStreamingTools — the helper Agent's
 * constructor uses to patch Think's `_wrapToolsWithDecision`.
 *
 * Given a ToolSet and a set of streaming-tool names, returns a wrapper
 * function that splits the input into a streaming subset (passed
 * through untouched) and a wrappable subset (run through the original
 * Think wrapper). The order matters: streaming tools must NOT be
 * wrapped, because Think's default wrapper drains AsyncIterable
 * results to their last value, which defeats streaming.
 */
import { describe, it, expect, vi } from "vitest";
import { splitStreamingTools } from "../src/streaming-tools.js";

describe("splitStreamingTools", () => {
  it("passes streaming tools through without calling the original wrapper", () => {
    const original = vi.fn(() => ({ wrapped: true }));
    const wrap = splitStreamingTools(new Set(["exec"]), original);
    const exec = { execute: async function* () { yield 1; } };
    const out = wrap({ exec });
    // exec untouched, original called with the empty remainder.
    expect(out.exec).toBe(exec);
    expect(original).toHaveBeenCalledWith({});
  });

  it("routes non-streaming tools through the original wrapper", () => {
    const original = vi.fn((tools: Record<string, unknown>) => {
      const out: Record<string, unknown> = {};
      for (const [n, t] of Object.entries(tools)) out[n] = { wrapped: t };
      return out;
    });
    const wrap = splitStreamingTools(new Set(["exec"]), original);
    const read = { execute: async () => "ok" };
    const out = wrap({ read });
    expect(out.read).toEqual({ wrapped: read });
  });

  it("splits a mixed tool set correctly", () => {
    const original = vi.fn((tools: Record<string, unknown>) => tools);
    const wrap = splitStreamingTools(new Set(["exec", "watch"]), original);
    const exec  = { id: "exec" };
    const watch = { id: "watch" };
    const read  = { id: "read" };
    const out = wrap({ exec, watch, read });
    expect(out.exec).toBe(exec);
    expect(out.watch).toBe(watch);
    expect(out.read).toBe(read);
    expect(original).toHaveBeenCalledWith({ read });
  });

  it("handles an empty streaming set by delegating everything", () => {
    const original = vi.fn((tools: Record<string, unknown>) => tools);
    const wrap = splitStreamingTools(new Set(), original);
    const exec = { id: "exec" };
    const out = wrap({ exec });
    expect(out.exec).toBe(exec);
    expect(original).toHaveBeenCalledWith({ exec });
  });

  it("handles an empty tool set", () => {
    const original = vi.fn(() => ({}));
    const wrap = splitStreamingTools(new Set(["exec"]), original);
    expect(wrap({})).toEqual({});
    expect(original).toHaveBeenCalledWith({});
  });
});
