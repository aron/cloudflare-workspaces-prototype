import type { RunEvent } from "../../shared/events";
import type { ComparisonFixture } from "../../shared/fixture";
import { RunEventRecorder } from "../run-events";
import { runSandboxFixtureSetup } from "./sandbox-run";
import type { FixtureRuntime } from "./seed";
import { runWorkspaceFixtureSetup } from "./workspace-run";

export interface FixtureComparisonOptions {
  runId: string;
  fixture: ComparisonFixture;
  workspaceRuntime: FixtureRuntime;
  sandboxRuntime: FixtureRuntime;
  now?: () => string;
}

export async function runFixtureComparison({
  runId,
  fixture,
  workspaceRuntime,
  sandboxRuntime,
  now = () => new Date().toISOString(),
}: FixtureComparisonOptions): Promise<RunEvent[]> {
  const recorder = new RunEventRecorder({ runId, now });
  recorder.record({
    runtime: "both",
    kind: "run_started",
    title: "Comparison run started",
    detail: "Workspace and Sandbox agents are queued from the same fixture.",
  });

  await Promise.all([
    runWorkspaceFixtureSetup({
      runId,
      fixture,
      runtime: workspaceRuntime,
      recorder,
    }),
    runSandboxFixtureSetup({
      runId,
      fixture,
      runtime: sandboxRuntime,
      recorder,
    }),
  ]);

  return recorder.events();
}
