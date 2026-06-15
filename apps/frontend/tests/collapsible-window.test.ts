/**
 * Tests for the rolling open-by-default window on the thread panel's
 * reasoning + tool boxes. Three cases matter most:
 *
 *   - "newest N stays open" — the core invariant. The sliding window
 *     follows render order, so a fresh part pushes the oldest out.
 *   - Non-collapsible parts (text, exec) don't consume window slots.
 *   - Only assistant messages contribute. User messages have no
 *     collapsible bodies, but their parts shouldn't crowd the window.
 */
import { describe, it, expect } from "vitest";
import {
  collapsibleWindow,
  isCollapsiblePart,
  partKey,
  type CollapsibleMessage,
} from "../src/lib/collapsible-window.js";

function asst(id: string, types: string[]): CollapsibleMessage {
  return { id, role: "assistant", parts: types.map((type) => ({ type })) };
}

function user(id: string, types: string[]): CollapsibleMessage {
  return { id, role: "user", parts: types.map((type) => ({ type })) };
}

describe("isCollapsiblePart", () => {
  it("recognises reasoning as collapsible", () => {
    expect(isCollapsiblePart("reasoning")).toBe(true);
  });

  it("recognises generic tool parts as collapsible", () => {
    expect(isCollapsiblePart("tool-read")).toBe(true);
    expect(isCollapsiblePart("tool-grep")).toBe(true);
    expect(isCollapsiblePart("tool-websearch")).toBe(true);
  });

  it("excludes exec (rendered by ExecToolView, always-open chrome)", () => {
    // ExecToolView ignores `open`/`onOpenChange`; including it would
    // make the window count slots that don't actually collapse.
    expect(isCollapsiblePart("tool-exec")).toBe(false);
  });

  it("excludes plain text", () => {
    expect(isCollapsiblePart("text")).toBe(false);
  });

  it("excludes unknown part types", () => {
    expect(isCollapsiblePart("source")).toBe(false);
    expect(isCollapsiblePart("")).toBe(false);
  });
});

describe("collapsibleWindow", () => {
  it("returns an empty set when there are no collapsible parts", () => {
    const open = collapsibleWindow([asst("m1", ["text", "text"])], 3);
    expect(open.size).toBe(0);
  });

  it("returns an empty set for windowSize <= 0", () => {
    const ms = [asst("m1", ["reasoning", "tool-read"])];
    expect(collapsibleWindow(ms, 0).size).toBe(0);
    expect(collapsibleWindow(ms, -1).size).toBe(0);
  });

  it("keeps every collapsible part open when count <= windowSize", () => {
    const open = collapsibleWindow([asst("m1", ["reasoning", "tool-read"])], 3);
    expect(open.size).toBe(2);
    expect(open.has(partKey("m1", 0))).toBe(true);
    expect(open.has(partKey("m1", 1))).toBe(true);
  });

  it("keeps only the last N collapsible parts when count > windowSize", () => {
    // Five collapsibles across two messages; only the last three
    // should land in the open set.
    const ms = [
      asst("m1", ["reasoning", "tool-read", "tool-grep"]),
      asst("m2", ["reasoning", "tool-find"]),
    ];
    const open = collapsibleWindow(ms, 3);
    expect(open.size).toBe(3);
    // Last three in render order: m1[2], m2[0], m2[1].
    expect(open.has(partKey("m1", 2))).toBe(true);
    expect(open.has(partKey("m2", 0))).toBe(true);
    expect(open.has(partKey("m2", 1))).toBe(true);
    // First two should be closed.
    expect(open.has(partKey("m1", 0))).toBe(false);
    expect(open.has(partKey("m1", 1))).toBe(false);
  });

  it("ignores text parts when counting the window", () => {
    // The window is a count of *collapsibles*, not parts overall.
    // Interleaved text shouldn't consume a slot.
    const ms = [
      asst("m1", ["reasoning", "text", "tool-read", "text", "reasoning"]),
    ];
    const open = collapsibleWindow(ms, 2);
    expect(open.size).toBe(2);
    expect(open.has(partKey("m1", 2))).toBe(true); // tool-read
    expect(open.has(partKey("m1", 4))).toBe(true); // last reasoning
    expect(open.has(partKey("m1", 0))).toBe(false); // older reasoning
  });

  it("ignores tool-exec when counting the window", () => {
    // ExecToolView is always-open chrome; if we counted it as a
    // collapsible, an exec-heavy turn would push every actual
    // collapsible out of the window.
    const ms = [
      asst("m1", ["tool-exec", "reasoning", "tool-exec", "tool-grep"]),
    ];
    const open = collapsibleWindow(ms, 2);
    expect(open.size).toBe(2);
    expect(open.has(partKey("m1", 1))).toBe(true); // reasoning
    expect(open.has(partKey("m1", 3))).toBe(true); // tool-grep
    // The two exec parts are present but not in the open set.
    expect(open.has(partKey("m1", 0))).toBe(false);
    expect(open.has(partKey("m1", 2))).toBe(false);
  });

  it("ignores parts of non-assistant messages", () => {
    // User messages don't render collapsible bodies; even if their
    // parts somehow had a 'reasoning' type, they wouldn't render
    // through the same component path.
    const ms: CollapsibleMessage[] = [
      user("u1", ["reasoning", "tool-read"]),
      asst("m1", ["reasoning"]),
    ];
    const open = collapsibleWindow(ms, 3);
    expect(open.size).toBe(1);
    expect(open.has(partKey("m1", 0))).toBe(true);
  });

  it("walks render order across multiple assistant messages", () => {
    // Two assistant messages each with one collapsible. With a
    // window of one, only the newer message's part should be open.
    const ms = [
      asst("m1", ["reasoning"]),
      asst("m2", ["reasoning"]),
    ];
    const open = collapsibleWindow(ms, 1);
    expect(open.size).toBe(1);
    expect(open.has(partKey("m2", 0))).toBe(true);
    expect(open.has(partKey("m1", 0))).toBe(false);
  });
});

describe("partKey", () => {
  it("composes id and index with a colon separator", () => {
    expect(partKey("abc", 3)).toBe("abc:3");
  });

  it("is stable across calls for the same inputs", () => {
    expect(partKey("m1", 0)).toBe(partKey("m1", 0));
  });
});
