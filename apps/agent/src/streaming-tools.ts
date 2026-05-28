/**
 * Helper used by Agent's constructor to patch Think's
 * `_wrapToolsWithDecision` so streaming tools (e.g. `exec`) pass
 * through unwrapped.
 *
 * Think's default tool wrapper:
 *   - dispatches `beforeToolCall`
 *   - awaits the original execute
 *   - if the resolved value is an AsyncIterable, drains it to its last
 *     value (so beforeToolCall semantics stay intact)
 *
 * Step 3 defeats streaming. The AI SDK has native AsyncIterable support
 * for tool execute — each yield becomes a tool-output-available chunk
 * with `preliminary: true` — but only if Think doesn't drain the
 * iterator first.
 *
 * `splitStreamingTools(streamingNames, originalWrapper)` returns a
 * replacement wrapper that:
 *   1. Splits the input ToolSet into streaming (names in the set) and
 *      wrappable (everything else).
 *   2. Calls `originalWrapper` on the wrappable subset only.
 *   3. Returns `{ ...streaming, ...wrapped }`.
 *
 * The function is generic over the ToolSet shape so it can be unit-
 * tested without pulling in the full AI-SDK types.
 */

export function splitStreamingTools<T>(
  streamingNames: ReadonlySet<string>,
  originalWrapper: (tools: Record<string, T>) => Record<string, T>,
): (tools: Record<string, T>) => Record<string, T> {
  return (tools) => {
    const streaming: Record<string, T> = {};
    const wrappable: Record<string, T> = {};
    for (const [name, tool] of Object.entries(tools)) {
      if (streamingNames.has(name)) streaming[name] = tool;
      else wrappable[name] = tool;
    }
    return { ...streaming, ...originalWrapper(wrappable) };
  };
}
