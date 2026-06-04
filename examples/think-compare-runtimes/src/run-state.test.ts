import { describe, expect, test } from "vitest";
import { applyRunMessage } from "./run-state";

describe("applyRunMessage", () => {
  test("replaces history and appends live events", () => {
    const historyEvent = {
      id: "run-1:0",
      runId: "run-1",
      sequence: 0,
      runtime: "both" as const,
      kind: "run_started" as const,
      title: "Started",
      detail: "Initial history",
      timestamp: "1970-01-01T00:00:00.000Z",
    };
    const liveEvent = { ...historyEvent, id: "run-1:1", sequence: 1 };

    const withHistory = applyRunMessage([], {
      type: "history",
      events: [historyEvent],
    });
    const withLiveEvent = applyRunMessage(withHistory, {
      type: "event",
      event: liveEvent,
    });

    expect(withHistory).toEqual([historyEvent]);
    expect(withLiveEvent).toEqual([historyEvent, liveEvent]);
  });
});
