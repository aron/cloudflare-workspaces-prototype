import type { RunEvent } from "../../shared/events";
import type { ComparisonFixture } from "../../shared/fixture";
import { type FixtureRuntime, seedFixture } from "./seed";

export interface WorkspaceFixtureSetupOptions {
  runId: string;
  fixture: ComparisonFixture;
  runtime: FixtureRuntime;
  now?: () => string;
}

export async function runWorkspaceFixtureSetup({
  runId,
  fixture,
  runtime,
  now = () => new Date().toISOString(),
}: WorkspaceFixtureSetupOptions): Promise<RunEvent[]> {
  await seedFixture(runtime, fixture);

  return [
    {
      id: `${runId}:workspace:0`,
      runId,
      sequence: 1,
      runtime: "workspace",
      kind: "runtime_note",
      title: "Workspace fixture seeded",
      detail: `Wrote ${fixture.files.length} files through Workspace.fs at ${fixture.root} before starting a shell container.`,
      timestamp: now(),
    },
  ];
}
