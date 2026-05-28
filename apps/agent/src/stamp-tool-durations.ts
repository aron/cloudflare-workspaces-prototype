/**
 * Stamp tool-call wall-clock durations onto the parts of an assistant
 * message.
 *
 * Pulled out of `Agent.onChatResponse` so the logic stays unit-testable
 * without booting a full Think instance:
 *   - we iterate UIMessage parts,
 *   - leave non-tool parts untouched,
 *   - leave tool parts whose `toolCallId` isn't in the duration map
 *     untouched (a part can be missing if `afterToolCall` never fired —
 *     e.g. a client-side tool routed through `needsApproval`),
 *   - spread `callDurationMs` onto every other tool part.
 *
 * Returns `{ parts, touched }`. The `touched` flag lets the caller skip
 * the storage write + broadcast when nothing changed (the common no-tool
 * case). `parts` is always a fresh array; modified parts are also new
 * objects, so a downstream message-update path can rely on referential
 * equality to detect changes.
 */
export function stampPartDurations(
  parts: ReadonlyArray<unknown>,
  durations: ReadonlyMap<string, number>,
): { parts: unknown[]; touched: boolean } {
  let touched = false;
  const out = parts.map(p => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ap = p as any;
    if (typeof ap?.type !== "string" || !ap.type.startsWith("tool-")) return p;
    const duration = durations.get(ap.toolCallId);
    if (duration === undefined) return p;
    touched = true;
    return { ...ap, callDurationMs: duration };
  });
  return { parts: out, touched };
}
