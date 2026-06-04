import type { RunEvent } from "../../shared/events";
import type { ComparisonFixture } from "../../shared/fixture";
import { RunEventRecorder } from "../run-events";
import { createSandboxRuntimeAdapter, createWorkspaceRuntimeAdapter } from "./adapter";
import type { RuntimeCommandRunner } from "./exec-tools";
import type { RuntimeFileStore } from "./file-tools";
import { runSandboxFixtureSetup } from "./sandbox-run";
import type { FixtureRuntime } from "./seed";
import { runWorkspaceFixtureSetup } from "./workspace-run";

export interface FixtureComparisonOptions {
  runId: string;
  fixture: ComparisonFixture;
  workspaceRuntime: FixtureRuntime;
  sandboxRuntime: FixtureRuntime;
  workspaceAdapterStore?: RuntimeFileStore;
  sandboxAdapterStore?: RuntimeFileStore;
  workspaceCommandRunner?: RuntimeCommandRunner;
  sandboxCommandRunner?: RuntimeCommandRunner;
  now?: () => string;
}

export async function runFixtureComparison({
  runId,
  fixture,
  workspaceRuntime,
  sandboxRuntime,
  workspaceAdapterStore,
  sandboxAdapterStore,
  workspaceCommandRunner,
  sandboxCommandRunner,
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

  if (
    workspaceAdapterStore &&
    sandboxAdapterStore &&
    workspaceCommandRunner &&
    sandboxCommandRunner
  ) {
    const sourcePath = `${fixture.root}/src/index.ts`;
    const workspaceAdapter = createWorkspaceRuntimeAdapter({
      recorder,
      store: workspaceAdapterStore,
      runner: workspaceCommandRunner,
    });
    const sandboxAdapter = createSandboxRuntimeAdapter({
      recorder,
      store: sandboxAdapterStore,
      runner: sandboxCommandRunner,
    });

    const smokeCommand = "node --version";
    await workspaceAdapter.files.read(sourcePath);
    await sandboxAdapter.files.read(sourcePath);
    await workspaceAdapter.exec(smokeCommand);
    await sandboxAdapter.exec(smokeCommand);
  }

  return recorder.events();
}
