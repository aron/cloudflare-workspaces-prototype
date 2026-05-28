/**
 * Pure tests for resolveOrphanToolCalls — sweeps a UIMessage history and
 * patches any tool part in state "input-available" (i.e. the model asked
 * for a tool call but the result never came back) to "output-error" with
 * a "cancelled" payload. This unwedges threads where exec or similar
 * dropped its result on the floor.
 *
 * Without this fix, the AI SDK's convertToModelMessages emits the
 * assistant message's tool call but no matching tool-result row, the
 * provider rejects the malformed history, Think persists an empty
 * assistant message, and every subsequent user turn produces nothing.
 */
import { describe, it, expect } from "vitest";
import {
  resolveOrphanToolCalls,
  type UIMessageLike,
} from "../src/orphan-tools.js";

function msg(role: "user" | "assistant", parts: UIMessageLike["parts"]): UIMessageLike {
  return { id: crypto.randomUUID(), role, parts };
}

describe("resolveOrphanToolCalls", () => {
  it("returns the input unchanged when no orphans are present", () => {
    const history: UIMessageLike[] = [
      msg("user", [{ type: "text", text: "hi" }]),
      msg("assistant", [
        { type: "text", text: "ok" },
        {
          type: "tool-exec",
          toolCallId: "c1",
          toolName: "exec",
          state: "output-available",
          input: { command: "echo hi" },
          output: { stdout: "hi\n", exitCode: 0 },
        },
      ]),
    ];
    const out = resolveOrphanToolCalls(history);
    expect(out.changed).toBe(false);
    expect(out.messages).toEqual(history);
  });

  it("patches input-available tool parts to output-error: cancelled", () => {
    const history: UIMessageLike[] = [
      msg("user", [{ type: "text", text: "do it" }]),
      msg("assistant", [
        {
          type: "tool-exec",
          toolCallId: "c2",
          toolName: "exec",
          state: "input-available",
          input: { command: "npm install" },
        },
      ]),
    ];
    const out = resolveOrphanToolCalls(history);
    expect(out.changed).toBe(true);
    expect(out.messages[1].parts[0]).toMatchObject({
      type: "tool-exec",
      toolCallId: "c2",
      state: "output-error",
      errorText: expect.stringMatching(/cancel/i),
    });
  });

  it("patches input-streaming the same way as input-available", () => {
    const history: UIMessageLike[] = [
      msg("assistant", [
        {
          type: "tool-exec",
          toolCallId: "c3",
          toolName: "exec",
          state: "input-streaming",
          input: { command: "ls" },
        },
      ]),
    ];
    const out = resolveOrphanToolCalls(history);
    expect(out.changed).toBe(true);
    expect((out.messages[0].parts[0] as { state: string }).state).toBe("output-error");
  });

  it("patches approval-requested parts to output-denied: cancelled", () => {
    // An approval prompt that never got answered is also an orphan.
    const history: UIMessageLike[] = [
      msg("assistant", [
        {
          type: "tool-write",
          toolCallId: "c4",
          toolName: "write",
          state: "approval-requested",
          input: { path: "/x", text: "y" },
        },
      ]),
    ];
    const out = resolveOrphanToolCalls(history);
    expect(out.changed).toBe(true);
    expect(out.messages[0].parts[0]).toMatchObject({
      state: "output-error",
      errorText: expect.stringMatching(/cancel/i),
    });
  });

  it("leaves non-tool parts untouched", () => {
    const history: UIMessageLike[] = [
      msg("assistant", [
        { type: "text", text: "hello" },
        { type: "reasoning", text: "thinking" },
        {
          type: "tool-exec",
          toolCallId: "c5",
          toolName: "exec",
          state: "input-available",
          input: {},
        },
      ]),
    ];
    const out = resolveOrphanToolCalls(history);
    expect(out.messages[0].parts[0]).toEqual({ type: "text", text: "hello" });
    expect(out.messages[0].parts[1]).toEqual({ type: "reasoning", text: "thinking" });
  });

  it("patches multiple orphans across multiple messages", () => {
    const history: UIMessageLike[] = [
      msg("assistant", [
        { type: "tool-exec", toolCallId: "a", toolName: "exec", state: "input-available", input: {} },
        { type: "tool-read", toolCallId: "b", toolName: "read", state: "output-available", input: {}, output: "ok" },
      ]),
      msg("user", [{ type: "text", text: "hi" }]),
      msg("assistant", [
        { type: "tool-write", toolCallId: "c", toolName: "write", state: "input-streaming", input: {} },
      ]),
    ];
    const out = resolveOrphanToolCalls(history);
    expect(out.changed).toBe(true);
    expect((out.messages[0].parts[0] as { state: string }).state).toBe("output-error");
    expect((out.messages[0].parts[1] as { state: string }).state).toBe("output-available");
    expect((out.messages[2].parts[0] as { state: string }).state).toBe("output-error");
  });

  it("does not mutate the original messages or parts", () => {
    const original: UIMessageLike[] = [
      msg("assistant", [
        { type: "tool-exec", toolCallId: "x", toolName: "exec", state: "input-available", input: { cmd: "x" } },
      ]),
    ];
    const snapshot = JSON.parse(JSON.stringify(original));
    resolveOrphanToolCalls(original);
    expect(original).toEqual(snapshot);
  });
});
