/**
 * Pure predicates that decide what the thread composer does with a
 * fresh message under each combination of `turnInFlight` and
 * connection `status`. Lifted out of `ThreadPanel.tsx` so the
 * three-state matrix can be exhaustively tested without a DOM or a
 * mocked `useAgent`.
 *
 * The actual React component holds the queue array, calls
 * `sendMessage`, and renders the placeholder — but every "what does
 * this combination mean?" decision lives here.
 *
 * Connection status mirrors the values `useAgent` surfaces to its
 * `onOpen` / `onClose` callbacks. We collapse `"connecting"` and
 * `"disconnected"` into one branch because the user experience is
 * identical: PartySocket is going to deliver the frames eventually,
 * we just don't know when.
 */

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface ComposerState {
  /** True while the agent is producing output (client- or server-side stream). */
  turnInFlight: boolean;
  /** Most-recent value emitted by `useAgent` onOpen/onClose. */
  status: ConnectionStatus;
  /** Number of messages currently buffered locally. */
  queuedCount: number;
}

/**
 * Decide whether a freshly-submitted message should be sent
 * immediately or pushed onto the local queue.
 *
 *   - Mid-turn (agent streaming): queue so it lands as the next user
 *     turn, not a mid-stream interruption.
 *   - Offline (WebSocket reconnecting): queue so the user gets
 *     visible feedback. PartySocket would buffer the frame at the
 *     wire level either way, but the queued-count badge keeps the
 *     UI honest.
 *   - Idle + connected: send straight through.
 */
export function shouldQueue(state: Pick<ComposerState, "turnInFlight" | "status">): boolean {
  return state.turnInFlight || state.status !== "connected";
}

/**
 * Decide whether the drain loop should release the next queued
 * message right now. Inverse of `shouldQueue` plus a non-empty queue.
 *
 * Returns `false` for an empty queue so the React effect that owns
 * the drain can guard with a single predicate.
 */
export function shouldDrain(state: ComposerState): boolean {
  if (state.queuedCount === 0) return false;
  return !shouldQueue(state);
}

/**
 * The placeholder text the composer shows.
 *
 * Three states, in priority order:
 *
 *   1. Disconnected — surface that messages will queue. This wins
 *      even if a turn is also in flight, because reconnection is
 *      the more user-visible problem.
 *   2. Mid-turn — invite steering.
 *   3. Idle + connected — plain reply prompt.
 */
export function composerPlaceholder(state: Pick<ComposerState, "turnInFlight" | "status">): string {
  if (state.status !== "connected") return "Reconnecting… messages will queue";
  if (state.turnInFlight) return "Steer the agent…";
  return "Reply…";
}

/**
 * The compact helper line shown next to the model name. Mirrors the
 * placeholder's priority but tracks the queued count so the user
 * can see how many messages are pending.
 *
 * Returning `null` means "fall back to the model name" — the
 * component renders that branch itself because the model label is
 * a prop, not part of composer state.
 */
export function composerHint(state: ComposerState): string | null {
  if (state.status !== "connected") {
    return state.queuedCount > 0
      ? `offline · ${state.queuedCount} queued`
      : "offline · enter to queue";
  }
  if (state.turnInFlight) {
    return state.queuedCount > 0
      ? `steering · ${state.queuedCount} queued`
      : "steering… enter to queue";
  }
  return null;
}
