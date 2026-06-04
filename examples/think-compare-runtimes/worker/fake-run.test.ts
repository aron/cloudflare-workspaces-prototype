import { describe, expect, test } from "vitest";
import { createFakeRunEvents } from "./fake-run";

describe("createFakeRunEvents", () => {
  test("creates an ordered starter timeline for both runtimes", () => {
    const events = createFakeRunEvents("run-123");

    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(events.map((event) => event.runtime)).toEqual([
      "both",
      "workspace",
      "sandbox",
      "workspace",
      "sandbox",
    ]);
    expect(events[0]).toMatchObject({
      runId: "run-123",
      runtime: "both",
      kind: "run_started",
    });
    expect(events.at(-1)).toMatchObject({
      runtime: "sandbox",
      kind: "runtime_note",
    });
  });
});
