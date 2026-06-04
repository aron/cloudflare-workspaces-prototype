import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import { RunEventRecorder } from "../run-events";
import { runSandboxFixtureSetup } from "./sandbox-run";

describe("runSandboxFixtureSetup", () => {
  test("seeds the fixture and returns Sandbox timeline events", async () => {
    const writes: string[] = [];

    const recorder = new RunEventRecorder({
      runId: "run-abc",
      now: () => "2026-06-04T00:00:00.000Z",
    });

    const events = await runSandboxFixtureSetup({
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
      { sequence: 0, runtime: "sandbox", kind: "tool_call", title: "mkdir /workspace/repo" },
      { sequence: 1, runtime: "sandbox", kind: "tool_result", title: "mkdir complete" },
      {
        sequence: 2,
        runtime: "sandbox",
        kind: "tool_call",
        title: "write /workspace/repo/package.json",
      },
      { sequence: 3, runtime: "sandbox", kind: "tool_result", title: "write complete" },
      { sequence: 4, runtime: "sandbox", kind: "tool_call", title: "mkdir /workspace/repo/src" },
      { sequence: 5, runtime: "sandbox", kind: "tool_result", title: "mkdir complete" },
      {
        sequence: 6,
        runtime: "sandbox",
        kind: "tool_call",
        title: "write /workspace/repo/src/index.ts",
      },
      { sequence: 7, runtime: "sandbox", kind: "tool_result", title: "write complete" },
      { sequence: 8, runtime: "sandbox", kind: "tool_call", title: "mkdir /workspace/repo/src" },
      { sequence: 9, runtime: "sandbox", kind: "tool_result", title: "mkdir complete" },
      {
        sequence: 10,
        runtime: "sandbox",
        kind: "tool_call",
        title: "write /workspace/repo/src/index.test.ts",
      },
      { sequence: 11, runtime: "sandbox", kind: "tool_result", title: "write complete" },
      {
        sequence: 12,
        runtime: "sandbox",
        kind: "runtime_note",
        title: "Sandbox fixture seeded",
      },
    ]);
  });
});
