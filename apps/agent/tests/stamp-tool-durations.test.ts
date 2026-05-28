/**
 * Pure-function tests for `stampPartDurations`. The agent uses this in
 * `onChatResponse` to attach wall-clock tool-call durations to the
 * persisted assistant message. Three invariants we care about:
 *
 *   1. Non-tool parts (text, reasoning, step-start) are passed through
 *      untouched and by reference \u2014 the downstream Session writer
 *      already enforces row-size limits and shouldn't have to re-walk
 *      every untouched part.
 *
 *   2. Tool parts whose `toolCallId` isn't in the duration map are also
 *      passed through untouched. Some tools have no `afterToolCall`
 *      duration available (e.g. client-side tools routed through the
 *      `needsApproval` path that the AI SDK runs out of band).
 *
 *   3. Tool parts whose `toolCallId` IS in the map get a fresh copy with
 *      `callDurationMs` spread on. All other fields are preserved \u2014 the
 *      part shape is otherwise opaque to us (it's an AI SDK UIMessage", "      part).
 *
 * The `touched` flag is the agent's signal to skip the storage write +
 * broadcast when nothing changed, so we pin its semantics here too.
 */
import { describe, it, expect } from "vitest";
import { stampPartDurations } from "../src/stamp-tool-durations.js";

describe("stampPartDurations", () => {
  it("leaves non-tool parts untouched and by reference", () => {
    const textPart = { type: "text", text: "hello" };
    const reasoningPart = { type: "reasoning", text: "thinking..." };
    const stepStart = { type: "step-start" };
    const parts = [textPart, reasoningPart, stepStart];

    const { parts: out, touched } = stampPartDurations(parts, new Map([["abc", 100]]));

    expect(touched).toBe(false);
    expect(out).toHaveLength(3);
    // Reference equality matters — downstream consumers may compare
    // parts via === to detect changes.
    expect(out[0]).toBe(textPart);
    expect(out[1]).toBe(reasoningPart);
    expect(out[2]).toBe(stepStart);
  });

  it("stamps callDurationMs onto matching tool parts", () => {
    const toolPart = {
      type: "tool-read",
      toolCallId: "call_abc",
      state: "output-available",
      input: { path: "/foo" },
      output: { content: "data" },
    };

    const { parts: out, touched } = stampPartDurations(
      [toolPart],
      new Map([["call_abc", 42]]),
    );

    expect(touched).toBe(true);
    expect(out[0]).toEqual({ ...toolPart, callDurationMs: 42 });
    // Fresh object — we don't mutate the input part in place. A mutated
    // part would surprise any caller that still holds a reference to
    // the original (e.g. via `result.message.parts`).
    expect(out[0]).not.toBe(toolPart);
  });

  it("leaves tool parts whose id isn't in the map untouched", () => {
    const toolPart = {
      type: "tool-exec",
      toolCallId: "call_xyz",
      state: "output-available",
    };

    const { parts: out, touched } = stampPartDurations(
      [toolPart],
      new Map([["call_abc", 42]]),
    );

    expect(touched).toBe(false);
    expect(out[0]).toBe(toolPart);
  });

  it("only sets touched when at least one tool part actually matches", () => {
    // Mixed message — one tool part matches, one doesn't, one text part.
    const matched = { type: "tool-grep", toolCallId: "g1", state: "output-available" };
    const unmatched = { type: "tool-find", toolCallId: "f1", state: "output-available" };
    const text = { type: "text", text: "ok" };

    const { parts: out, touched } = stampPartDurations(
      [text, matched, unmatched],
      new Map([["g1", 7]]),
    );

    expect(touched).toBe(true);
    expect(out[0]).toBe(text);
    expect(out[1]).toEqual({ ...matched, callDurationMs: 7 });
    expect(out[2]).toBe(unmatched);
  });

  it("returns an empty array for an empty parts list", () => {
    const { parts, touched } = stampPartDurations([], new Map([["x", 1]]));
    expect(parts).toEqual([]);
    expect(touched).toBe(false);
  });

  it("ignores parts whose type isn't a string", () => {
    // Defensive: a malformed part (e.g. from a future AI SDK version)
    // shouldn't crash the stamping pass.
    const weirdPart = { type: 123, toolCallId: "x" };
    const { parts, touched } = stampPartDurations(
      [weirdPart],
      new Map([["x", 1]]),
    );
    expect(touched).toBe(false);
    expect(parts[0]).toBe(weirdPart);
  });
});
