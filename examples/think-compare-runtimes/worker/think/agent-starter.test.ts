import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import { startRuntimeThinkAgents } from "./agent-starter";

describe("startRuntimeThinkAgents", () => {
  test("starts Workspace and Sandbox Think agents concurrently", async () => {
    const calls: string[] = [];

    await startRuntimeThinkAgents({
      runId: "run-abc",
      fixture: comparisonFixture,
      workspaceAgent: {
        async runComparison(input) {
          calls.push(`workspace ${input.runId} ${input.fixture.root}`);
        },
      },
      sandboxAgent: {
        async runComparison(input) {
          calls.push(`sandbox ${input.runId} ${input.fixture.root}`);
        },
      },
    });

    expect(calls.sort()).toEqual([
      "sandbox run-abc /workspace/repo",
      "workspace run-abc /workspace/repo",
    ]);
  });

  test("records agent startup failures without cancelling the other agent", async () => {
    const calls: string[] = [];
    const failures: string[] = [];

    await startRuntimeThinkAgents({
      runId: "run-abc",
      fixture: comparisonFixture,
      workspaceAgent: {
        async runComparison() {
          calls.push("workspace start");
          throw new Error("workspace failed");
        },
      },
      sandboxAgent: {
        async runComparison() {
          calls.push("sandbox complete");
        },
      },
      onAgentError(runtime, error) {
        failures.push(`${runtime} ${error instanceof Error ? error.message : String(error)}`);
      },
    });

    expect(calls.sort()).toEqual(["sandbox complete", "workspace start"]);
    expect(failures).toEqual(["workspace workspace failed"]);
  });
});
