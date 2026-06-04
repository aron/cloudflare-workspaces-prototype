import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import { runFixtureComparison } from "./comparison-run";

describe("runFixtureComparison", () => {
  test("records one ordered event stream for both runtime fixture setups", async () => {
    const workspaceFiles = new Map<string, string>();
    const sandboxFiles = new Map<string, string>();
    const workspaceWrites: string[] = [];
    const sandboxWrites: string[] = [];

    const events = await runFixtureComparison({
      runId: "run-abc",
      fixture: comparisonFixture,
      now: () => "2026-06-04T00:00:00.000Z",
      workspaceRuntime: {
        async mkdir() {},
        async writeFile(path, contents) {
          workspaceWrites.push(path);
          workspaceFiles.set(path, contents);
        },
      },
      sandboxRuntime: {
        async mkdir() {},
        async writeFile(path, contents) {
          sandboxWrites.push(path);
          sandboxFiles.set(path, contents);
        },
      },
      workspaceAdapterStore: {
        async readFile(path) {
          return workspaceFiles.get(path) ?? "";
        },
        async writeFile(path, contents) {
          workspaceFiles.set(path, contents);
        },
      },
      sandboxAdapterStore: {
        async readFile(path) {
          return sandboxFiles.get(path) ?? "";
        },
        async writeFile(path, contents) {
          sandboxFiles.set(path, contents);
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
    expect(events).toHaveLength(31);
    expect(events[0]).toMatchObject({
      runtime: "both",
      kind: "run_started",
      title: "Comparison run started",
    });
    expect(events.map((event) => event.title)).toEqual(
      expect.arrayContaining([
        "Workspace fixture seeded",
        "Sandbox fixture seeded",
        "read /workspace/repo/src/index.ts",
        "read complete",
      ]),
    );
    expect(events.at(-4)).toMatchObject({ runtime: "workspace", kind: "tool_call" });
    expect(events.at(-2)).toMatchObject({ runtime: "sandbox", kind: "tool_call" });
  });
});
