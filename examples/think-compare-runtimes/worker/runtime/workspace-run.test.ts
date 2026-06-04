import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import { RunEventRecorder } from "../run-events";
import { runWorkspaceFixtureSetup } from "./workspace-run";

describe("runWorkspaceFixtureSetup", () => {
  test("seeds the fixture and returns Workspace timeline events", async () => {
    const writes: string[] = [];

    const recorder = new RunEventRecorder({
      runId: "run-abc",
      now: () => "2026-06-04T00:00:00.000Z",
    });

    const events = await runWorkspaceFixtureSetup({
      runId: "run-abc",
      fixture: comparisonFixture,
      recorder,
      runtime: {
        async mkdir() {},
        async writeFile(path) {
          writes.push(path);
        },
      },
    });

    expect(writes).toEqual([
      "/workspace/repo/package.json",
      "/workspace/repo/src/index.ts",
      "/workspace/repo/src/index.test.ts",
    ]);
    expect(
      events.map(({ sequence, runtime, kind, title }) => ({
        sequence,
        runtime,
        kind,
        title,
      })),
    ).toEqual([
      { sequence: 0, runtime: "workspace", kind: "tool_call", title: "mkdir /workspace/repo" },
      { sequence: 1, runtime: "workspace", kind: "tool_result", title: "mkdir complete" },
      {
        sequence: 2,
        runtime: "workspace",
        kind: "tool_call",
        title: "write /workspace/repo/package.json",
      },
      { sequence: 3, runtime: "workspace", kind: "tool_result", title: "write complete" },
      { sequence: 4, runtime: "workspace", kind: "tool_call", title: "mkdir /workspace/repo/src" },
      { sequence: 5, runtime: "workspace", kind: "tool_result", title: "mkdir complete" },
      {
        sequence: 6,
        runtime: "workspace",
        kind: "tool_call",
        title: "write /workspace/repo/src/index.ts",
      },
      { sequence: 7, runtime: "workspace", kind: "tool_result", title: "write complete" },
      { sequence: 8, runtime: "workspace", kind: "tool_call", title: "mkdir /workspace/repo/src" },
      { sequence: 9, runtime: "workspace", kind: "tool_result", title: "mkdir complete" },
      {
        sequence: 10,
        runtime: "workspace",
        kind: "tool_call",
        title: "write /workspace/repo/src/index.test.ts",
      },
      { sequence: 11, runtime: "workspace", kind: "tool_result", title: "write complete" },
      {
        sequence: 12,
        runtime: "workspace",
        kind: "runtime_note",
        title: "Workspace fixture seeded",
      },
    ]);
  });
});
