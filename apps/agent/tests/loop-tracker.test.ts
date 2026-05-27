/**
 * Pure-function tests for LoopTracker — the per-turn budget and
 * duplicate-call detector that decides when Agent should inject a
 * reflection prompt.
 *
 * Tests run as plain unit tests (no DO, no workerd) because the tracker
 * has no Cloudflare-specific dependencies.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { LoopTracker, type ToolCallRecord } from "../src/loop-tracker.js";

const call = (name: string, input: unknown = {}): ToolCallRecord => ({
  toolName: name,
  input,
});

describe("LoopTracker — step accounting", () => {
  let t: LoopTracker;
  beforeEach(() => {
    t = new LoopTracker({
      readOnlyTools: new Set(["read", "grep", "listDirectory"]),
      reflectionBudget: 5,
      loopWindow: 10,
      loopThreshold: 3,
    });
  });

  it("counts a pure-text step as one unit of budget", () => {
    t.recordStep([]);
    expect(t.spent).toBe(1);
  });

  it("does not spend budget on a step that is entirely read-only", () => {
    t.recordStep([call("read", { path: "/a" }), call("grep", { p: "x" })]);
    expect(t.spent).toBe(0);
  });

  it("spends one unit per non-read tool call in a step", () => {
    t.recordStep([call("edit"), call("write")]);
    expect(t.spent).toBe(2);
  });

  it("mixes read-only and mutating calls: only the mutating ones cost", () => {
    t.recordStep([call("read"), call("edit"), call("grep")]);
    expect(t.spent).toBe(1);
  });
});

describe("LoopTracker — reflection trigger by budget", () => {
  let t: LoopTracker;
  beforeEach(() => {
    t = new LoopTracker({
      readOnlyTools: new Set(["read"]),
      reflectionBudget: 3,
      loopWindow: 10,
      loopThreshold: 99, // disable loop detection for these tests
    });
  });

  it("does not request reflection below the budget", () => {
    t.recordStep([call("edit")]);
    t.recordStep([call("edit")]);
    expect(t.shouldReflect()).toBeNull();
  });

  it("requests reflection once the budget is reached", () => {
    t.recordStep([call("edit")]);
    t.recordStep([call("edit")]);
    t.recordStep([call("edit")]);
    const decision = t.shouldReflect();
    expect(decision).not.toBeNull();
    expect(decision!.kind).toBe("budget");
  });

  it("reads alone never trigger budget reflection", () => {
    for (let i = 0; i < 20; i++) t.recordStep([call("read", { i })]);
    expect(t.shouldReflect()).toBeNull();
  });
});

describe("LoopTracker — loop detection", () => {
  let t: LoopTracker;
  beforeEach(() => {
    t = new LoopTracker({
      readOnlyTools: new Set(),
      reflectionBudget: 999,
      loopWindow: 10,
      loopThreshold: 3,
    });
  });

  it("flags repeated identical calls", () => {
    t.recordStep([call("edit", { path: "/a", text: "x" })]);
    t.recordStep([call("edit", { path: "/a", text: "x" })]);
    t.recordStep([call("edit", { path: "/a", text: "x" })]);
    const decision = t.shouldReflect();
    expect(decision?.kind).toBe("loop");
    expect(decision?.toolName).toBe("edit");
    expect(decision?.count).toBe(3);
  });

  it("does not flag the same tool with different inputs", () => {
    t.recordStep([call("edit", { path: "/a" })]);
    t.recordStep([call("edit", { path: "/b" })]);
    t.recordStep([call("edit", { path: "/c" })]);
    expect(t.shouldReflect()).toBeNull();
  });

  it("forgets calls outside the window", () => {
    t.recordStep([call("edit", { x: 1 })]);
    t.recordStep([call("edit", { x: 1 })]);
    // Push 10 distinct calls to evict the early duplicates.
    for (let i = 0; i < 10; i++) t.recordStep([call("write", { i })]);
    t.recordStep([call("edit", { x: 1 })]);
    expect(t.shouldReflect()).toBeNull();
  });

  it("handles unserializable inputs without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    t.recordStep([{ toolName: "edit", input: circular }]);
    t.recordStep([{ toolName: "edit", input: circular }]);
    t.recordStep([{ toolName: "edit", input: circular }]);
    // All three map to the same unserializable-fallback key, so this
    // still counts as a loop.
    expect(t.shouldReflect()?.kind).toBe("loop");
  });
});

describe("LoopTracker — reset semantics", () => {
  it("reset() clears budget, history, and reflection count", () => {
    const t = new LoopTracker({
      readOnlyTools: new Set(),
      reflectionBudget: 1,
      loopWindow: 10,
      loopThreshold: 3,
    });
    t.recordStep([call("edit")]);
    t.markReflected();
    expect(t.spent).toBe(1);
    expect(t.reflectionsFired).toBe(1);

    t.reset();
    expect(t.spent).toBe(0);
    expect(t.reflectionsFired).toBe(0);
    expect(t.shouldReflect()).toBeNull();
  });
});

describe("LoopTracker — reflection guard", () => {
  it("shouldReflect returns null after maxReflections is reached", () => {
    const t = new LoopTracker({
      readOnlyTools: new Set(),
      reflectionBudget: 1,
      loopWindow: 10,
      loopThreshold: 3,
      maxReflectionsPerTurn: 1,
    });
    t.recordStep([call("edit")]);
    expect(t.shouldReflect()).not.toBeNull();
    t.markReflected();
    // Same conditions, but the guard now blocks.
    expect(t.shouldReflect()).toBeNull();
  });
});

describe("LoopTracker — buildReflectionMessage", () => {
  it("explains the budget reason when over budget", () => {
    const t = new LoopTracker({
      readOnlyTools: new Set(),
      reflectionBudget: 2,
      loopWindow: 10,
      loopThreshold: 99,
    });
    t.recordStep([call("edit")]);
    t.recordStep([call("write")]);
    const decision = t.shouldReflect()!;
    const text = t.buildReflectionMessage(decision);
    expect(text).toMatch(/budget/i);
    expect(text).toMatch(/stuck/i);
  });

  it("names the looping tool when a loop is detected", () => {
    const t = new LoopTracker({
      readOnlyTools: new Set(),
      reflectionBudget: 999,
      loopWindow: 10,
      loopThreshold: 3,
    });
    for (let i = 0; i < 3; i++) {
      t.recordStep([call("edit", { path: "/x" })]);
    }
    const decision = t.shouldReflect()!;
    const text = t.buildReflectionMessage(decision);
    expect(text).toMatch(/edit/);
    expect(text).toMatch(/repeat/i);
  });
});
