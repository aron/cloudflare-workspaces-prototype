/**
 * Tests for the composer's queue-vs-send decision matrix.
 *
 * Three inputs collapse into the same predicate:
 *   - turnInFlight (boolean)
 *   - status: "connecting" | "connected" | "disconnected"
 *   - queuedCount (number, only relevant to the drain side)
 *
 * The product is small enough that we walk every combination
 * exhaustively. If the predicate drifts (e.g. someone tries to be
 * clever and "send immediately during reconnect because PartySocket
 * buffers anyway"), one of these cases catches it.
 */
import { describe, it, expect } from "vitest";
import {
  composerHint,
  composerPlaceholder,
  shouldDrain,
  shouldQueue,
  type ComposerState,
  type ConnectionStatus,
} from "../src/lib/compose-queue.js";

const STATUSES: ConnectionStatus[] = ["connecting", "connected", "disconnected"];

describe("shouldQueue", () => {
  it("sends straight through when idle and connected", () => {
    expect(shouldQueue({ turnInFlight: false, status: "connected" })).toBe(false);
  });

  it("queues mid-turn even when connected", () => {
    // Otherwise the message lands as a mid-stream interruption rather
    // than a clean user turn.
    expect(shouldQueue({ turnInFlight: true, status: "connected" })).toBe(true);
  });

  it.each(["connecting", "disconnected"] as const)(
    "queues whenever status === %s, regardless of turnInFlight",
    (status) => {
      expect(shouldQueue({ turnInFlight: false, status })).toBe(true);
      expect(shouldQueue({ turnInFlight: true, status })).toBe(true);
    },
  );
});

describe("shouldDrain", () => {
  it("never drains an empty queue", () => {
    for (const status of STATUSES) {
      for (const turnInFlight of [false, true]) {
        expect(shouldDrain({ turnInFlight, status, queuedCount: 0 })).toBe(false);
      }
    }
  });

  it("drains only when idle + connected + non-empty queue", () => {
    expect(shouldDrain({ turnInFlight: false, status: "connected", queuedCount: 1 })).toBe(true);
  });

  it("waits for the turn to finish before draining", () => {
    expect(shouldDrain({ turnInFlight: true, status: "connected", queuedCount: 3 })).toBe(false);
  });

  it.each(["connecting", "disconnected"] as const)(
    "waits for the connection to come back (status=%s)",
    (status) => {
      // Even with a turn settled, an offline socket has to come back
      // before we can replay; otherwise PartySocket's wire-level
      // buffer would absorb them invisibly and the queued count UI
      // would jump from N to 0 with no actual progress signal.
      expect(shouldDrain({ turnInFlight: false, status, queuedCount: 2 })).toBe(false);
    },
  );

  it("mirrors shouldQueue's inverse for non-empty queues", () => {
    // Property check: for every combination of inputs, a non-empty
    // queue drains iff shouldQueue is false. Keeps the two predicates
    // from drifting apart silently.
    for (const status of STATUSES) {
      for (const turnInFlight of [false, true]) {
        const expected = !shouldQueue({ turnInFlight, status });
        expect(
          shouldDrain({ turnInFlight, status, queuedCount: 1 }),
          `turnInFlight=${turnInFlight} status=${status}`,
        ).toBe(expected);
      }
    }
  });
});

describe("composerPlaceholder", () => {
  it.each(["connecting", "disconnected"] as const)(
    "shows the reconnect message when status=%s, even if mid-turn",
    (status) => {
      // Connection state wins over turn state in the placeholder:
      // the user needs to know first that their message will queue,
      // not that the agent is mid-thought.
      expect(composerPlaceholder({ turnInFlight: false, status })).toMatch(/Reconnecting/);
      expect(composerPlaceholder({ turnInFlight: true, status })).toMatch(/Reconnecting/);
    },
  );

  it("shows the steer prompt mid-turn when connected", () => {
    expect(composerPlaceholder({ turnInFlight: true, status: "connected" })).toBe("Steer the agent…");
  });

  it("shows the plain reply prompt when idle + connected", () => {
    expect(composerPlaceholder({ turnInFlight: false, status: "connected" })).toBe("Reply…");
  });
});

describe("composerHint", () => {
  function hint(s: Partial<ComposerState>): string | null {
    return composerHint({
      turnInFlight: false,
      status: "connected",
      queuedCount: 0,
      ...s,
    });
  }

  it("returns null when idle + connected so the model name shows through", () => {
    // The component falls back to rendering the model label on null.
    // Anything non-null would shadow the model name even when there's
    // nothing useful to say.
    expect(hint({})).toBeNull();
  });

  it.each(["connecting", "disconnected"] as const)(
    "shows the offline label when status=%s",
    (status) => {
      expect(hint({ status })).toBe("offline · enter to queue");
      expect(hint({ status, queuedCount: 3 })).toBe("offline · 3 queued");
    },
  );

  it("shows the steer label mid-turn when connected", () => {
    expect(hint({ turnInFlight: true })).toBe("steering… enter to queue");
    expect(hint({ turnInFlight: true, queuedCount: 1 })).toBe("steering · 1 queued");
  });

  it("prefers the offline label when both offline and mid-turn", () => {
    // Same priority as composerPlaceholder: connection state wins.
    // A user reconnecting cares about that more than about a turn
    // that was in progress before the socket dropped.
    expect(hint({ turnInFlight: true, status: "disconnected", queuedCount: 2 })).toBe("offline · 2 queued");
  });
});
