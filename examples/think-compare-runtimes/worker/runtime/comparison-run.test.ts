import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import { runFixtureComparison } from "./comparison-run";

describe("runFixtureComparison", () => {
  test("records one ordered event stream for both runtime fixture setups", async () => {
    const workspaceWrites: string[] = [];
    const sandboxWrites: string[] = [];

    const events = await runFixtureComparison({
      runId: "run-abc",
      fixture: comparisonFixture,
      now: () => "2026-06-04T00:00:00.000Z",
      workspaceRuntime: {
        async mkdir() {},
        async writeFile(path) {
          workspaceWrites.push(path);
        },
      },
      sandboxRuntime: {
        async mkdir() {},
        async writeFile(path) {
          sandboxWrites.push(path);
        },
      },
    });

    expect(workspaceWrites).toEqual([
      "/workspace/repo/package.json",
      "/workspace/repo/src/index.ts",
      "/workspace/repo/src/index.test.ts",
    ]);
    expect(sandboxWrites).toEqual(workspaceWrites);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: events.length }, (_, sequence) => sequence),
    );
    expect(events).toHaveLength(27);
    expect(events[0]).toMatchObject({
      runtime: "both",
      kind: "run_started",
      title: "Comparison run started",
    });
    expect(events.map((event) => event.title)).toEqual(
      expect.arrayContaining(["Workspace fixture seeded", "Sandbox fixture seeded"]),
    );
  });
});
