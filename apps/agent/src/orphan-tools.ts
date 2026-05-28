/**
 * Resolve dangling tool calls in a UIMessage history.
 *
 * When a tool call's result never lands (exec timeout, container died
 * mid-call, DO eviction between tool-start and tool-finish), the part
 * stays in `state: "input-available"` or `"input-streaming"` (or, for
 * approval-gated tools, `"approval-requested"`). The AI SDK's
 * `convertToModelMessages` emits the assistant's tool call but no
 * matching tool-result, the provider rejects the malformed history,
 * Think persists an empty assistant message, and every following user
 * turn produces nothing. The thread is wedged.
 *
 * This helper sweeps history and rewrites those parts to
 * `state: "output-error"` with a "cancelled" error text. That makes
 * `convertToModelMessages` emit the matching tool-result row, the
 * provider accepts the prompt, and turns can flow again.
 *
 * Pure: returns a new array, leaves inputs untouched. Tested in
 * tests/orphan-tools.test.ts.
 */

/**
 * Minimal shape we operate on. Matches the AI SDK's `UIMessage` and
 * `UIMessagePart` enough for our purposes; keeps the helper testable
 * without pulling the full ai-sdk types in.
 */
export interface UIMessageLike {
  id: string;
  role: "user" | "assistant" | "system";
  parts: Array<Record<string, unknown>>;
}

export interface ResolveResult {
  /** New history (new arrays, original objects untouched). */
  messages: UIMessageLike[];
  /** True iff at least one part was rewritten. */
  changed: boolean;
  /** Tool-call ids that were patched. Useful for logging. */
  patched: string[];
}

const ORPHAN_STATES = new Set([
  "input-streaming",
  "input-available",
  "approval-requested",
]);

const CANCELLED_TEXT = "Tool call was cancelled (result never arrived).";

export function resolveOrphanToolCalls(
  history: readonly UIMessageLike[],
): ResolveResult {
  let changed = false;
  const patched: string[] = [];

  const messages = history.map((m) => {
    let messageChanged = false;
    const parts = m.parts.map((part) => {
      const type = part.type;
      if (typeof type !== "string" || !type.startsWith("tool-")) return part;
      const state = part.state;
      if (typeof state !== "string" || !ORPHAN_STATES.has(state)) return part;

      messageChanged = true;
      changed = true;
      const id = part.toolCallId;
      if (typeof id === "string") patched.push(id);
      return {
        ...part,
        state: "output-error",
        errorText: CANCELLED_TEXT,
      };
    });
    return messageChanged ? { ...m, parts } : m;
  });

  return { messages, changed, patched };
}
